/**
 * Minimal stand-ins for the @earendil-works/pi-tui components used by the
 * launcher panel. Only loaded by the test suite (see test/pi-loader.ts):
 * at runtime pi provides the real implementations.
 */

export class Container {
	children: any[] = [];
	addChild(child: any): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
	invalidate(): void {}
}

export class Text {
	private readonly text: string;
	constructor(text: string, _top?: number, _left?: number) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

export class Spacer {
	constructor(_lines: number) {}
	render(): string[] {
		return [""];
	}
	invalidate(): void {}
}

export class SelectList {
	onSelect?: (item: any) => void;
	onCancel?: () => void;
	selectedIndex = 0;
	readonly items: any[];
	constructor(items: any[], _height: number, _theme: any) {
		this.items = items;
	}
	setSelectedIndex(index: number): void {
		this.selectedIndex = index;
	}
	handleInput(data: string): void {
		// Test protocol: escape cancels (the real SelectList owns its keys).
		if (data === "\u001b") this.onCancel?.();
	}
	render(): string[] {
		return this.items.map((item) => item.label);
	}
	invalidate(): void {}
}

export function truncateToWidth(text: string, _width: number): string {
	return text;
}
