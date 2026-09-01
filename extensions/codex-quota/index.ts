import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { withDirectoryLock } from "./src/file-lock.ts";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60 * 1000;
const STATUS_KEY = "codex-quota";
const DAY_SECONDS = 24 * 60 * 60;
const MAX_CACHED_CREDENTIALS = 8;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "codex-quota-cache.json");
const CACHE_SNAPSHOT_PREFIX = `${CACHE_FILE}.snapshot.`;
const CACHE_SNAPSHOT_NAME_PREFIX = `${basename(CACHE_FILE)}.snapshot.`;
const REFRESH_LOCK = `${CACHE_FILE}.refresh.lock`;
export const RETRY_MAX_ATTEMPTS = 4; // 初始失败后最多再退避重试 3 次
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

type StatusColor = "success" | "warning" | "error" | "muted";
type Paint = (color: StatusColor, text: string) => string;
type CodexCredential = { access: string; expires?: number };
type UsageWindow = { used_percent?: number; limit_window_seconds?: number };
type UsageResponse = {
  rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null };
};
type UsageResult = {
  usage: UsageResponse | null;
  expired?: boolean;
  error?: boolean;
  cancelled?: boolean;
};
type CacheEntry = {
  result: UsageResult;
  lastSuccessAt?: number;
  lastAttemptAt: number;
  stale: boolean;
  retryCount?: number;
  nextRetryAt?: number;
};
type PersistentCache = Record<string, CacheEntry>;
type RawCacheEntry = {
  result?: unknown;
  fetchedAt?: unknown;
  lastSuccessAt?: unknown;
  lastAttemptAt?: unknown;
  stale?: unknown;
  retryCount?: unknown;
  nextRetryAt?: unknown;
};

function credentialCacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCacheEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== "object") return undefined;

  const raw = value as RawCacheEntry;
  if (!raw.result || typeof raw.result !== "object") return undefined;

  // `fetchedAt` is the old name and represented the last successful fetch.
  const legacyFetchedAt = finiteNumber(raw.fetchedAt);
  const lastSuccessAt = finiteNumber(raw.lastSuccessAt) ?? legacyFetchedAt;
  const lastAttemptAt = finiteNumber(raw.lastAttemptAt) ?? lastSuccessAt;
  if (lastAttemptAt === undefined) return undefined;

  const result = raw.result as UsageResult;
  return {
    result,
    lastSuccessAt,
    lastAttemptAt,
    stale: raw.stale === true || result.error === true,
    retryCount: finiteNumber(raw.retryCount),
    nextRetryAt: finiteNumber(raw.nextRetryAt),
  };
}

function listCacheSnapshotFiles(): string[] {
  try {
    const directory = dirname(CACHE_FILE);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && entry.name.startsWith(CACHE_SNAPSHOT_NAME_PREFIX)
        && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

function mergePersistentCache(
  cache: PersistentCache,
  value: unknown,
  cutoff: number,
) {
  if (!value || typeof value !== "object") return;

  for (const [key, rawEntry] of Object.entries(value)) {
    const entry = normalizeCacheEntry(rawEntry);
    if (entry && entry.lastAttemptAt >= cutoff
      && (!cache[key] || cache[key].lastAttemptAt <= entry.lastAttemptAt)) {
      cache[key] = entry;
    }
  }
}

function loadPersistentCache(): PersistentCache {
  const cutoff = Date.now() - MAX_PERSISTED_AGE_MS;
  const cache: PersistentCache = {};
  for (const file of [CACHE_FILE, ...listCacheSnapshotFiles()]) {
    try {
      mergePersistentCache(cache, JSON.parse(readFileSync(file, "utf-8")), cutoff);
    } catch {
      // Ignore missing or partially written cache candidates.
    }
  }
  return cache;
}

function pruneCacheSnapshots(keepFile: string) {
  for (const file of listCacheSnapshotFiles()) {
    if (file === keepFile) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      // Stale snapshots are harmless if cleanup fails.
    }
  }
}

function savePersistentCache(accessToken: string, entry: CacheEntry) {
  const key = credentialCacheKey(accessToken);
  let tempFile: string | undefined;

  // All callers are inside withDirectoryLock(REFRESH_LOCK, ...), so the refresh
  // lock also serializes cache writes across Pi instances.
  try {
    const cache = loadPersistentCache();
    cache[key] = entry;
    const serialized = JSON.stringify(Object.fromEntries(
      Object.entries(cache)
        .sort(([, a], [, b]) => b.lastAttemptAt - a.lastAttemptAt)
        .slice(0, MAX_CACHED_CREDENTIALS),
    ));
    const suffix = `${Date.now()}.${process.pid}.${randomUUID()}`;
    tempFile = `${CACHE_FILE}.${suffix}.tmp`;
    const snapshotFile = `${CACHE_SNAPSHOT_PREFIX}${suffix}.json`;
    writeFileSync(tempFile, serialized, "utf-8");
    // The destination does not exist, so rename is atomic on Windows and POSIX.
    renameSync(tempFile, snapshotFile);
    tempFile = undefined;
    pruneCacheSnapshots(snapshotFile);

    // Keep the documented main file human-readable. The snapshot remains the
    // canonical copy if this mirror is interrupted or fails.
    try {
      writeFileSync(CACHE_FILE, serialized, "utf-8");
    } catch {
      // A valid snapshot has already been committed.
    }
  } catch {
    // Disk caching is best effort; quota display must continue working without it.
  } finally {
    if (tempFile) {
      try {
        rmSync(tempFile, { force: true });
      } catch {
        // Failed temporary files are harmless if cleanup also fails.
      }
    }
  }
}

function getCredential(): CodexCredential | null {
  try {
    const stored = readStoredCredential("openai-codex");
    if (!stored || stored.type !== "oauth" || typeof stored.access !== "string" || !stored.access) return null;
    return {
      access: stored.access,
      expires: typeof stored.expires === "number" ? stored.expires : undefined,
    };
  } catch {
    return null;
  }
}

function createAbortError(): Error {
  const error = new Error("curl request cancelled");
  error.name = "AbortError";
  return error;
}

function curlGet(url: string, accessToken: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-sS", "--fail-with-body", "--http1.1", "-K", "-"], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // The process may have already exited.
      }
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    };
    const onAbort = () => {
      rejectOnce(createAbortError());
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", rejectOnce);
    child.stdout.on("error", rejectOnce);
    child.stderr.on("error", rejectOnce);
    child.on("error", rejectOnce);
    child.on("close", (code) => {
      if (signal?.aborted) {
        rejectOnce(createAbortError());
      } else if (code === 0) {
        finish(() => resolve(stdout));
      } else {
        rejectOnce(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`));
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });

    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      child.stdin.end([
        `url = "${escape(url)}"`,
        'request = "GET"',
        `header = "Authorization: Bearer ${escape(accessToken)}"`,
        'header = "Accept: application/json"',
        "connect-timeout = 10",
        "max-time = 20",
        "",
      ].join("\n"));
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function getUsage(credential: CodexCredential, signal?: AbortSignal): Promise<UsageResult> {
  if (signal?.aborted) return { usage: null, cancelled: true };
  if (typeof credential.expires === "number" && Date.now() >= credential.expires) {
    return { usage: null, expired: true };
  }

  try {
    const response = await curlGet(USAGE_API, credential.access, signal);
    if (signal?.aborted) return { usage: null, cancelled: true };
    return { usage: JSON.parse(response) as UsageResponse };
  } catch {
    return signal?.aborted ? { usage: null, cancelled: true } : { usage: null, error: true };
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

function safePaint(ctx: ExtensionContext): Paint {
  return (color, text) => {
    try {
      return ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
    } catch {
      return text;
    }
  };
}

function safeSetStatus(ctx: ExtensionContext, status: string | undefined) {
  try {
    ctx.ui.setStatus(STATUS_KEY, status);
  } catch {
    // Status display is best effort and must not affect the host process.
  }
}

export function formatQuotaStatus(result: UsageResult, paint: Paint): string {
  if (result.expired) return paint("muted", "Codex·") + paint("error", "token expired");
  if (result.error || !result.usage) return unavailableStatus(paint);

  const window = selectQuotaWindow(result.usage);
  if (!hasUsagePercent(window)) return unavailableStatus(paint);

  const percent = Math.max(0, Math.min(100, Math.round(100 - window.used_percent)));
  const color: StatusColor = percent < 10 ? "error" : percent <= 50 ? "warning" : "success";
  return `${paint("muted", `Codex·${describeWindowLimit(window)}`)} ${paint(color, `${percent}%`)}`;
}

function hasSuccessfulUsage(result: UsageResult): boolean {
  return !result.error
    && !result.expired
    && Boolean(result.usage && hasUsagePercent(selectQuotaWindow(result.usage)));
}

export function createCacheEntry(
  previous: CacheEntry | undefined,
  result: UsageResult,
  now: number,
): CacheEntry {
  const successful = hasSuccessfulUsage(result);
  const failed = !result.expired && !result.cancelled && !successful;
  const cachedResult = failed
    ? { usage: previous?.result.usage ?? null, error: true }
    : result;

  // 同一刷新窗口内延续失败退避计数；跨窗口后重置，让每个 5 分钟边界都有完整重试预算。
  const sameStreak = previous !== undefined && previous.lastAttemptAt >= windowBoundary(now);
  const priorRetryCount = sameStreak ? (previous.retryCount ?? 0) : 0;
  const retryCount = failed ? priorRetryCount + 1 : 0;
  const nextRetryAt = failed && retryCount < RETRY_MAX_ATTEMPTS
    ? now + retryBackoffDelayMs(retryCount)
    : undefined;

  return {
    result: cachedResult,
    lastSuccessAt: successful ? now : previous?.lastSuccessAt,
    lastAttemptAt: now,
    stale: failed,
    retryCount,
    nextRetryAt,
  };
}

function windowBoundary(now: number): number {
  return Math.floor(now / REFRESH_MS) * REFRESH_MS;
}

function retryBackoffDelayMs(retryCount: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1), RETRY_MAX_DELAY_MS);
}

export function isRetryDue(entry: CacheEntry | undefined, now: number): boolean {
  const retryCount = entry?.retryCount ?? 0;
  const nextRetryAt = entry?.nextRetryAt;
  return retryCount > 0
    && retryCount < RETRY_MAX_ATTEMPTS
    && nextRetryAt !== undefined
    && now >= nextRetryAt;
}

export function isFreshCacheEntry(
  entry: CacheEntry | undefined,
  refreshBoundary: number,
): boolean {
  return Boolean(
    entry
      && !entry.stale
      && entry.lastSuccessAt !== undefined
      && entry.lastSuccessAt >= refreshBoundary,
  );
}

export function hasAttemptedInRefreshWindow(
  entry: CacheEntry | undefined,
  refreshBoundary: number,
): boolean {
  return Boolean(entry && entry.lastAttemptAt >= refreshBoundary);
}

function rememberCacheEntry(
  cache: Map<string, CacheEntry>,
  persistentCache: PersistentCache,
  accessToken: string,
  entry: CacheEntry,
): void {
  cache.delete(accessToken);
  cache.set(accessToken, entry);
  persistentCache[credentialCacheKey(accessToken)] = entry;
  savePersistentCache(accessToken, entry);

  while (cache.size > MAX_CACHED_CREDENTIALS) {
    const oldestAccessToken = cache.keys().next().value;
    if (oldestAccessToken === undefined) break;
    cache.delete(oldestAccessToken);
  }
}

function cacheUsage(
  cache: Map<string, CacheEntry>,
  persistentCache: PersistentCache,
  accessToken: string,
  result: UsageResult,
): UsageResult {
  const previous = cache.get(accessToken);
  if (result.cancelled) return previous?.result ?? result;
  const entry = createCacheEntry(previous, result, Date.now());

  // Persist every attempt so other instances can suppress duplicate requests
  // in the same refresh window, even when there is no previous success.
  rememberCacheEntry(cache, persistentCache, accessToken, entry);
  return entry.result;
}

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, CacheEntry>();
  const persistentCache = loadPersistentCache();
  let currentCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshController = new AbortController();
  let stopped = false;

  const getCachedEntry = (accessToken: string, reload = false): CacheEntry | undefined => {
    const cached = cache.get(accessToken);
    const key = credentialCacheKey(accessToken);
    const persisted = reload ? loadPersistentCache()[key] : persistentCache[key];

    if (persisted && (!cached || persisted.lastAttemptAt > cached.lastAttemptAt)) {
      persistentCache[key] = persisted;
      cache.set(accessToken, persisted);
      return persisted;
    }
    return cached ?? persisted;
  };

  const showCachedStatus = (ctx: ExtensionContext, reload = false) => {
    const paint = safePaint(ctx);
    try {
      const credential = getCredential();
      if (!credential) {
        safeSetStatus(ctx, undefined);
        return;
      }

      const cached = getCachedEntry(credential.access, reload);
      if (!cached) {
        safeSetStatus(ctx, undefined);
        return;
      }

      safeSetStatus(ctx, formatQuotaStatus(cached.result, paint));
    } catch {
      safeSetStatus(ctx, unavailableStatus(paint));
    }
  };

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    const paint = safePaint(ctx);
    const signal = refreshController.signal;
    let credential: CodexCredential | null = null;

    try {
      credential = getCredential();
      if (!credential) {
        safeSetStatus(ctx, undefined);
        return;
      }
      const activeCredential = credential;

      safeSetStatus(ctx, paint("muted", "Codex·refreshing"));

      const displayResult = await withDirectoryLock(REFRESH_LOCK, async () => {
        if (signal.aborted) return { usage: null, cancelled: true };

        // 加锁后再计算窗口边界：锁最长等待 65s，等待期间跨窗口时旧边界会误判新鲜度。
        const refreshBoundary = Math.floor(Date.now() / REFRESH_MS) * REFRESH_MS;
        const latest = getCachedEntry(activeCredential.access, true);
        // 进入新窗口时上一窗口遗留的重试定时器已作废，先取消避免与本次刷新在相邻时刻重复触发。
        if (latest && latest.lastAttemptAt < refreshBoundary) {
          stopRetryTimer();
        }
        if (latest && isFreshCacheEntry(latest, refreshBoundary)) return latest.result;
        if (latest
          && hasAttemptedInRefreshWindow(latest, refreshBoundary)
          && !isRetryDue(latest, Date.now())) {
          return latest.result;
        }

        const result = await getUsage(activeCredential, signal);
        if (signal.aborted || result.cancelled) return { usage: null, cancelled: true };
        return cacheUsage(cache, persistentCache, activeCredential.access, result);
      }, signal);

      if (signal.aborted || displayResult?.cancelled) return;

      // 用内存中的最新条目调度退避，避免成功路径重复全量读盘。
      const entry = cache.get(activeCredential.access);
      const fallback = displayResult ?? getCachedEntry(activeCredential.access, true)?.result;
      if (!stopped && getCredential()?.access === activeCredential.access) {
        safeSetStatus(
          ctx,
          fallback ? formatQuotaStatus(fallback, paint) : unavailableStatus(paint),
        );
        scheduleRetryTimer(ctx, entry);
      }
    } catch {
      if (signal.aborted) return;
      if (!stopped && (!credential || getCredential()?.access === credential.access)) {
        safeSetStatus(ctx, unavailableStatus(paint));
        scheduleRetryTimer(ctx);
      }
    }
  };

  const runRefresh = (ctx: ExtensionContext) => {
    void refresh(ctx).catch(() => {
      safeSetStatus(ctx, unavailableStatus(safePaint(ctx)));
    });
  };

  const stopRefreshTimer = () => {
    const timer = refreshTimer;
    refreshTimer = undefined;
    if (!timer) return;
    try {
      clearTimeout(timer);
    } catch {
      // Timer cleanup is best effort.
    }
  };

  const startRefreshTimer = (ctx: ExtensionContext) => {
    stopRefreshTimer();

    try {
      const now = Date.now();
      const nextBoundary = (Math.floor(now / REFRESH_MS) + 1) * REFRESH_MS;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (stopped || currentCtx !== ctx) return;
        runRefresh(ctx);
        startRefreshTimer(ctx);
      }, Math.max(1, nextBoundary - now));
      refreshTimer.unref?.();
    } catch {
      refreshTimer = undefined;
    }
  };

  const stopRetryTimer = () => {
    const timer = retryTimer;
    retryTimer = undefined;
    if (!timer) return;
    try {
      clearTimeout(timer);
    } catch {
      // Retry timer cleanup is best effort.
    }
  };

  const scheduleRetryTimer = (ctx: ExtensionContext, entry?: CacheEntry) => {
    stopRetryTimer();
    if (stopped || currentCtx !== ctx) return;

    // 未传入条目时（会话启动/异常路径）从磁盘读取，以跨实例恢复退避状态。
    if (!entry) {
      const credential = getCredential();
      if (!credential) return;
      entry = getCachedEntry(credential.access, true);
    }

    const retryCount = entry?.retryCount ?? 0;
    const nextRetryAt = entry?.nextRetryAt;
    if (retryCount <= 0 || retryCount >= RETRY_MAX_ATTEMPTS || nextRetryAt === undefined) return;

    const delay = Math.max(1, nextRetryAt - Date.now());
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (stopped || currentCtx !== ctx) return;
      runRefresh(ctx);
    }, delay);
    retryTimer.unref?.();
  };

  pi.events.on("openai-codex:credential-changed", () => {
    if (!currentCtx) return;
    // 先展示旧缓存，再立即刷新，避免新凭据的状态栏空白等待下一个 5 分钟边界。
    showCachedStatus(currentCtx, true);
    runRefresh(currentCtx);
  });

  pi.on("session_start", (_event, ctx) => {
    refreshController.abort();
    refreshController = new AbortController();
    currentCtx = ctx;
    stopped = false;
    startRefreshTimer(ctx);
    showCachedStatus(ctx, true);
    runRefresh(ctx);
    scheduleRetryTimer(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    refreshController.abort();
    currentCtx = undefined;
    stopRefreshTimer();
    stopRetryTimer();
    safeSetStatus(ctx, undefined);
  });
}
