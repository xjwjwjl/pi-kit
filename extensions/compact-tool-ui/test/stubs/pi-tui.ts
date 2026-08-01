export class Text {
	private text: string;
	constructor(text = "", _x = 0, _y = 0) {
		this.text = text;
	}
	setText(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		return wrapTextWithAnsi(this.text, width);
	}
}

export class Container {
	addChild(_component: unknown, _x?: number, _y?: number) {}
	invalidate() {}
	render(_width: number): string[] {
		return [];
	}
}

export class SettingsList {
	constructor(..._args: unknown[]) {}
	handleInput(_data: string) {}
	render(_width: number): string[] {
		return [];
	}
}

export type SettingItem = {
	id: string;
	label: string;
	description?: string;
	currentValue?: string;
	values?: string[];
};

export type Component = {
	render(width: number): string[];
};

const CSI_SEQUENCE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const OSC_SEQUENCE = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/;

function ansiSequenceAt(text: string, index: number): string | undefined {
	return text.slice(index).match(CSI_SEQUENCE)?.[0] ?? text.slice(index).match(OSC_SEQUENCE)?.[0];
}

function stripTerminalCodes(text: string): string {
	let stripped = "";
	for (let index = 0; index < text.length; ) {
		const ansi = ansiSequenceAt(text, index);
		if (ansi) {
			index += ansi.length;
			continue;
		}
		stripped += text[index] ?? "";
		index++;
	}
	return stripped;
}

export function visibleWidth(text: string): number {
	return stripTerminalCodes(text).length;
}

let capabilities = { images: null, trueColor: true, hyperlinks: false };

export function getCapabilities() {
	return capabilities;
}

export function setCapabilities(next: Partial<typeof capabilities>) {
	capabilities = { ...capabilities, ...next };
}

export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function sliceByColumn(text: string, startColumn: number, length: number): string {
	if (length <= 0) return "";
	return Array.from(stripTerminalCodes(text)).slice(startColumn, startColumn + length).join("");
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return pad ? `${text}${" ".repeat(maxWidth - visibleWidth(text))}` : text;

	const ellipsisWidth = visibleWidth(ellipsis);
	const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
	let result = "";
	let width = 0;
	for (let index = 0; index < text.length; ) {
		const ansi = ansiSequenceAt(text, index);
		if (ansi) {
			result += ansi;
			index += ansi.length;
			continue;
		}
		if (width >= targetWidth) break;
		result += text[index] ?? "";
		width++;
		index++;
	}

	const truncated = `${result}${ellipsis}`;
	return pad ? `${truncated}${" ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)))}` : truncated;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (width <= 0) return [];
	if (text.length === 0) return [""];
	const lines: string[] = [];
	for (const logicalLine of text.split("\n")) {
		if (logicalLine.length === 0) {
			lines.push("");
			continue;
		}
		for (let i = 0; i < logicalLine.length; i += width) {
			lines.push(logicalLine.slice(i, i + width));
		}
	}
	return lines;
}
