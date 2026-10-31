import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RunOutcome } from "./outcome.ts";

export const INLINE_RESULT_LIMIT = 12_000;

/** Render plain result data, preserving meaningful response whitespace verbatim. */
function resultText(outcome: RunOutcome): string {
	const sections: string[] = [];
	if (outcome.status === "failed") {
		sections.push(`Error: ${outcome.error.trim() ? outcome.error : "the agent failed (no error details)"}`);
	} else if (outcome.status === "aborted") {
		const reasons = { cancelled: "cancelled", turn_limit: "turn limit reached (turn_limit)",
			sdk_abort: "SDK session aborted (sdk_abort)" };
		const reason = outcome.reason === "turn_limit" && outcome.limit !== undefined
			? `turn limit reached (turn_limit: max_turns=${outcome.limit})`
			: reasons[outcome.reason];
		sections.push(`Aborted: ${reason}.`);
	}
	if (outcome.cleanupWarning !== undefined) {
		sections.push(`Cleanup warning: ${outcome.cleanupWarning || "(no details)"}`);
	}
	if (outcome.responseText.trim()) sections.push(outcome.responseText);
	else if (outcome.status === "finished") sections.push("(no output)");
	return sections.join("\n\n");
}

/**
 * Inline small results; spill large ones to ordinary UTF-8 text, not SDK sessions.
 * Lengths and budgets use JavaScript string lengths (UTF-16 code units).
 * POSIX creation modes are restrictive defaults, not Windows ACL isolation.
 */
export async function prepareResultOutput(
	outcome: RunOutcome,
	options: { cwd: string; agentDir?: string; limit?: number },
): Promise<{ text: string; truncated: boolean; total: number; fullOutputPath?: string }> {
	const limit = options.limit ?? INLINE_RESULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError("Result output limit must be a positive safe integer.");
	}
	const fullText = resultText(outcome);
	const total = fullText.length;
	if (total <= limit) return { text: fullText, truncated: false, total };

	// Match the runner's cwd grouping without importing its SDK session machinery.
	const safeCwd = `--${[...resolve(options.cwd)].map((char) =>
		(char === "/" || char === "\\" || char === ":") ? "-" : char,
	).join("").replace(/^-+/, "")}--`;
	const directory = join(resolve(options.agentDir ?? getAgentDir()), "subagent-results", safeCwd);
	const fullOutputPath = join(directory, `result-${randomUUID()}.txt`);
	// Keep failure/cancellation and the existence of cleanup warnings visible even
	// when a very small prefix cannot contain their full details.
	const notices: string[] = [];
	if (outcome.status === "failed") notices.push("Status: failed (error details in full output).");
	else if (outcome.status === "aborted") notices.push(`Status: aborted (${outcome.reason}).`);
	if (outcome.cleanupWarning !== undefined) notices.push("Cleanup warning present; see full output.");
	const suffix = `\n\n[Output truncated. ${notices.length ? `${notices.join(" ")} ` : ""}Full output: ${fullOutputPath}\nUse read with this absolute path for the complete text.]`;
	const prefixBudget = limit - suffix.length;
	const firstCharacterLength = fullText.codePointAt(0)! > 0xffff ? 2 : 1;
	if (prefixBudget < firstCharacterLength) {
		throw new RangeError(`Result output limit ${limit} is too small for the full-output path and read hint; use at least ${suffix.length + firstCharacterLength}.`);
	}
	let prefix = fullText.slice(0, prefixBudget);
	// Do not split an emoji/supplementary character at the inline boundary.
	const last = prefix.charCodeAt(prefix.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(fullOutputPath, fullText, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return { text: prefix + suffix, truncated: true, total, fullOutputPath };
}
