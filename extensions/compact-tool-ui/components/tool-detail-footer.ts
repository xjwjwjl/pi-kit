import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

const OSC8_SEQUENCE = /\x1b]8;[^;]*;([\s\S]*?)(\x07|\x1b\\)/g;

function closeOpenOsc8Hyperlink(text: string): string {
	let activeTerminator: string | undefined;
	for (const match of text.matchAll(OSC8_SEQUENCE)) activeTerminator = match[1] ? match[2] : undefined;
	return activeTerminator ? `${text}\x1b]8;;${activeTerminator}` : text;
}

function truncateAnsiText(text: string, width: number): string {
	return closeOpenOsc8Hyperlink(truncateToWidth(text, width));
}

/** Width-aware footer for expanded tool detail rails. */
export class ToolDetailFooter implements Component {
	private text = "";

	setText(text: string) {
		this.text = text;
	}

	invalidate() {}

	render(width: number): string[] {
		if (!this.text || width <= 0) return [];
		return [truncateAnsiText(this.text, width)];
	}
}
