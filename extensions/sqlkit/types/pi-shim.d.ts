declare module "@earendil-works/pi-tui" {
	export class Input {
		focused: boolean;
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		getValue(): string;
		setValue(value: string): void;
		handleInput(data: string): void;
		invalidate(): void;
		render(width: number): string[];
	}

	export function matchesKey(data: string, key: unknown): boolean;

	export const Key: {
		readonly up: unknown;
		readonly down: unknown;
		readonly left: unknown;
		readonly right: unknown;
		readonly enter: unknown;
		readonly escape: unknown;
		readonly tab: unknown;
		readonly backspace: unknown;
		readonly delete: unknown;
		readonly home: unknown;
		readonly end: unknown;
		readonly space: unknown;
		ctrl(key: string): unknown;
		shift(key: string): unknown;
		alt(key: string): unknown;
		ctrlShift(key: string): unknown;
	};

	export function truncateToWidth(text: string, width: number, ellipsis?: string, pad?: boolean): string;
}

declare module "@earendil-works/pi-coding-agent" {
	export type ToolUpdate = {
		content?: Array<{ type: "text"; text: string }>;
	};

	export type ExtensionContextLike = {
		cwd?: string;
		ui: {
			setStatus(id: string, text: string): void;
			setEditorText(text: string): void;
			notify(message: string, level?: "info" | "warning" | "error"): void;
			confirm?(title: string, message: string): Promise<boolean> | boolean;
		};
	};

	export type ExtensionEventContext = {
		messages: unknown[];
	};

	export type ToolInfoLike = {
		name: string;
		description: string;
		parameters: unknown;
		promptGuidelines?: string[];
		sourceInfo?: unknown;
	};

	export type SessionStartEventLike = {
		reason?: string;
		previousSessionFile?: string;
	};

	export type BeforeAgentStartEventLike = {
		prompt?: string;
		images?: unknown[];
		systemPrompt: string;
		systemPromptOptions?: {
			selectedTools?: unknown[];
		};
	};

	export type BeforeProviderRequestEventLike = {
		payload: Record<string, unknown>;
	};

	export type InputEventLike = {
		text: string;
		images?: unknown[];
		source?: "interactive" | "rpc" | "extension";
		streamingBehavior?: "steer" | "followUp";
	};

	export type ToolCallEventLike = {
		toolName: string;
		toolCallId?: string;
		input: unknown;
	};

	export type RenderComponentLike = {
		render(width: number): string[];
		invalidate(): void;
		handleInput?(data: string): void;
	};

	export type RegisterToolDefinition = {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		renderShell?: "self";
		renderCall?(args: unknown, theme: unknown, context: unknown): RenderComponentLike;
		renderResult?(result: { content?: unknown; details?: unknown; isError?: boolean }, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown, context: unknown): RenderComponentLike;
		execute(
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: (update: ToolUpdate) => void,
			ctx?: ExtensionContextLike,
		): Promise<unknown>;
	};

	export type ExtensionAPI = {
		registerTool(definition: RegisterToolDefinition): void;
		registerCommand(name: string, definition: { description?: string; handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void }): void;
		on(event: "context", handler: (event: ExtensionEventContext) => Promise<{ messages: unknown[] }> | { messages: unknown[] }): void;
		on(event: "input", handler: (event: InputEventLike, ctx: ExtensionContextLike) => Promise<{ action: "continue" | "handled" | "transform"; text?: string } | void> | { action: "continue" | "handled" | "transform"; text?: string } | void): void;
		on(event: "tool_call", handler: (event: ToolCallEventLike, ctx: ExtensionContextLike) => Promise<{ block: true; reason?: string } | void> | { block: true; reason?: string } | void): void;
		on(event: "session_start", handler: (event: SessionStartEventLike, ctx: ExtensionContextLike) => Promise<void> | void): void;
		on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void): void;
		on(event: "before_agent_start", handler: (event: BeforeAgentStartEventLike, ctx: ExtensionContextLike) => Promise<{ systemPrompt?: string } | void> | { systemPrompt?: string } | void): void;
		on(event: "before_provider_request", handler: (event: BeforeProviderRequestEventLike, ctx: ExtensionContextLike) => Promise<void> | void): void;
		getActiveTools(): string[];
		getAllTools(): ToolInfoLike[];
		setActiveTools(names: string[]): void;
	};
}
