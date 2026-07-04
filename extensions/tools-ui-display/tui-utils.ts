import { Container, Text } from "@earendil-works/pi-tui";

export {
	countLines,
	firstNonEmptyLine,
	formatDuration,
	imageBlocks,
	plural,
	shortPath,
	stripAnsi,
	textBlocks,
	trimTrailingEmptyLines,
} from "./core-utils.js";

export function emptyComponent() {
	return new Container();
}

export function setText(component: Text, content: string) {
	component.setText(content);
	return component;
}
