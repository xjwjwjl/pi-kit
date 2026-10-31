import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Detect whether a module is the process entrypoint.
 *
 * `import.meta.main` only exists on Node >= 22.18 / 24.2. On Node 22.6–22.17 it evaluates to
 * `undefined`, so `if (import.meta.main) await main()` silently skips the entrypoint and the
 * process exits 0 without running anything. Comparing the resolved entry path works everywhere.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
