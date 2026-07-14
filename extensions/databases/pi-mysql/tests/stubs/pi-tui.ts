export class Text {
	private text: string;
	constructor(text = "", _x = 0, _y = 0) {
		this.text = text;
	}
	setText(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.text.length === 0) return [""];
		const lines: string[] = [];
		for (const logicalLine of this.text.split("\n")) {
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
}
