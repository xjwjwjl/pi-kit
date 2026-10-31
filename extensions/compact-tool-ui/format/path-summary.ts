import { shortPath, truncatePathMiddle } from "../core-utils.js";

/**
 * Inline budget for a tool-row path.
 *
 * Mirrors `MAX_INLINE_COMMAND_CHARS` in the bash summary so a command and a path
 * are ellipsized at the same scale; the extra room over the deepest common path
 * is intentional, file names are the primary identifier.
 */
export const MAX_INLINE_PATH_CHARS = 64;

/**
 * One-line, row-ready path: `~`-shortened and middle-truncated so the trailing
 * segment (usually the file name) survives even when leading directories do not.
 */
export function summarizePath(value: unknown): string {
	return truncatePathMiddle(shortPath(value), MAX_INLINE_PATH_CHARS);
}
