import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const MAX_PREVIEW_CHARACTERS = 4096;

export interface PreviewLine {
	text: string;
	code: boolean;
}

export interface PreviewLayout {
	lines: PreviewLine[];
	truncated: boolean;
}

/** Layout only a bounded excerpt, including for one enormous unbroken token. */
export function layoutPreview(source: string, width: number, maxLines: number): PreviewLayout {
	const limit = Math.max(0, Math.floor(maxLines));
	if (limit === 0) return { lines: [], truncated: source.length > 0 };
	const excerpt = source.slice(0, MAX_PREVIEW_CHARACTERS).replace(/[\uD800-\uDBFF]$/, "");
	const lines: PreviewLine[] = [];
	let truncated = excerpt.length < source.length;
	let inCode = false;
	outer: for (const raw of excerpt.replace(/\r/g, "").split("\n")) {
		if (raw.trimStart().startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		const wrapped = wrapTextWithAnsi(inCode ? `  ${raw}` : raw, Math.max(1, width));
		for (const text of wrapped.length ? wrapped : [""]) {
			if (lines.length === limit) {
				truncated = true;
				break outer;
			}
			lines.push({ text, code: inCode });
		}
	}
	return { lines, truncated };
}

/** Cache plain layout only: changing theme colors must not reuse styled strings. */
export class PreviewLayoutCache {
	private readonly entries = new WeakMap<object, {
		source: string;
		width: number;
		maxLines: number;
		layout: PreviewLayout;
	}>();

	get(option: { preview?: string }, width: number, maxLines: number): PreviewLayout {
		const source = option.preview || "";
		const cached = this.entries.get(option);
		if (cached?.source === source && cached.width === width && cached.maxLines === maxLines) return cached.layout;
		const layout = layoutPreview(source, width, maxLines);
		this.entries.set(option, { source, width, maxLines, layout });
		return layout;
	}
}
