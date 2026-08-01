import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ELLIPSIS = "…";
const PREFERRED_MIN_BODY_WIDTH = 24;
const OSC8_SEQUENCE = /\x1b]8;[^;]*;([\s\S]*?)(\x07|\x1b\\)/g;

function closeOpenOsc8Hyperlink(text: string): string {
	let activeTerminator: string | undefined;
	for (const match of text.matchAll(OSC8_SEQUENCE)) {
		activeTerminator = match[1] ? match[2] : undefined;
	}
	return activeTerminator ? `${text}\x1b]8;;${activeTerminator}` : text;
}

function truncateAnsiText(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
	return closeOpenOsc8Hyperlink(truncateToWidth(text, maxWidth, ellipsis));
}

export type CompactToolRowSuffixCandidate = string | { text: string; fallback?: boolean };

type NormalizedSuffixCandidate = {
	text: string;
	fallback: boolean;
};

function normalizeSuffixCandidates(values: CompactToolRowSuffixCandidate[]): NormalizedSuffixCandidate[] {
	const candidates: NormalizedSuffixCandidate[] = [];
	for (const value of values) {
		const candidate = typeof value === "string" ? { text: value, fallback: false } : { text: value.text, fallback: value.fallback === true };
		if (!candidate.text) continue;
		const existing = candidates.find((item) => item.text === candidate.text);
		if (existing) {
			existing.fallback ||= candidate.fallback;
			continue;
		}
		candidates.push(candidate);
	}
	return candidates;
}

/**
 * Compact single-line-first tool row.
 *
 * The prefix is stable (`✓ Bash `), the body is the primary target/command,
 * and suffix candidates are metadata variants ordered from richest to leanest.
 * On narrow widths, the row preserves the configured fallback suffix and
 * truncates the body first to avoid sticky/wrapped status rows.
 */
export class CompactToolRow implements Component {
	private prefix = "";
	private body = "";
	private suffix = "";
	private suffixCandidates: NormalizedSuffixCandidate[] = [];

	setParts(prefix: string, body: string, suffix = "", suffixCandidates: CompactToolRowSuffixCandidate[] = []) {
		this.prefix = prefix;
		this.body = body;
		this.suffix = suffix;
		this.suffixCandidates = normalizeSuffixCandidates(suffixCandidates);
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0 || (!this.prefix && !this.body && !this.suffix)) return [];

		const fullText = `${this.prefix}${this.body}${this.suffix}`;
		const prefixWidth = visibleWidth(this.prefix);
		if (prefixWidth >= width) {
			return wrapTextWithAnsi(fullText, width);
		}

		const bodyWidth = Math.max(1, width - prefixWidth);
		const suffixes = this.suffixCandidates.length > 0 ? this.suffixCandidates : normalizeSuffixCandidates(this.suffix ? [this.suffix] : []);
		if (suffixes.length === 0 && !this.body.includes("\n")) {
			return [`${this.prefix}${truncateAnsiText(this.body, bodyWidth)}`];
		}
		if (suffixes.length > 0 && !this.body.includes("\n") && suffixes.every((suffix) => !suffix.text.includes("\n"))) {
			const preferredBodyWidth = Math.min(visibleWidth(this.body), PREFERRED_MIN_BODY_WIDTH);
			const fallbackIndex = suffixes.findIndex((suffix) => suffix.fallback);
			const selectableSuffixes = fallbackIndex >= 0 ? suffixes.slice(0, fallbackIndex + 1) : suffixes;
			let selectedSuffix = (fallbackIndex >= 0 ? suffixes[fallbackIndex]?.text : suffixes[suffixes.length - 1]?.text) ?? "";

			for (const candidate of selectableSuffixes) {
				const suffix = candidate.text;
				const fullBody = `${this.body}${suffix}`;
				if (visibleWidth(fullBody) <= bodyWidth) return [`${this.prefix}${fullBody}`];
				if (bodyWidth - visibleWidth(suffix) >= preferredBodyWidth) {
					selectedSuffix = suffix;
					break;
				}
			}

			const minimumBodyWidth = this.body ? 1 : 0;
			const suffixBudget = Math.max(0, bodyWidth - minimumBodyWidth);
			const renderedSuffix = truncateAnsiText(selectedSuffix, suffixBudget);
			const renderedSuffixWidth = visibleWidth(renderedSuffix);
			const bodyBudget = Math.max(minimumBodyWidth, bodyWidth - renderedSuffixWidth);
			const renderedBody = bodyBudget > 0 ? truncateAnsiText(this.body, bodyBudget) : "";
			return [`${this.prefix}${renderedBody}${renderedSuffix}`];
		}

		const continuationPrefix = " ".repeat(prefixWidth);
		const logicalLines = `${this.body}${this.suffix}`.split("\n");
		const lines: string[] = [];

		for (const logicalLine of logicalLines) {
			for (const line of wrapTextWithAnsi(logicalLine, bodyWidth)) {
				lines.push(`${lines.length === 0 ? this.prefix : continuationPrefix}${line}`);
			}
		}

		return lines.length > 0 ? lines : [this.prefix];
	}
}
