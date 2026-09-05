import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hasQuotaCap, selectStatusWindow } from "./quota.ts";
import type { CommandCodeCredential } from "./usage-types.ts";
import type { CommandCodeQuotaResult } from "./quota-types.ts";

export const MAX_CACHED_CREDENTIALS = 8;
export const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
export const RETRY_MAX_ATTEMPTS = 4;
export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 60_000;
export const CACHE_FILE_NAME = "commandcode-usage-cache.json";
export const REFRESH_LOCK_SUFFIX = ".refresh.lock";

export interface QuotaCachePaths {
	cacheFile: string;
	refreshLock: string;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		?? join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent");
}

export function getQuotaCachePaths(agentDir = getAgentDir()): QuotaCachePaths {
	const cacheFile = join(agentDir, CACHE_FILE_NAME);
	return { cacheFile, refreshLock: `${cacheFile}${REFRESH_LOCK_SUFFIX}` };
}

export function credentialCacheKey(credential: CommandCodeCredential | string): string {
	const access = typeof credential === "string" ? credential : credential.access;
	return createHash("sha256").update(access).digest("hex");
}

export interface CacheEntry {
	result: CommandCodeQuotaResult;
	observedAt: number;
	lastSuccessAt?: number;
	lastAttemptAt: number;
	stale: boolean;
	retryCount: number;
	nextRetryAt?: number;
}

export type PersistentCache = Record<string, CacheEntry>;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeResult(value: unknown): CommandCodeQuotaResult | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as { status?: unknown; quota?: unknown; error?: unknown };
	if (raw.status !== "success" && raw.status !== "expired"
		&& raw.status !== "error" && raw.status !== "cancelled") return undefined;
	if (raw.quota !== null && (typeof raw.quota !== "object" || Array.isArray(raw.quota) || raw.quota === undefined)) return undefined;
	return {
		status: raw.status,
		quota: raw.quota as CommandCodeQuotaResult["quota"],
		error: typeof raw.error === "string" ? raw.error : undefined,
	};
}

function normalizeCacheEntry(value: unknown): CacheEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as {
		result?: unknown;
		observedAt?: unknown;
		lastSuccessAt?: unknown;
		lastAttemptAt?: unknown;
		stale?: unknown;
		retryCount?: unknown;
		nextRetryAt?: unknown;
	};
	const result = normalizeResult(raw.result);
	const observedAt = finiteNumber(raw.observedAt) ?? finiteNumber(raw.lastAttemptAt);
	const lastAttemptAt = finiteNumber(raw.lastAttemptAt) ?? observedAt;
	if (!result || observedAt === undefined || lastAttemptAt === undefined) return undefined;
	return {
		result,
		observedAt,
		lastSuccessAt: finiteNumber(raw.lastSuccessAt),
		lastAttemptAt,
		stale: raw.stale === true || result.status !== "success",
		retryCount: finiteNumber(raw.retryCount) ?? 0,
		nextRetryAt: finiteNumber(raw.nextRetryAt),
	};
}

function listCacheSnapshotFiles(paths: QuotaCachePaths): string[] {
	const directory = dirname(paths.cacheFile);
	const prefix = `${basename(paths.cacheFile)}.snapshot.`;
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile()
				&& entry.name.startsWith(prefix)
				&& entry.name.endsWith(".json"))
			.map((entry) => join(directory, entry.name));
	} catch {
		return [];
	}
}

function mergePersistentCache(cache: PersistentCache, value: unknown, cutoff: number): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	for (const [key, rawEntry] of Object.entries(value)) {
		const entry = normalizeCacheEntry(rawEntry);
		if (entry && entry.lastAttemptAt >= cutoff
			&& (!cache[key] || cache[key]!.lastAttemptAt <= entry.lastAttemptAt)) {
			cache[key] = entry;
		}
	}
}

export function loadPersistentCache(
	paths = getQuotaCachePaths(),
	at = Date.now(),
): PersistentCache {
	const cutoff = at - MAX_PERSISTED_AGE_MS;
	const cache: PersistentCache = {};
	for (const file of [paths.cacheFile, ...listCacheSnapshotFiles(paths)]) {
		try {
			mergePersistentCache(cache, JSON.parse(readFileSync(file, "utf-8")), cutoff);
		} catch {
			// Ignore missing or partially written cache candidates.
		}
	}
	return cache;
}

function pruneCacheSnapshots(paths: QuotaCachePaths, keepFile: string): void {
	for (const file of listCacheSnapshotFiles(paths)) {
		if (file === keepFile) continue;
		try {
			rmSync(file, { force: true });
		} catch {
			// Stale snapshots are harmless if cleanup fails.
		}
	}
}

/**
 * Atomically publishes a cache snapshot. Callers must hold the shared refresh
 * directory lock before invoking this function.
 */
export function savePersistentCache(
	credential: CommandCodeCredential | string,
	entry: CacheEntry,
	paths = getQuotaCachePaths(),
): PersistentCache {
	const key = credentialCacheKey(credential);
	let tempFile: string | undefined;
	try {
		mkdirSync(dirname(paths.cacheFile), { recursive: true });
		const cache = loadPersistentCache(paths);
		const current = cache[key];
		if (!current || current.lastAttemptAt <= entry.lastAttemptAt) cache[key] = entry;

		const serialized = JSON.stringify(Object.fromEntries(
			Object.entries(cache)
				.sort(([, a], [, b]) => b.lastAttemptAt - a.lastAttemptAt)
				.slice(0, MAX_CACHED_CREDENTIALS),
		));
		const suffix = `${Date.now()}.${process.pid}.${randomUUID()}`;
		tempFile = `${paths.cacheFile}.${suffix}.tmp`;
		const snapshotFile = `${paths.cacheFile}.snapshot.${suffix}.json`;
		writeFileSync(tempFile, serialized, "utf-8");
		renameSync(tempFile, snapshotFile);
		tempFile = undefined;
		pruneCacheSnapshots(paths, snapshotFile);
		try {
			writeFileSync(paths.cacheFile, serialized, "utf-8");
		} catch {
			// The committed snapshot remains the recovery source.
		}
		return cache;
	} catch {
		return loadPersistentCache(paths);
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

export function isSuccessfulQuota(result: CommandCodeQuotaResult): boolean {
	return result.status === "success"
		&& Boolean(result.quota && hasQuotaCap(selectStatusWindow(result.quota).window));
}

export function createCacheEntry(
	previous: CacheEntry | undefined,
	result: CommandCodeQuotaResult,
	observedAt: number,
): CacheEntry {
	if (result.status === "cancelled") return previous ?? {
		result,
		observedAt,
		lastAttemptAt: observedAt,
		stale: true,
		retryCount: 0,
	};

	const successful = isSuccessfulQuota(result);
	const failed = result.status === "error" || (result.status === "success" && !successful);
	const storedResult: CommandCodeQuotaResult = failed
		? { status: "error", quota: null, error: result.error || "quota unavailable" }
		: result;
	const sameStreak = previous !== undefined && previous.lastAttemptAt >= windowBoundary(observedAt);
	const priorRetryCount = sameStreak ? previous.retryCount : 0;
	const retryCount = failed ? priorRetryCount + 1 : 0;
	const nextRetryAt = failed && retryCount < RETRY_MAX_ATTEMPTS
		? observedAt + retryBackoffDelayMs(retryCount)
		: undefined;

	return {
		result: storedResult,
		observedAt,
		lastSuccessAt: successful ? observedAt : previous?.lastSuccessAt,
		lastAttemptAt: observedAt,
		stale: !successful,
		retryCount,
		nextRetryAt,
	};
}

export function isRetryDue(entry: CacheEntry | undefined, now: number): boolean {
	return Boolean(
		entry
		&& entry.retryCount > 0
		&& entry.retryCount < RETRY_MAX_ATTEMPTS
		&& entry.nextRetryAt !== undefined
		&& now >= entry.nextRetryAt,
	);
}

export function isFreshCacheEntry(entry: CacheEntry | undefined, refreshBoundary: number): boolean {
	return Boolean(
		entry
		&& !entry.stale
		&& entry.result.status === "success"
		&& entry.lastSuccessAt !== undefined
		&& entry.lastSuccessAt >= refreshBoundary,
	);
}

export function hasAttemptedInRefreshWindow(entry: CacheEntry | undefined, refreshBoundary: number): boolean {
	return Boolean(entry && entry.lastAttemptAt >= refreshBoundary);
}

function retryBackoffDelayMs(retryCount: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1), RETRY_MAX_DELAY_MS);
}

function windowBoundary(now: number): number {
	return Math.floor(now / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
