import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60 * 1000;
const STATUS_KEY = "codex-quota";
const DAY_SECONDS = 24 * 60 * 60;
const MAX_CACHED_CREDENTIALS = 8;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "codex-quota-cache.json");
const CACHE_LOCK = `${CACHE_FILE}.lock`;

type StatusColor = "success" | "warning" | "error" | "muted";
type Paint = (color: StatusColor, text: string) => string;
type CodexCredential = { access: string; expires?: number };
type UsageWindow = { used_percent?: number; limit_window_seconds?: number };
type UsageResponse = {
  rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null };
};
type UsageResult = { usage: UsageResponse | null; expired?: boolean; error?: boolean };
type CacheEntry = { result: UsageResult; fetchedAt: number };
type PersistentCache = Record<string, CacheEntry>;

function credentialCacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function loadPersistentCache(): PersistentCache {
  try {
    const value = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as PersistentCache;
    if (!value || typeof value !== "object") return {};

    const cutoff = Date.now() - MAX_PERSISTED_AGE_MS;
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) =>
        entry && typeof entry.fetchedAt === "number" && entry.fetchedAt >= cutoff,
      ),
    );
  } catch {
    return {};
  }
}

function savePersistentCache(accessToken: string, entry: CacheEntry) {
  const key = credentialCacheKey(accessToken);
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let locked = false;

  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        mkdirSync(CACHE_LOCK);
        locked = true;
        break;
      } catch {
        try {
          if (Date.now() - statSync(CACHE_LOCK).mtimeMs > 5_000) {
            rmSync(CACHE_LOCK, { recursive: true, force: true });
            continue;
          }
        } catch {
          // The lock may have been released between mkdir and stat.
        }
        Atomics.wait(waitBuffer, 0, 0, 25);
      }
    }
    if (!locked) return;

    // Reload under the lock so concurrent instances do not overwrite newer entries.
    const cache = loadPersistentCache();
    cache[key] = entry;
    const compactCache = Object.fromEntries(
      Object.entries(cache)
        .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
        .slice(0, MAX_CACHED_CREDENTIALS),
    );
    const tempFile = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempFile, JSON.stringify(compactCache), "utf-8");
    try {
      renameSync(tempFile, CACHE_FILE);
    } catch {
      // Windows may reject rename-over-existing; the lock keeps this replacement safe.
      rmSync(CACHE_FILE, { force: true });
      renameSync(tempFile, CACHE_FILE);
    }
  } catch {
    // Disk caching is best effort; quota display must continue working without it.
  } finally {
    if (locked) rmSync(CACHE_LOCK, { recursive: true, force: true });
  }
}

function getCredential(): CodexCredential | null {
  const stored = readStoredCredential("openai-codex");
  if (!stored || stored.type !== "oauth") return null;
  return { access: stored.access, expires: stored.expires };
}

function curlGet(url: string, accessToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-sS", "--fail-with-body", "--http1.1", "-K", "-"], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`)));

    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    child.stdin.end([
      `url = "${escape(url)}"`,
      'request = "GET"',
      `header = "Authorization: Bearer ${escape(accessToken)}"`,
      'header = "Accept: application/json"',
      "connect-timeout = 10",
      "max-time = 20",
      "",
    ].join("\n"));
  });
}

async function getUsage(credential: CodexCredential): Promise<UsageResult> {
  if (typeof credential.expires === "number" && Date.now() >= credential.expires) {
    return { usage: null, expired: true };
  }

  try {
    const usage = JSON.parse(await curlGet(USAGE_API, credential.access)) as UsageResponse;
    return { usage };
  } catch {
    return { usage: null, error: true };
  }
}

function hasUsagePercent(window: UsageWindow | null | undefined): window is UsageWindow & { used_percent: number } {
  return typeof window?.used_percent === "number";
}

function selectQuotaWindow(usage: UsageResponse | null): UsageWindow | undefined {
  const windows = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]
    .filter((window): window is UsageWindow => Boolean(window))
    .filter(hasUsagePercent);
  const shortWindows = windows
    .filter((window) => (window.limit_window_seconds ?? 0) > 0 && window.limit_window_seconds! < DAY_SECONDS)
    .sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!);
  const longWindows = windows
    .filter((window) => (window.limit_window_seconds ?? 0) >= DAY_SECONDS)
    .sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!);
  return shortWindows[0] ?? longWindows[0];
}

function describeWindowLimit(window: UsageWindow): string {
  const seconds = window.limit_window_seconds;
  if (!seconds) return "window";
  if (seconds >= DAY_SECONDS) return `${Math.round(seconds / DAY_SECONDS)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function unavailableStatus(paint: Paint): string {
  return paint("muted", "Codex·") + paint("warning", "quota unavailable");
}

export function formatQuotaStatus(result: UsageResult, paint: Paint): string {
  if (result.expired) return paint("muted", "Codex·") + paint("error", "token expired");
  if (result.error || !result.usage) return unavailableStatus(paint);

  const window = selectQuotaWindow(result.usage);
  if (!hasUsagePercent(window)) return unavailableStatus(paint);

  const percent = Math.max(0, Math.min(100, Math.round(100 - window.used_percent)));
  const color: StatusColor = percent <= 10 ? "error" : percent <= 30 ? "warning" : "success";
  return `${paint("muted", `Codex·${describeWindowLimit(window)}`)} ${paint(color, `${percent}%`)}`;
}

function cacheUsage(
  cache: Map<string, CacheEntry>,
  persistentCache: PersistentCache,
  accessToken: string,
  result: UsageResult,
): UsageResult {
  const previous = cache.get(accessToken)?.result;
  const cachedResult = result.error && previous?.usage ? previous : result;
  const entry = { result: cachedResult, fetchedAt: Date.now() };

  cache.delete(accessToken);
  cache.set(accessToken, entry);

  if (cachedResult.usage && !cachedResult.error && hasUsagePercent(selectQuotaWindow(cachedResult.usage))) {
    persistentCache[credentialCacheKey(accessToken)] = entry;
    savePersistentCache(accessToken, entry);
  }

  while (cache.size > MAX_CACHED_CREDENTIALS) {
    const oldestAccessToken = cache.keys().next().value;
    if (oldestAccessToken === undefined) break;
    cache.delete(oldestAccessToken);
  }

  return cachedResult;
}

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, CacheEntry>();
  const persistentCache = loadPersistentCache();
  const pending = new Map<string, Promise<UsageResult>>();
  let currentCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const getCachedEntry = (accessToken: string): CacheEntry | undefined => {
    const cached = cache.get(accessToken);
    if (cached) return cached;

    const persisted = persistentCache[credentialCacheKey(accessToken)];
    if (persisted) cache.set(accessToken, persisted);
    return persisted;
  };

  const showCachedStatus = (ctx: ExtensionContext) => {
    const credential = getCredential();
    if (!credential) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const cached = getCachedEntry(credential.access);
    if (!cached) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const paint: Paint = (color, text) => ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
    ctx.ui.setStatus(STATUS_KEY, formatQuotaStatus(cached.result, paint));
  };

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    const credential = getCredential();
    if (!credential) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const paint: Paint = (color, text) => ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
    const activeRequest = pending.get(credential.access);
    if (activeRequest) {
      await activeRequest;
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, paint("muted", "Codex·refreshing"));
    const request = getUsage(credential);
    pending.set(credential.access, request);

    try {
      const result = await request;
      const displayResult = cacheUsage(cache, persistentCache, credential.access, result);
      if (!stopped && getCredential()?.access === credential.access) {
        ctx.ui.setStatus(STATUS_KEY, formatQuotaStatus(displayResult, paint));
      }
    } finally {
      if (pending.get(credential.access) === request) pending.delete(credential.access);
    }
  };

  const stopRefreshTimer = () => {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const startRefreshTimer = (ctx: ExtensionContext) => {
    stopRefreshTimer();

    const now = Date.now();
    const nextBoundary = (Math.floor(now / REFRESH_MS) + 1) * REFRESH_MS;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (stopped || currentCtx !== ctx) return;
      if (ctx.isIdle()) void refresh(ctx);
      startRefreshTimer(ctx);
    }, Math.max(1, nextBoundary - now));
    refreshTimer.unref?.();
  };

  pi.events.on("openai-codex:credential-changed", () => {
    if (currentCtx) showCachedStatus(currentCtx);
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    stopped = false;
    startRefreshTimer(ctx);
    showCachedStatus(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    currentCtx = undefined;
    stopRefreshTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
