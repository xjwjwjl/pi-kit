import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundRows } from "./results.js";
import { firstKeyword, hasMultipleStatements } from "./sql.js";

export const USQL_TOOL_NAME = "database_usql";
export const USQL_BINARY_ENV = "PI_DATABASE_USQL_BIN";
export const USQL_DEFAULT_TIMEOUT_MS = 30_000;
export const USQL_DEFAULT_MAX_ROWS = 100;
export const USQL_MAX_ROWS_LIMIT = 500;
export const USQL_MAX_TIMEOUT_MS = 300_000;

const MAX_STDOUT_BYTES = 1_000_000;
const MAX_RAW_OUTPUT_CHARS = 5_000;

let cachedBinary: string | undefined | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(output: string | Buffer | null | undefined): string | undefined {
  if (!output) return undefined;
  return output
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function locateOnPath(name: string): string | undefined {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const probe = spawnSync(command, [name], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) return undefined;
  return firstLine(probe.stdout);
}

/**
 * Resolves the usql binary once per process. Tests control the result through
 * `PI_DATABASE_USQL_BIN` plus `resetUsqlBinaryCache`.
 */
export function resolveUsqlBinary(): string | undefined {
  if (cachedBinary !== null) return cachedBinary;

  const override = process.env[USQL_BINARY_ENV]?.trim();
  // An explicit override is authoritative and trusted as-is: a missing path
  // means usql is unavailable instead of silently falling back to PATH.
  if (override) {
    cachedBinary = existsSync(override) ? override : undefined;
    return cachedBinary;
  }

  const candidates = [locateOnPath("usql") ?? "usql"];

  cachedBinary = undefined;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) {
      cachedBinary = candidate;
      break;
    }
  }
  return cachedBinary;
}

/** Drops the resolved binary so the next lookup honours the current environment. */
export function resetUsqlBinaryCache(): void {
  cachedBinary = null;
}

export function isUsqlDisabled(): boolean {
  const flag = process.env.PI_DATABASE_USQL?.trim().toLowerCase();
  return flag === "0" || flag === "off" || flag === "false" || flag === "no";
}

export function usqlAvailable(): boolean {
  return !isUsqlDisabled() && resolveUsqlBinary() !== undefined;
}

/** Hides the password inside a DSN so connection strings stay safe in UI and logs. */
export function redactConnection(connection: string): string {
  const trimmed = connection.trim();
  const separator = trimmed.indexOf("://");
  if (separator <= 0) return trimmed;
  const scheme = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 3);
  const atIndex = rest.lastIndexOf("@");
  if (atIndex < 0) return `${scheme}://${rest}`;
  const userinfo = rest.slice(0, atIndex);
  const host = rest.slice(atIndex + 1);
  const colonIndex = userinfo.indexOf(":");
  const user = colonIndex < 0 ? userinfo : userinfo.slice(0, colonIndex);
  return `${scheme}://${user}${colonIndex < 0 ? "" : ":*****"}@${host}`;
}

export function connectionScheme(connection: string): string | undefined {
  const trimmed = connection.trim();
  const separator = trimmed.indexOf("://");
  return separator > 0 ? trimmed.slice(0, separator).toLowerCase() : undefined;
}

export function statementKind(statement: string): string {
  const trimmed = statement.trim();
  if (trimmed.startsWith("\\")) return "meta";
  return firstKeyword(trimmed)?.toLowerCase() ?? "unknown";
}

export type UsqlRawOutput = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

export type ParsedUsqlOutput = {
  columns?: string[];
  rows?: unknown[][];
  output?: string;
};

export function parseUsqlOutput(stdout: string): ParsedUsqlOutput {
  const text = stdout.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { output: clampText(text) };
  }
  if (!Array.isArray(parsed)) return { output: clampText(text) };
  const objects = parsed.filter(isPlainObject);
  if (parsed.length > 0 && objects.length === 0) return { output: clampText(text) };
  const columns: string[] = [];
  for (const row of objects) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return {
    columns,
    rows: objects.map((row) => columns.map((column) => row[column] ?? null))
  };
}

function clampText(value: string): string {
  return value.length <= MAX_RAW_OUTPUT_CHARS ? value : `${value.slice(0, MAX_RAW_OUTPUT_CHARS - 1)}…`;
}

export type UsqlRunOptions = {
  binary: string;
  connection: string;
  statement: string;
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
};

export type UsqlRunResult = {
  columns?: string[];
  rows?: unknown[][];
  row_count: number;
  truncated: boolean;
  warnings: string[];
  output?: string;
  stderr?: string;
  exit_code: number;
};

async function writeStatementFile(statement: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-database-usql-"));
  const file = join(dir, "statement.sql");
  await writeFile(file, usqlScriptContents(statement), "utf8");
  return { dir, file };
}

/**
 * usql only runs statements that reach a semicolon when they come from a file;
 * a bare trailing statement is silently ignored. Meta-commands terminate at the
 * end of the line instead, so they must not receive one. A trailing comment
 * after the semicolon must not be mistaken for an unterminated statement.
 */
export function usqlScriptContents(statement: string): string {
  const trimmed = statement.trim();
  if (trimmed.startsWith("\\")) return `${trimmed}\n`;
  return endsWithStatementTerminator(trimmed) ? `${trimmed}\n` : `${trimmed}\n;\n`;
}

function endsWithStatementTerminator(statement: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let blockComment = false;
  let lineComment = false;
  let lastSignificant = "";

  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    const next = statement[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && statement[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char.trim()) lastSignificant = char;
  }

  return lastSignificant === ";";
}

function spawnUsql(options: UsqlRunOptions, file: string): Promise<UsqlRawOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, ["-J", "-q", "-X", "-w", "-f", file, options.connection], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const stop = (reason: "timeout" | "abort" | "overflow") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new Error(`usql timed out after ${options.timeoutMs} ms.`));
        return;
      }
      if (aborted) {
        reject(new Error("usql execution was cancelled."));
        return;
      }
      resolve({ stdout, stderr, exit_code: code });
    };

    child.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code) => done(code ?? 0));

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        stdout = `${stdout.slice(0, MAX_STDOUT_BYTES)}…`;
        stop("overflow");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_RAW_OUTPUT_CHARS) stderr += chunk;
    });
  });
}

export async function runUsqlStatement(options: UsqlRunOptions): Promise<UsqlRunResult> {
  if (hasMultipleStatements(options.statement)) {
    throw new Error("database_usql accepts one SQL statement per call; usql JSON output cannot be split per statement reliably.");
  }
  const { dir, file } = await writeStatementFile(options.statement);
  try {
    const raw = await spawnUsql(options, file);
    const parsed = parseUsqlOutput(raw.stdout);
    const warnings: string[] = [];
    let columns = parsed.columns;
    let rows = parsed.rows;
    let truncated = false;

    if (rows) {
      const bounded = boundRows(rows, options.maxRows);
      rows = bounded.rows;
      truncated = bounded.truncated;
      warnings.push(...bounded.warnings);
    }
    if (raw.stdout.length > MAX_STDOUT_BYTES) {
      warnings.push("Raw usql output was limited before parsing.");
    }
    const stderr = raw.stderr.trim();
    return {
      ...(columns ? { columns } : {}),
      ...(rows ? { rows } : {}),
      row_count: rows?.length ?? 0,
      truncated,
      warnings,
      ...(parsed.output ? { output: parsed.output } : {}),
      ...(stderr ? { stderr } : {}),
      exit_code: raw.exit_code
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
