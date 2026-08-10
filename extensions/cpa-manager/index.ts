/**
 * CPA Account Manager — manage multiple ChatGPT/Codex accounts for pi.
 *
 * Commands:
 *   /cpa:list — TUI account dashboard and switcher
 *   /cpa:usage — show per-model session stats
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  SelectList,
  SettingsList,
  Text,
  matchesKey,
  truncateToWidth,
  type SettingItem,
} from "@earendil-works/pi-tui";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AGENT_DIR = join(homedir(), ".pi", "agent");
const AUTH_JSON = join(AGENT_DIR, "auth.json");
const CPA_DIR = join(AGENT_DIR, "cpa-accounts");
const CURRENT_FILE = join(CPA_DIR, ".current");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Account files
// ---------------------------------------------------------------------------

interface CpaJson {
  type?: string;
  access_token: string;
  refresh_token: string;
  expired?: string;
  account_id?: string;
  chatgpt_account_id?: string;
  email?: string;
  name?: string;
  plan_type?: string;
  chatgpt_plan_type?: string;
  [key: string]: unknown;
}

interface PiCredential extends Record<string, unknown> {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  _meta?: {
    email?: string;
    name?: string;
    plan_type?: string;
    source_file?: string;
    converted_at?: string;
  };
}

interface AccountFile {
  "openai-codex": PiCredential;
}

interface AccountRecord {
  name: string;
  cred: PiCredential;
  isActive: boolean;
}

interface ReadAccountResult {
  account: AccountFile | null;
  converted: boolean;
  error?: string;
}

function isCpaFormat(raw: unknown): raw is CpaJson {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.access_token === "string" &&
    obj.access_token.length > 0 &&
    typeof obj.refresh_token === "string" &&
    obj.refresh_token.length > 0
  );
}

function isPiCredential(raw: unknown): raw is PiCredential {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return obj.type === "oauth" && typeof obj.access === "string";
}

function isAccountFile(raw: unknown): raw is AccountFile {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return obj["openai-codex"] !== undefined && isPiCredential(obj["openai-codex"]);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

function cpaToPi(cpa: CpaJson, sourceFile?: string): PiCredential {
  const parsedExpiry = cpa.expired ? Date.parse(cpa.expired) : NaN;
  const jwtExpiry = decodeJwtPayload(cpa.access_token)?.exp;
  const jwtExpiryMs = typeof jwtExpiry === "number" ? jwtExpiry * 1000 : NaN;
  const expiresMs = Number.isFinite(parsedExpiry)
    ? parsedExpiry
    : Number.isFinite(jwtExpiryMs)
      ? jwtExpiryMs
      : Date.now() + 30 * 24 * 60 * 60 * 1000;

  const jwtPayload = decodeJwtPayload(cpa.access_token);
  const jwtAccountId = jwtPayload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;

  return {
    type: "oauth",
    access: cpa.access_token,
    refresh: cpa.refresh_token,
    expires: expiresMs,
    accountId: cpa.chatgpt_account_id || cpa.account_id || jwtAccountId?.user_id as string || "",
    _meta: {
      email: cpa.email,
      name: cpa.name,
      plan_type: cpa.chatgpt_plan_type || cpa.plan_type,
      source_file: sourceFile,
      converted_at: new Date().toISOString(),
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function isAccountName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && basename(name) === name && !name.includes("\0");
}

function listAccountFiles(): string[] {
  ensureDir(CPA_DIR);
  return readdirSync(CPA_DIR)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .filter((file) => isAccountName(file.replace(/\.json$/i, "")))
    .sort((a, b) => a.localeCompare(b));
}

function accountPath(name: string): string {
  if (!isAccountName(name)) throw new Error("Invalid account name");
  return join(CPA_DIR, `${name}.json`);
}

function readAccountWithInfo(filePath: string): ReadAccountResult {
  if (!existsSync(filePath)) return { account: null, converted: false, error: "file not found" };

  try {
    const raw = readJson(filePath);
    if (isAccountFile(raw)) return { account: raw, converted: false };

    if (isCpaFormat(raw)) {
      const account: AccountFile = { "openai-codex": cpaToPi(raw, basename(filePath)) };
      writeJson(filePath, account);
      return { account, converted: true };
    }

    return { account: null, converted: false, error: "unsupported JSON format" };
  } catch (error) {
    return {
      account: null,
      converted: false,
      error: error instanceof Error ? error.message : "invalid JSON",
    };
  }
}

function readAccount(name: string): AccountFile | null {
  return isAccountName(name) ? readAccountWithInfo(accountPath(name)).account : null;
}

function collectAccounts(): {
  accounts: AccountRecord[];
  convertedCount: number;
  invalid: Array<{ name: string; reason: string }>;
} {
  const currentName = getCurrentName();
  const accounts: AccountRecord[] = [];
  const invalid: Array<{ name: string; reason: string }> = [];
  let convertedCount = 0;

  for (const file of listAccountFiles()) {
    const name = file.replace(/\.json$/i, "");
    const result = readAccountWithInfo(join(CPA_DIR, file));
    if (!result.account) {
      invalid.push({ name, reason: result.error || "invalid account" });
      continue;
    }
    if (result.converted) convertedCount++;
    accounts.push({
      name,
      cred: result.account["openai-codex"],
      isActive: name === currentName,
    });
  }

  return { accounts, convertedCount, invalid };
}

function writeAccount(name: string, account: AccountFile) {
  ensureDir(CPA_DIR);
  writeJson(accountPath(name), account);
}

function getCurrentName(): string | null {
  try {
    if (existsSync(CURRENT_FILE)) {
      const name = readFileSync(CURRENT_FILE, "utf-8").trim();
      return isAccountName(name) ? name : null;
    }
  } catch {
    // Ignore a missing or temporarily unreadable marker.
  }
  return null;
}

function setCurrentName(name: string | null) {
  if (name) {
    if (!isAccountName(name)) throw new Error("Invalid account name");
    writeFileSync(CURRENT_FILE, name + "\n", { mode: 0o600 });
  } else if (existsSync(CURRENT_FILE)) {
    unlinkSync(CURRENT_FILE);
  }
}

// ---------------------------------------------------------------------------
// Active account
// ---------------------------------------------------------------------------

function readAuthJson(): Record<string, unknown> {
  if (!existsSync(AUTH_JSON)) return {};
  try {
    return readJson(AUTH_JSON) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readDiskCredential(): PiCredential | null {
  const credential = readAuthJson()["openai-codex"];
  return isPiCredential(credential) ? credential : null;
}

function readCurrentCredential(ctx: ExtensionContext): PiCredential | null {
  const credential = ctx.modelRegistry?.authStorage?.get("openai-codex");
  return isPiCredential(credential) ? credential : readDiskCredential();
}

function setCurrentCredential(ctx: ExtensionContext, credential: PiCredential) {
  // AuthStorage handles the file lock, preserves other providers, and updates
  // the in-memory credential used by the current pi process.
  ctx.modelRegistry?.authStorage?.set("openai-codex", credential);
}

function writebackCurrent(ctx: ExtensionContext, expectedName?: string | null) {
  const currentName = expectedName === undefined ? getCurrentName() : expectedName;
  const credential = readCurrentCredential(ctx);
  if (!currentName || !credential) return;

  const existing = readAccount(currentName);
  if (!existing) return;

  // Another pi process may have switched the shared global account meanwhile.
  // Never write one process's credential into a different account's file.
  const storedCredential = existing["openai-codex"];
  if (
    storedCredential.accountId &&
    credential.accountId &&
    storedCredential.accountId !== credential.accountId
  ) {
    return;
  }

  writeAccount(currentName, {
    "openai-codex": { ...credential, _meta: storedCredential._meta ?? credential._meta },
  });
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

interface UsageWindow {
  used_percent?: number;
  limit_window_seconds?: number;
}

interface UsageResponse {
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
}

interface UsageResult {
  usage: UsageResponse | null;
  expired?: boolean;
  error?: boolean;
}

async function fetchUsage(accessToken: string): Promise<UsageResponse> {
  return JSON.parse(await curlGet(USAGE_API, accessToken)) as UsageResponse;
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
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`));
      } else {
        resolve(stdout);
      }
    });

    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    child.stdin.end([
      `url = "${escape(url)}"`,
      `request = "GET"`,
      `header = "Authorization: Bearer ${escape(accessToken)}"`,
      `header = "Accept: application/json"`,
      `connect-timeout = 10`,
      `max-time = 20`,
      "",
    ].join("\n"));
  });
}

async function getUsage(credential: PiCredential): Promise<UsageResult> {
  if (Date.now() >= credential.expires) return { usage: null, expired: true };

  try {
    return { usage: await fetchUsage(credential.access) };
  } catch {
    return { usage: null, error: true };
  }
}

async function loadUsage(accounts: AccountRecord[]): Promise<Map<string, UsageResult>> {
  const entries = await Promise.all(
    accounts.map(async (account) => [account.name, await getUsage(account.cred)] as const),
  );
  return new Map(entries);
}

function getWindows(usage: UsageResponse | null): UsageWindow[] {
  if (!usage?.rate_limit) return [];
  return [usage.rate_limit.primary_window, usage.rate_limit.secondary_window]
    .filter((window): window is UsageWindow => Boolean(window));
}

function describeWindowLimit(window: UsageWindow): string {
  const seconds = window.limit_window_seconds;
  if (!seconds) return "window";
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function renderListUsageBar(percent: number | null): string {
  if (percent === null) return "──────";
  const filled = Math.max(0, Math.min(6, Math.round((percent / 100) * 6)));
  return "▰".repeat(filled) + "▱".repeat(6 - filled);
}

function formatListWindow(window: UsageWindow | null | undefined, fallbackLabel: string): string {
  const percent = typeof window?.used_percent === "number" ? Math.round(window.used_percent) : null;
  const label = window ? describeWindowLimit(window) : fallbackLabel;
  return `${label.padEnd(3)} ${renderListUsageBar(percent)} ${(percent === null ? "—" : `${percent}%`).padStart(4)}`;
}

function formatUsageWindows(result: UsageResult | undefined): string {
  const emptyWindows = `${formatListWindow(null, "5h")}  ${formatListWindow(null, "7d")}`;
  if (!result?.usage) return emptyWindows;

  const windows = getWindows(result.usage);
  const shortWindow = windows.find((window) => (window.limit_window_seconds ?? 0) < 86400) ?? null;
  const longWindow = windows.find((window) => (window.limit_window_seconds ?? 0) >= 86400) ?? null;
  return `${formatListWindow(shortWindow, "5h")}  ${formatListWindow(longWindow, "7d")}`;
}

function formatTokenState(credential: PiCredential): string {
  return Date.now() >= credential.expires ? "TOKEN EXP" : "TOKEN OK ";
}

// ---------------------------------------------------------------------------
// Account display
// ---------------------------------------------------------------------------

function accountEmail(credential: PiCredential): string {
  if (credential._meta?.email) return credential._meta.email;
  const profile = decodeJwtPayload(credential.access)?.["https://api.openai.com/profile"] as
    | Record<string, unknown>
    | undefined;
  return typeof profile?.email === "string" ? profile.email : "?";
}

// ---------------------------------------------------------------------------
// Session scanning — aggregate codex usage by model and time bucket
// ---------------------------------------------------------------------------

interface BucketUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface SessionUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface SessionEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: SessionUsage;
  };
}

function emptyBucket(): BucketUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addSessionUsage(bucket: Map<string, BucketUsage>, model: string, usage: SessionUsage) {
  const current = bucket.get(model) ?? emptyBucket();
  bucket.set(model, {
    input: current.input + (usage.input || 0),
    output: current.output + (usage.output || 0),
    reasoning: current.reasoning + (usage.reasoning || 0),
    cacheRead: current.cacheRead + (usage.cacheRead || 0),
    cacheWrite: current.cacheWrite + (usage.cacheWrite || 0),
    cost: current.cost + (usage.cost?.total || 0),
  });
}

function listRecentSessionFiles(since: number): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files: string[] = [];
  const addIfRecent = (path: string) => {
    try {
      if (statSync(path).mtimeMs >= since) files.push(path);
    } catch { /* skip unreadable files */ }
  };

  for (const entry of readdirSync(SESSIONS_DIR)) {
    const path = join(SESSIONS_DIR, entry);
    try {
      if (entry.endsWith(".jsonl")) {
        addIfRecent(path);
        continue;
      }
      for (const file of readdirSync(path).filter((name) => name.endsWith(".jsonl"))) {
        addIfRecent(join(path, file));
      }
    } catch { /* skip unreadable directories */ }
  }
  return files;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + "K";
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  return n > 0 ? "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(3)) : "$0";
}

interface TimeBuckets {
  today: Map<string, BucketUsage>;
  yesterday: Map<string, BucketUsage>;
  sevenDays: Map<string, BucketUsage>;
}

async function scanSessions(): Promise<TimeBuckets> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const yesterdayStart = todayMs - DAY_MS;
  const sevenDaysAgo = todayMs - 7 * DAY_MS;
  const buckets: TimeBuckets = { today: new Map(), yesterday: new Map(), sevenDays: new Map() };
  const files = listRecentSessionFiles(sevenDaysAgo);

  for (const filePath of files) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const content = readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          const message = entry.message;
          if (entry.type !== "message" || message?.role !== "assistant" || message.provider !== "openai-codex") continue;
          const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
          if (!message.model || !Number.isFinite(ts) || !message.usage?.totalTokens) continue;
          if (ts >= sevenDaysAgo) addSessionUsage(buckets.sevenDays, message.model, message.usage);
          if (ts >= todayMs) addSessionUsage(buckets.today, message.model, message.usage);
          else if (ts >= yesterdayStart && ts < todayMs) addSessionUsage(buckets.yesterday, message.model, message.usage);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return buckets;
}

function formatListText(
  accounts: AccountRecord[],
  usage: Map<string, UsageResult>,
  convertedCount: number,
  invalidCount: number,
): string {
  const maxNameLen = Math.max(...accounts.map((a) => a.name.length));
  const lines: string[] = [];
  for (const account of accounts) {
    const plan = account.cred._meta?.plan_type ?? "?";
    const windows = formatUsageWindows(usage.get(account.name));
    const marker = account.isActive ? "★" : " ";
    lines.push(`${marker} ${account.name.padEnd(maxNameLen)} ${plan.padEnd(8)} ${formatTokenState(account.cred)} ${windows}`);
  }
  if (convertedCount) lines.push(`\nAuto-converted: ${convertedCount}`);
  if (invalidCount) lines.push(`Invalid files: ${invalidCount}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// TUI panels
// ---------------------------------------------------------------------------

async function withLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  action: () => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") return action();

  const result = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
    void Promise.resolve()
      .then(action)
      .then(
        (value) => done({ value }),
        (error: unknown) => done({ error }),
      );
    return loader;
  });

  if ("error" in result) throw result.error;
  return result.value;
}

async function showAccountListPanel(
  ctx: ExtensionCommandContext,
  accounts: AccountRecord[],
  usage: Map<string, UsageResult>,
  convertedCount: number,
  invalidCount: number,
): Promise<string | null> {
  if (ctx.mode !== "tui") return null;

  return ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const items: SettingItem[] = accounts.map((account) => ({
        id: account.name,
        label: `${account.isActive ? "★" : " "} ${truncateToWidth(account.name, 27)}`,
        currentValue: `${(account.cred._meta?.plan_type ?? "?").padEnd(8)} ${formatTokenState(account.cred)} ${formatUsageWindows(usage.get(account.name))}`,
        submenu: (_currentValue, done) => {
          const actions = new SelectList(
            [{ value: "use", label: "Use this account", description: "Switch pi to this CPA account" }],
            1,
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          );
          actions.onSelect = (item) => done(item.value);
          actions.onCancel = () => done();
          return actions;
        },
      }));

      const container = new Container();
      const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
      container.addChild(border());
      container.addChild(new Text(theme.fg("accent", theme.bold(`CPA Accounts · ${accounts.length}`)), 1, 0));

      if (convertedCount || invalidCount) {
        const notes = [
          convertedCount ? `converted ${convertedCount}` : "",
          invalidCount ? `invalid ${invalidCount}` : "",
        ].filter(Boolean).join(" · ");
        container.addChild(new Text(theme.fg("warning", notes), 1, 0));
      }

      let closed = false;
      const close = (value: string | null) => {
        if (closed) return;
        closed = true;
        done(value);
      };
      const settings = new SettingsList(
        items,
        Math.min(items.length + 2, 12),
        getSettingsListTheme(),
        (id, action) => {
          if (action === "use") close(id);
        },
        () => close(null),
        { enableSearch: false },
      );
      container.addChild(settings);
      container.addChild(border());

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (closed) return;
          settings.handleInput(data);
          if (!closed) tui.requestRender();
        },
      };
    },
  );
}

async function showDetailsPanel(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
      container.addChild(border());
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(new Text(lines.join("\n"), 1, 0));
      container.addChild(new Text(theme.fg("dim", "Esc/Enter close"), 1, 0));
      container.addChild(border());

      let closed = false;
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (closed) return;
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
            closed = true;
            done();
            return;
          }
          tui.requestRender();
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Account actions
// ---------------------------------------------------------------------------

function activateAccount(
  ctx: ExtensionContext,
  name: string,
  previousName: string | null = getCurrentName(),
): string | null {
  const account = readAccount(name);
  if (!account) return null;

  if (previousName !== name) writebackCurrent(ctx, previousName);
  setCurrentCredential(ctx, account["openai-codex"]);
  setCurrentName(name);
  return accountEmail(account["openai-codex"]);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  ensureDir(CPA_DIR);

  let localAccountName: string | null = null;

  const syncCurrentAccount = (ctx: ExtensionContext): boolean => {
    const currentName = getCurrentName();
    if (currentName === localAccountName) return false;

    // Another pi process changed the shared account. Reload before the next request.
    ctx.modelRegistry?.authStorage?.reload();
    localAccountName = currentName;
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    // Pick up changes made by another pi process before account actions.
    ctx.modelRegistry?.authStorage?.reload();
    localAccountName = getCurrentName();
  });

  pi.on("turn_start", (_event, ctx) => {
    syncCurrentAccount(ctx);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    syncCurrentAccount(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    writebackCurrent(ctx, localAccountName);
  });

  pi.registerCommand("cpa:list", {
    description: "Open the CPA account dashboard",
    handler: async (_args, ctx) => {
      syncCurrentAccount(ctx);

      const { accounts, convertedCount, invalid } = collectAccounts();
      if (accounts.length === 0) {
        ctx.ui.notify(
          invalid.length ? `No valid accounts. Invalid files: ${invalid.length}` : "No CPA accounts found.",
          invalid.length ? "warning" : "info",
        );
        return;
      }

      const usage = await withLoader(ctx, "Fetching CPA usage…", () => loadUsage(accounts));

      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatListText(accounts, usage, convertedCount, invalid.length), "info");
        return;
      }

      const selected = await showAccountListPanel(
        ctx,
        accounts,
        usage,
        convertedCount,
        invalid.length,
      );
      if (!selected) return;

      try {
        const email = activateAccount(ctx, selected, localAccountName);
        if (!email) {
          ctx.ui.notify(`Account "${selected}" not found.`, "error");
          return;
        }
        localAccountName = selected;
        pi.events.emit("openai-codex:credential-changed");
        ctx.ui.notify(`Switched to: ${selected} (${email})`, "info");
      } catch (error) {
        ctx.ui.notify(`Switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("cpa:usage", {
    description: "Show per-model session stats",
    handler: async (_args, ctx) => {
      const theme = ctx.hasUI ? ctx.ui.theme : undefined;
      const dim = (text: string) => theme ? theme.fg("dim", text) : text;
      const accent = (text: string) => theme ? theme.fg("accent", text) : text;
      const lines: string[] = [];

      const timeBuckets = await withLoader(ctx, "Scanning session history…", scanSessions);

      const formatPeriod = (label: string, bucket: Map<string, BucketUsage>) => {
        const totals = [...bucket.values()].reduce(
          (a, b) => ({
            input: a.input + b.input,
            output: a.output + b.output,
            cacheRead: a.cacheRead + b.cacheRead,
            cacheWrite: a.cacheWrite + b.cacheWrite,
            cost: a.cost + b.cost,
            reasoning: a.reasoning + b.reasoning,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
        );
        const noCache = totals.input + totals.output + totals.reasoning;

        lines.push(`${accent(label)}`);
        if (noCache === 0 && totals.cacheRead === 0) {
          lines.push(`  ${dim("no activity")}`);
          return;
        }

        // summary line
        const cacheParts: string[] = [];
        if (totals.cacheRead) cacheParts.push(`r:${fmtTokens(totals.cacheRead)}`);
        if (totals.cacheWrite) cacheParts.push(`w:${fmtTokens(totals.cacheWrite)}`);
        const cacheText = cacheParts.length ? ` · cache ${cacheParts.join(" ")}` : "";
        lines.push(`${fmtTokens(noCache).padStart(8)} tokens · ${fmtCost(totals.cost)}${cacheText}`);

        // table header
        lines.push(`  ${dim("Model".padEnd(16))} ${dim("input".padStart(8))} ${dim("output".padStart(8))} ${dim("total".padStart(8))} ${dim("cost".padStart(8))}`);

        const sorted = [...bucket.entries()].sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
        for (const [model, usage] of sorted) {
          const modelNoCache = usage.input + usage.output + usage.reasoning;
          lines.push(
            `  ${accent(model.padEnd(16))}` +
            ` ${fmtTokens(usage.input).padStart(8)}` +
            ` ${fmtTokens(usage.output).padStart(8)}` +
            ` ${fmtTokens(modelNoCache).padStart(8)}` +
            ` ${fmtCost(usage.cost).padStart(8)}`
          );
        }
      };

      formatPeriod("Today", timeBuckets.today);
      lines.push(dim("─".repeat(48)));
      formatPeriod("Yesterday", timeBuckets.yesterday);
      lines.push(dim("─".repeat(48)));
      formatPeriod("7d", timeBuckets.sevenDays);

      await showDetailsPanel(ctx, "Usage", lines);
    },
  });

  pi.registerCommand("cpa:patch", {
    description: "Provide patching context to LLM",
    handler: async (_args, ctx) => {
      const piAiDir = (() => {
        const candidates = [
          join(homedir(), "scoop", "persist", "nodejs", "bin", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist"),
        ];
        for (const c of candidates) {
          if (existsSync(join(c, "api", "openai-codex-responses.js"))) return c;
        }
        return "<pi-ai/dist>";
      })();

      ctx.ui.notify([
        "=== Codex Account-ID Patch ===",
        "",
        "Background:",
        "CPA (CLIProxyAPI) accounts provide access_token + account_id in a JSON file.",
        "Pi's own OAuth login puts chatgpt_account_id inside the JWT access token.",
        "CPA tokens do NOT have this field; they only have user_id in the JWT.",
        "",
        "Where it breaks:",
        "1. Every API request calls extractAccountId() to build chatgpt-account-id header.",
        "2. Token refresh calls credentialsFromToken() → getAccountId().",
        "3. Both look for chatgpt_account_id in JWT; missing → throw.",
        "",
        "Fix: fall back from chatgpt_account_id to user_id (both valid for Codex API).",
        "",
        `File 1: ${piAiDir}/api/openai-codex-responses.js`,
        "  function extractAccountId() — per-request header builder",
        "  Current:",
        '    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;',
        '    if (!accountId) throw new Error("No account ID in token");',
        "  Target:",
        '    const auth = payload?.[JWT_CLAIM_PATH];',
        '    const accountId = auth?.chatgpt_account_id || auth?.user_id;',
        '    if (!accountId) throw new Error("No account ID in token");',
        "",
        `File 2: ${piAiDir}/utils/oauth/openai-codex.js`,
        "  function getAccountId() — helper, called by credentialsFromToken for refresh",
        "  Current:",
        '    const accountId = auth?.chatgpt_account_id;',
        '    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;',
        "  Target:",
        '    const accountId = auth?.chatgpt_account_id || auth?.user_id;',
        '    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;',
        "",
        "Important:",
        "- These are ESM modules (loaded via dynamic import).",
        "- Do NOT use require() — it is unavailable and fails silently.",
        "- Use atob() / existing decodeJwt() helpers already in the file.",
        "- After patching, restart pi.",
      ].join("\n"), "info");
    },
  });
}
