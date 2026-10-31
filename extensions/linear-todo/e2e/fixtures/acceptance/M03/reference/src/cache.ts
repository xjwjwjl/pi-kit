import { readConfig } from "./config.ts";

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function putCache<T>(value: T, now: number, ttlMs: number): CacheEntry<T> {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be non-negative");
  return { value, expiresAt: now + ttlMs };
}

export function readCache<T>(entry: CacheEntry<T>, now: number): T | undefined {
  return now < entry.expiresAt ? entry.value : undefined;
}

export function readCacheTtlMs(env: Record<string, string | undefined>): number {
  return readConfig(env).cacheTtlMs;
}
