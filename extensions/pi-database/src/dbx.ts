import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ResolvedSource, SqlDialect } from "./types.js";

const DBX_KEYRING_TARGET = "local-data-encryption-key.com.dbx.app.secret-store.v1";
const DBX_KEYRING_SCRIPT = fileURLToPath(new URL("../scripts/read-dbx-secret-key.ps1", import.meta.url));
const DBX_ENVELOPE_PREFIX = "dbxenc1";
const DBX_ARGON2_SALT = "dbx-local-secret-store-v1";

type SqliteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
};

type SqliteDatabase = {
  prepare(query: string): SqliteStatement;
  close(): void;
};

type SqliteColumn = { name?: unknown };

type SqliteModule = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

type JsonRecord = Record<string, unknown>;

type DbxConnectionRow = {
  id?: unknown;
  config_json?: unknown;
  secret?: unknown;
  secret_enc?: unknown;
};

export type DbxSourceDiscovery = {
  sources: ResolvedSource[];
  warning?: string;
};

const secretKeyCache = new Map<string, Buffer>();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function secretString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sqliteConstructor(): SqliteModule["DatabaseSync"] {
  const getBuiltinModule = (process as typeof process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  if (!sqlite?.DatabaseSync) {
    throw new Error("DBX connection import requires a Node.js runtime with the built-in node:sqlite module.");
  }
  return sqlite.DatabaseSync;
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as SqliteColumn[])
    .some((entry) => entry.name === column);
}

export function resolveDbxDatabasePath(): string | undefined {
  const explicitPath = stringValue(process.env.PI_DATABASE_DBX_DB_PATH);
  if (explicitPath) return path.resolve(explicitPath);

  const configuredDataDir = stringValue(process.env.DBX_DATA_DIR);
  if (configuredDataDir) return path.join(path.resolve(configuredDataDir), "dbx.db");

  if (process.platform === "win32") {
    const appData = stringValue(process.env.APPDATA);
    return appData ? path.join(appData, "com.dbx.app", "dbx.db") : undefined;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "com.dbx.app", "dbx.db");
  }
  const dataHome = stringValue(process.env.XDG_DATA_HOME) ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "com.dbx.app", "dbx.db");
}

function sourceNameForId(id: string): string {
  return `dbx-${id.replace(/[^a-z0-9_.-]/gi, "_")}`;
}

/** Readable name fragment from a DBX connection name; empty when nothing usable remains. */
function sourceSlug(connectionName: string | undefined): string {
  if (!connectionName) return "";
  return connectionName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[_.-]+$/, "")
    .slice(0, 40);
}

function uniqueSourceName(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  let index = 2;
  while (taken.has(`${preferred}-${index}`)) index++;
  const name = `${preferred}-${index}`;
  taken.add(name);
  return name;
}

function passwordFingerprint(config: JsonRecord, row: DbxConnectionRow): string {
  const encrypted = secretString(row.secret_enc);
  const storedSecret = secretString(row.secret);
  const configPassword = secretString(config.password);
  const material = encrypted ?? storedSecret ?? configPassword ?? "";
  return material ? createHash("sha256").update(material).digest("hex") : "none";
}

function toSource(config: JsonRecord, row: DbxConnectionRow, databasePath: string, name: string): ResolvedSource | undefined {
  const id = stringValue(row.id);
  const dialectValue = stringValue(config.db_type)?.toLowerCase();
  if (!id || (dialectValue !== "mysql" && dialectValue !== "clickhouse")) return undefined;
  const dialect = dialectValue as SqlDialect;
  const connectionName = stringValue(config.name);
  const host = stringValue(config.host);
  const username = stringValue(config.username);
  const database = stringValue(config.database);
  const secure = config.ssl === true;
  const options: Record<string, unknown> = {
    host,
    port: positiveInteger(config.port, dialect === "mysql" ? 3306 : secure ? 8443 : 8123),
    username,
    user: username,
    database: database ?? "",
    ssl: secure,
    secure,
    ...(stringValue(config.url_params) ? { url_params: config.url_params } : {})
  };
  const queryTimeoutMs = Math.min(300_000, positiveInteger(config.query_timeout_secs, 30) * 1000);
  const dbxSecretFingerprint = passwordFingerprint(config, row);
  const cacheKey = JSON.stringify({ name, dialect, options, queryTimeoutMs, dbxSecretFingerprint });

  return {
    name,
    label: connectionName && connectionName !== name ? connectionName : undefined,
    dialect,
    options,
    allowWrite: config.read_only !== true && config.is_production !== true,
    writeConfirm: true,
    queryTimeoutMs,
    maxRows: 100,
    configPath: databasePath,
    cacheKey,
    provider: "dbx",
    dbxConnectionId: id,
    ...(connectionName ? { dbxConnectionName: connectionName } : {}),
    dbxDatabasePath: databasePath,
    dbxSecretFingerprint
  };
}

export function loadDbxSources(reservedNames: readonly string[] = []): DbxSourceDiscovery {
  const databasePath = resolveDbxDatabasePath();
  if (!databasePath || !existsSync(databasePath)) return { sources: [] };

  let database: SqliteDatabase | undefined;
  try {
    const DatabaseSync = sqliteConstructor();
    database = new DatabaseSync(databasePath, { readOnly: true });
    const connectionTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connections'").get();
    if (!connectionTable) return { sources: [] };

    const secretTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connection_secrets'").get();
    const hasSecretEnc = secretTable && hasColumn(database, "connection_secrets", "secret_enc");
    const rows = secretTable
      ? database.prepare(hasSecretEnc ? `
          SELECT c.id, c.config_json, s.secret, s.secret_enc
          FROM connections AS c
          LEFT JOIN connection_secrets AS s
            ON s.connection_id = c.id AND s.key = 'password'
          ORDER BY c.rowid
        ` : `
          SELECT c.id, c.config_json, s.secret
          FROM connections AS c
          LEFT JOIN connection_secrets AS s
            ON s.connection_id = c.id AND s.key = 'password'
          ORDER BY c.rowid
        `).all() as DbxConnectionRow[]
      : database.prepare("SELECT id, config_json FROM connections ORDER BY rowid").all() as DbxConnectionRow[];

    const taken = new Set(reservedNames);
    const sources: ResolvedSource[] = [];
    let unsupported = 0;
    for (const row of rows) {
      if (typeof row.config_json !== "string") continue;
      let config: unknown;
      try {
        config = JSON.parse(row.config_json);
      } catch {
        continue;
      }
      if (!isRecord(config)) continue;
      const id = stringValue(row.id);
      const dialectValue = stringValue(config.db_type)?.toLowerCase();
      if (!id || (dialectValue !== "mysql" && dialectValue !== "clickhouse")) {
        unsupported++;
        continue;
      }
      const slug = sourceSlug(stringValue(config.name));
      const source = toSource(config, row, databasePath, uniqueSourceName(slug ? `dbx-${slug}` : sourceNameForId(id), taken));
      if (source) sources.push(source);
    }
    return {
      sources,
      ...(unsupported > 0 ? { warning: `Skipped ${unsupported} DBX connections whose database type is not supported by pi-database.` } : {})
    };
  } catch {
    return {
      sources: [],
      warning: "DBX connections could not be read from the local profile. Check that DBX is installed and its profile is readable."
    };
  } finally {
    database?.close();
  }
}

function decodeKeyMaterial(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[a-z0-9_-]+={0,2}$/i.test(trimmed)) {
    const key = Buffer.from(trimmed, "base64url");
    if (key.length === 32) return key;
  }
  if (!trimmed) throw new Error("DBX secret key is empty.");

  const cryptoModule = (process as typeof process & { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule?.("node:crypto") as {
      argon2Sync?: (algorithm: string, parameters: {
        message: string;
        nonce: Buffer;
        parallelism: number;
        tagLength: number;
        memory: number;
        passes: number;
      }) => Buffer;
    } | undefined;
  if (!cryptoModule?.argon2Sync) {
    throw new Error("DBX passphrase keys require Node.js 24.7 or later; use a 32-byte base64url or 64-digit hexadecimal key instead.");
  }
  return cryptoModule.argon2Sync("argon2id", {
    message: trimmed,
    nonce: Buffer.from(DBX_ARGON2_SALT, "utf8"),
    parallelism: 1,
    tagLength: 32,
    memory: 19 * 1024,
    passes: 2
  });
}

function decodeCredentialBlob(blob: Buffer): string {
  if (blob.length >= 2 && blob.length % 2 === 0) {
    let utf16le = true;
    for (let index = 1; index < blob.length; index += 2) {
      if (blob[index] !== 0) {
        utf16le = false;
        break;
      }
    }
    if (utf16le) return blob.toString("utf16le").replace(/\0+$/u, "");
  }
  return blob.toString("utf8").replace(/\0+$/u, "");
}

function readWindowsCredentialKey(): Buffer {
  const powershell = stringValue(process.env.SystemRoot)
    ? path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  let rawBase64: string;
  try {
    rawBase64 = execFileSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      DBX_KEYRING_SCRIPT,
      "-TargetName",
      DBX_KEYRING_TARGET
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096, windowsHide: true }).trim();
  } catch {
    throw new Error("Unable to read the DBX secret key from Windows Credential Manager.");
  }
  if (!rawBase64 || !/^[a-z0-9+/]+={0,2}$/i.test(rawBase64)) {
    throw new Error("DBX secret key was not available in Windows Credential Manager.");
  }
  return decodeKeyMaterial(decodeCredentialBlob(Buffer.from(rawBase64, "base64")));
}

function readDbxSecretKey(databasePath: string): Buffer {
  const cached = secretKeyCache.get(databasePath);
  if (cached) return cached;

  const keyFile = stringValue(process.env.DBX_SECRET_KEY_FILE);
  if (keyFile) {
    const key = decodeKeyMaterial(readFileSync(keyFile, "utf8"));
    secretKeyCache.set(databasePath, key);
    return key;
  }
  const environmentKey = stringValue(process.env.DBX_SECRET_KEY);
  if (environmentKey) {
    const key = decodeKeyMaterial(environmentKey);
    secretKeyCache.set(databasePath, key);
    return key;
  }

  const compatibilityKeyPath = stringValue(process.env.APPDATA)
    ? path.join(process.env.APPDATA!, "dbx", "secret.key")
    : undefined;
  if (compatibilityKeyPath && existsSync(compatibilityKeyPath)) {
    const key = decodeKeyMaterial(readFileSync(compatibilityKeyPath, "utf8"));
    secretKeyCache.set(databasePath, key);
    return key;
  }

  if (process.platform === "win32") {
    const key = readWindowsCredentialKey();
    secretKeyCache.set(databasePath, key);
    return key;
  }

  const dataDir = stringValue(process.env.DBX_DATA_DIR);
  const managedKeyPath = dataDir ? path.join(dataDir, ".dbx", "secret.key") : undefined;
  if (managedKeyPath && existsSync(managedKeyPath)) {
    const key = decodeKeyMaterial(readFileSync(managedKeyPath, "utf8"));
    secretKeyCache.set(databasePath, key);
    return key;
  }

  throw new Error("DBX saved passwords require a local secret-store provider; this pi-database build currently supports Windows Credential Manager and DBX key files.");
}

export function decryptDbxSecret(envelope: string, secretKey: Buffer, namespace: string, key: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== DBX_ENVELOPE_PREFIX) {
    throw new Error("Unsupported DBX secret envelope.");
  }
  const nonce = Buffer.from(parts[1]!, "base64url");
  const encrypted = Buffer.from(parts[2]!, "base64url");
  if (nonce.length !== 12 || encrypted.length < 16) throw new Error("Invalid DBX secret envelope.");
  const decipher = createDecipheriv("aes-256-gcm", secretKey, nonce);
  decipher.setAAD(Buffer.from(`dbx-secret-v1\0${namespace}\0${key}`, "utf8"));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

export function readDbxPassword(connectionId: string, databasePath: string): string {
  let database: SqliteDatabase | undefined;
  try {
    const DatabaseSync = sqliteConstructor();
    database = new DatabaseSync(databasePath, { readOnly: true });
    const connectionRow = database.prepare("SELECT config_json FROM connections WHERE id = ?").get(connectionId) as { config_json?: unknown } | undefined;
    if (!connectionRow || typeof connectionRow.config_json !== "string") {
      throw new Error("The DBX connection no longer exists. Refresh the DBX sources and try again.");
    }
    let config: unknown;
    try {
      config = JSON.parse(connectionRow.config_json);
    } catch {
      throw new Error("The selected DBX connection configuration is invalid.");
    }
    const secretTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connection_secrets'").get();
    const hasSecretEnc = secretTable && hasColumn(database, "connection_secrets", "secret_enc");
    const secretRow = secretTable
      ? database.prepare(hasSecretEnc
          ? "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = ? AND key = 'password'"
          : "SELECT secret FROM connection_secrets WHERE connection_id = ? AND key = 'password'")
        .get(connectionId) as { secret?: unknown; secret_enc?: unknown } | undefined
      : undefined;
    const encrypted = secretString(secretRow?.secret_enc);
    if (encrypted) return decryptDbxSecret(encrypted, readDbxSecretKey(databasePath), connectionId, "password");
    const legacySecret = secretString(secretRow?.secret);
    if (legacySecret) return legacySecret;
    return isRecord(config) ? secretString(config.password) ?? "" : "";
  } catch (error) {
    if (error instanceof Error && /^(The DBX connection|The selected DBX connection)/.test(error.message)) throw error;
    throw new Error("Unable to resolve the saved password for this DBX connection. Check DBX's local secret store and profile.");
  } finally {
    database?.close();
  }
}

export function clearDbxSecretCache(): void {
  for (const key of secretKeyCache.values()) key.fill(0);
  secretKeyCache.clear();
}
