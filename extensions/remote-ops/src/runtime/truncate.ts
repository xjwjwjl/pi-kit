export interface TruncatedText {
	text: string;
	truncated: boolean;
	omittedLines?: number;
	omittedBytes?: number;
}

/**
 * Truncate command output to the last maxLines lines and maxBytes bytes.
 * When truncation occurs, a visible notice is placed at both the top and
 * bottom of the output.
 */
export function truncateCommandOutput(value: string, maxBytes = 50 * 1024, maxLines = 2_000): TruncatedText {
	const originalLines = value.split(/\r?\n/).length;

	const lines = value.split(/\r?\n/);
	const selectedLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
	let text = selectedLines.join("\n");

	let truncated = selectedLines.length !== lines.length;
	const omittedLines = truncated ? lines.length - selectedLines.length : undefined;
	const originalBytes = Buffer.byteLength(value, "utf8");

	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		const buffer = Buffer.from(text, "utf8");
		text = buffer.subarray(buffer.length - maxBytes).toString("utf8");
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		truncated = true;
	}

	const omittedBytes = truncated ? originalBytes - Buffer.byteLength(text, "utf8") : undefined;

	if (truncated) {
		const details = [
			omittedLines ? `${omittedLines.toLocaleString()} lines` : "",
			omittedBytes ? `${formatByteSize(omittedBytes)}` : "",
		].filter(Boolean).join(", ");
		const notice = `── [truncated: ${details} omitted]`;
		text = `${notice}\n${text}\n${notice}`;
	}

	return { text, truncated, omittedLines, omittedBytes };
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1048576) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / 1048576).toFixed(1)}MB`;
}
