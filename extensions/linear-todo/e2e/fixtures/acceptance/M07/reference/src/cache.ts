export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function putCache<T>(value: T, now: number, ttlMs: number): CacheEntry<T> {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be non-negative");
  if (!Number.isInteger(ttlMs)) throw new Error("ttlMs must be an integer");
  return { value, expiresAt: now + ttlMs };
}

export function readCache<T>(entry: CacheEntry<T>, now: number): T | undefined {
  return now < entry.expiresAt ? entry.value : undefined;
}
