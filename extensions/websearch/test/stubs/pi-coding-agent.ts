export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2_000;

export function defineTool(definition: unknown) {
	return definition;
}

export function getMarkdownTheme() {
	return {};
}

export function formatSize(bytes: number): string {
	return `${bytes}B`;
}

export function truncateHead(content: string, options?: { maxLines?: number; maxBytes?: number }) {
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
	const lines = content.split("\n");
	const output: string[] = [];
	let outputBytes = 0;

	for (const line of lines) {
		const candidate = output.length === 0 ? line : `\n${line}`;
		const candidateBytes = Buffer.byteLength(candidate);
		if (output.length >= maxLines || outputBytes + candidateBytes > maxBytes) break;
		output.push(line);
		outputBytes += candidateBytes;
	}

	const totalBytes = Buffer.byteLength(content);
	return {
		content: output.join("\n"),
		truncated: output.join("\n") !== content,
		truncatedBy: output.length >= maxLines ? "lines" : "bytes",
		totalLines: lines.length,
		totalBytes,
		outputLines: output.length,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: output.length === 0 && content.length > 0,
		maxLines,
		maxBytes,
	};
}
