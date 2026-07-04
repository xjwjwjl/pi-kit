import { Text } from "./pi-tui.js";

export async function initTheme() {}

export function getSettingsListTheme() {
	return {};
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
}

function textResult(result: any) {
	return (result?.content ?? [])
		.filter((block: any) => block?.type === "text")
		.map((block: any) => block.text ?? "")
		.join("\n");
}

function reusableTextComponent(component: unknown, slot: string): Text {
	if (component === undefined) return new Text("", 0, 0);
	if (component instanceof Text) return component;
	throw new Error(`built-in ${slot} received incompatible lastComponent`);
}

function createToolDefinition(name: string) {
	return {
		name,
		description: `${name} stub`,
		inputSchema: {},
		renderShell: "default",
		async execute() {
			return { content: [] };
		},
		renderCall(args: any, theme: any, context: any) {
			const target = args?.command ?? args?.path ?? args?.file_path ?? "...";
			const component = reusableTextComponent(context?.lastComponent, `${name}.renderCall`);
			component.setText(`${theme?.bold ? theme.bold(name) : name} ${target}`);
			if (context?.state) context.state.renderCallCount = (context.state.renderCallCount ?? 0) + 1;
			return component;
		},
		renderResult(result: any, _options: any, _theme: any, context: any) {
			const component = reusableTextComponent(context?.lastComponent, `${name}.renderResult`);
			component.setText(textResult(result));
			if (context?.state) context.state.renderResultCount = (context.state.renderResultCount ?? 0) + 1;
			return component;
		},
	};
}

export function createBashToolDefinition(_cwd: string) {
	return createToolDefinition("bash");
}

export function createReadToolDefinition(_cwd: string) {
	return createToolDefinition("read");
}

export function createWriteToolDefinition(_cwd: string) {
	return createToolDefinition("write");
}

export function createEditToolDefinition(_cwd: string) {
	return createToolDefinition("edit");
}
