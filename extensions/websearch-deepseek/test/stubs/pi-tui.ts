export class Text {
	text: string;
	paddingX: number;
	paddingY: number;

	constructor(text: string, paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string) {
		this.text = text;
	}
}

export class Markdown {
	text: string;
	paddingX: number;
	paddingY: number;
	theme: unknown;

	constructor(text: string, paddingX = 0, paddingY = 0, theme?: unknown) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
	}

	setText(text: string) {
		this.text = text;
	}
}
