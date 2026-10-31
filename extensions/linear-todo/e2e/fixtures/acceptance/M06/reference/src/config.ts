export interface AppConfig {
  authToken?: string;
  cacheTtlMs: number;
}

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const rawTtl = env.CACHE_TTL_MS ?? "1000";
  const cacheTtlMs = Number(rawTtl);
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error("CACHE_TTL_MS must be non-negative");
  return { authToken: env.AUTH_TOKEN, cacheTtlMs };
}

export function parseTtlMs(raw: string | undefined): number {
  const value = Number(raw ?? "1000");
  if (!Number.isFinite(value) || value < 0) throw new Error("CACHE_TTL_MS must be non-negative");
  if (value > 60000) throw new Error("CACHE_TTL_MS must not exceed 60000");
  return value;
}
