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
	children: unknown[] = [];
	addChild(component: unknown, _x?: number, _y?: number) {
		this.children.push(component);
	}
	invalidate() {}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render?: (w: number) => string[] }).render?.(width) ?? []);
	}
}

export type SettingItem = {
	id: string;
	label: string;
	description?: string;
	currentValue?: string;
	values?: string[];
};

/** Test double that mirrors pi-tui's activation: cycle to the next value and report the change. */
export class SettingsList {
	static instances: SettingsList[] = [];
	items: SettingItem[];
	private onChange: (id: string, newValue: string) => void;
	constructor(items: SettingItem[], _maxVisible: number, _theme: unknown, onChange: (id: string, newValue: string) => void, _onCancel: () => void, _options?: unknown) {
		this.items = items;
		this.onChange = onChange;
		SettingsList.instances.push(this);
	}
	updateValue(id: string, newValue: string) {
		const item = this.items.find((candidate) => candidate.id === id);
		if (item) item.currentValue = newValue;
	}
	handleInput(_data: string) {}
	render(_width: number): string[] {
		return this.items.map((item) => `${item.label}  ${item.currentValue ?? ""}`);
	}
	/** Test helper: activate an item the way pi-tui does when Enter or Space is pressed. */
	activate(id: string) {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item?.values || item.values.length === 0) return;
		const index = item.values.indexOf(item.currentValue ?? "");
		const next = item.values[(index + 1) % item.values.length];
		if (next === undefined) return;
		item.currentValue = next;
		this.onChange(item.id, next);
	}
}

export type Component = {
	render(width: number): string[];
};

const SELECT_KEY_SEQUENCES: Record<string, string[]> = {
	"tui.select.up": ["\x1b[A"],
	"tui.select.down": ["\x1b[B"],
	"tui.select.pageUp": ["\x1b[5~"],
	"tui.select.pageDown": ["\x1b[6~"],
	"tui.select.confirm": ["\r", "\n"],
	"tui.select.cancel": ["\x1b", "\x03"],
};

const KEY_SEQUENCES: Record<string, string[]> = {
	up: ["\x1b[A"],
	down: ["\x1b[B"],
	left: ["\x1b[D"],
	right: ["\x1b[C"],
	backspace: ["\x7f", "\b"],
	delete: ["\x1b[3~"],
	tab: ["\t"],
	enter: ["\r"],
	escape: ["\x1b"],
};

/** Test double for pi-tui's keybinding lookup, limited to the select bindings used here. */
export function getKeybindings() {
	return {
		matches(data: string, binding: string) {
			return SELECT_KEY_SEQUENCES[binding]?.includes(data) ?? false;
		},
	};
}

/** Test double for pi-tui's key matcher, limited to the keys the panel intercepts. */
export function matchesKey(data: string, keyId: string) {
	return KEY_SEQUENCES[keyId]?.includes(data) ?? false;
}

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
