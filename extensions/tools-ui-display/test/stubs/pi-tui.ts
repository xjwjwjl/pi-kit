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

export function visibleWidth(text: string): number {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length;
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
