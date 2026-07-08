import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";

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

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolve(cwd, rawPath);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}
