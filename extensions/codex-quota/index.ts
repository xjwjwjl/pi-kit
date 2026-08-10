import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 3 * 60 * 1000;
const STATUS_KEY = "codex-quota";
const DAY_SECONDS = 24 * 60 * 60;
const MAX_CACHED_CREDENTIALS = 8;

type StatusColor = "success" | "warning" | "error" | "muted";
type Paint = (color: StatusColor, text: string) => string;
type CodexCredential = { access: string; expires?: number };
type UsageWindow = { used_percent?: number; limit_window_seconds?: number };
type UsageResponse = {
  rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null };
};
type UsageResult = { usage: UsageResponse | null; expired?: boolean; error?: boolean };
type CacheEntry = { result: UsageResult; fetchedAt: number };

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

function isShortWindow(window: UsageWindow | null | undefined): window is UsageWindow {
  return Boolean(window) && (window.limit_window_seconds ?? 0) < DAY_SECONDS;
}

function isLongWindow(window: UsageWindow | null | undefined): window is UsageWindow {
  return Boolean(window) && (window.limit_window_seconds ?? 0) >= DAY_SECONDS;
}

function selectQuotaWindow(usage: UsageResponse | null): UsageWindow | undefined {
  const primary = usage?.rate_limit?.primary_window;
  const secondary = usage?.rate_limit?.secondary_window;
  const shortWindow = isShortWindow(primary) ? primary : isShortWindow(secondary) ? secondary : undefined;
  const longWindow = isLongWindow(primary) ? primary : isLongWindow(secondary) ? secondary : undefined;
  return hasUsagePercent(shortWindow) ? shortWindow : longWindow;
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

  const percent = Math.round(window.used_percent);
  const color: StatusColor = percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
  return `${paint("muted", `Codex·${describeWindowLimit(window)}`)} ${paint(color, `${percent}%`)}`;
}

function cacheUsage(cache: Map<string, CacheEntry>, accessToken: string, result: UsageResult) {
  cache.delete(accessToken);
  cache.set(accessToken, { result, fetchedAt: Date.now() });

  while (cache.size > MAX_CACHED_CREDENTIALS) {
    const oldestAccessToken = cache.keys().next().value;
    if (oldestAccessToken === undefined) return;
    cache.delete(oldestAccessToken);
  }
}

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<UsageResult>>();
  let currentCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
    const credential = getCredential();
    if (!credential) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const paint: Paint = (color, text) => ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
    const cached = cache.get(credential.access);
    if (!force && cached && Date.now() - cached.fetchedAt < REFRESH_MS) {
      ctx.ui.setStatus(STATUS_KEY, formatQuotaStatus(cached.result, paint));
      return;
    }

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
      cacheUsage(cache, credential.access, result);
      if (!stopped && getCredential()?.access === credential.access) {
        ctx.ui.setStatus(STATUS_KEY, formatQuotaStatus(result, paint));
      }
    } finally {
      if (pending.get(credential.access) === request) pending.delete(credential.access);
    }
  };

  const stopRefreshTimer = () => {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const startRefreshTimer = (ctx: ExtensionContext) => {
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      if (ctx.isIdle()) void refresh(ctx, true);
    }, REFRESH_MS);
    refreshTimer.unref?.();
  };

  pi.events.on("openai-codex:credential-changed", () => {
    if (currentCtx) void refresh(currentCtx, true);
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    stopped = false;
    startRefreshTimer(ctx);
    void refresh(ctx, true);
  });
  pi.on("turn_start", (_event, ctx) => { void refresh(ctx); });
  pi.on("before_provider_request", (_event, ctx) => { void refresh(ctx); });
  pi.on("turn_end", (_event, ctx) => { void refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    currentCtx = undefined;
    stopRefreshTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
