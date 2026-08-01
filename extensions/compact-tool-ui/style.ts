import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type ToolUiStatus = "pending" | "running" | "success" | "failed";

type ThemeToken = ThemeColor;

const TOOL_NAME_TOKENS: Record<string, ThemeToken> = {
	// Use stable semantic colors for tool labels.
	bash: "bashMode",
	read: "thinkingMinimal",
	write: "mdHeading",
	edit: "thinkingHigh",
};

const PARAM_TOKENS: Record<string, ThemeToken> = {
	// base
	group: "customMessageLabel",
	key: "muted",
	keyActive: "syntaxVariable",
	separator: "dim",
	required: "accent",
	optional: "dim",
	default: "dim",
	desc: "muted",
	invalid: "error",

	// values
	string: "syntaxString",
	number: "syntaxNumber",
	boolean: "syntaxKeyword",
	nullish: "dim",
	enum: "syntaxKeyword",
	type: "syntaxType",
	path: "mdLink",
	glob: "accent",
	url: "mdLink",
	query: "syntaxString",
	command: "syntaxFunction",
	flag: "accent",
	env: "syntaxType",
	secretLabel: "mdHeading",
	secretValue: "dim",

	// edit/diff-specific
	added: "toolDiffAdded",
	removed: "toolDiffRemoved",
	context: "toolDiffContext",
};

function capitalizeToolName(name: string): string {
	if (!name) return name;
	return `${name[0].toUpperCase()}${name.slice(1)}`;
}

export function toolNameText(name: string, theme: Theme): string {
	return theme.fg(TOOL_NAME_TOKENS[name] ?? "toolTitle", theme.bold(capitalizeToolName(name)));
}

export function paramText(kind: string, value: string, theme: Theme): string {
	return theme.fg(PARAM_TOKENS[kind] ?? "text", value);
}

export function separatorText(theme: Theme): string {
	return paramText("separator", " · ", theme);
}

export function metadataText(parts: Array<string | undefined>, theme: Theme): string {
	return parts.filter((part): part is string => Boolean(part)).map((part) => `${separatorText(theme)}${part}`).join("");
}

export function mutedMetadataText(parts: Array<string | undefined>, theme: Theme): string {
	const styledParts = parts.filter((part): part is string => Boolean(part)).map((part) => numericText(part, theme));
	return styledParts.length > 0 ? `${separatorText(theme)}${styledParts.join(separatorText(theme))}` : "";
}

export function readMetadataText(value: string | undefined, theme: Theme): string {
	return value ? `${paramText("separator", " · ", theme)}${numericText(value, theme)}` : "";
}

export function descText(value: string, theme: Theme): string {
	return paramText("desc", value, theme);
}

export function invalidText(value: string, theme: Theme): string {
	return paramText("invalid", value, theme);
}

export function numericText(value: string, theme: Theme): string {
	return value
		.split(/(\d+(?:\.\d+)?)/g)
		.map((part) => (/^\d/.test(part) ? paramText("number", part, theme) : descText(part, theme)))
		.join("");
}

export function countText(count: number, one: string, theme: Theme, many = `${one}s`): string {
	return `${paramText("number", String(count), theme)} ${descText(count === 1 ? one : many, theme)}`;
}

export function pathText(value: string, theme: Theme): string {
	return theme.fg("text", value);
}

export function readPathText(value: string, theme: Theme): string {
	if (!value || value === "...") return theme.fg("mdLink", value);
	const slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	if (slashIndex < 0) return theme.fg("mdLink", theme.bold(value));
	const dirname = value.slice(0, slashIndex + 1);
	const basename = value.slice(slashIndex + 1);
	return `${theme.fg("muted", dirname)}${theme.fg("mdLink", theme.bold(basename || dirname))}`;
}

export function writePathText(value: string, theme: Theme): string {
	return readPathText(value, theme);
}

export function editPathText(value: string, theme: Theme): string {
	return readPathText(value, theme);
}

export function editDiffStatText(value: string | undefined, theme: Theme): string | undefined {
	if (!value) return undefined;
	return value
		.split(/(\+\d+|-\d+)/g)
		.map((part) => {
			if (/^\+\d+$/.test(part)) return paramText("added", part, theme);
			if (/^-\d+$/.test(part)) return paramText("removed", part, theme);
			return descText(part, theme);
		})
		.join("");
}

export function commandNameText(value: string, theme: Theme): string {
	return theme.fg("syntaxFunction", value);
}

export function bashArgumentText(value: string, theme: Theme): string {
	return theme.fg("muted", value);
}

export function outputPreviewText(value: string, theme: Theme): string {
	return paramText("context", value, theme);
}
