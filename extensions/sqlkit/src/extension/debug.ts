import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type DebugEvent =
	| "extension_loaded"
	| "session_start"
	| "before_agent_start"
	| "before_provider_request";

type ToolLike = {
	name?: unknown;
	sourceInfo?: unknown;
};

type ProviderPayloadLike = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Prefer SQLKIT_* env vars; fall back to legacy SQL_MCP_* names for continuity.
function debugLogEnv(): string | undefined {
	return asNonEmptyString(process.env.SQLKIT_DEBUG_LOG) ?? asNonEmptyString(process.env.SQL_MCP_DEBUG_LOG);
}

function isDebugEnabled(): boolean {
	if (debugLogEnv()) return true;
	const value = (process.env.SQLKIT_DEBUG ?? process.env.SQL_MCP_DEBUG ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveDebugLogPath(cwd?: string): string | undefined {
	const explicit = debugLogEnv();
	if (explicit) {
		return path.isAbsolute(explicit) ? explicit : path.resolve(cwd ?? process.cwd(), explicit);
	}
	if (!isDebugEnabled()) return undefined;
	return path.join(cwd ?? process.cwd(), ".pi", "sqlkit-debug.ndjson");
}

function summarizeToolNames(tools: Array<string | ToolLike>): Array<Record<string, unknown>> {
	return tools.map((tool) => {
		if (typeof tool === "string") {
			return { name: tool };
		}

		const sourceInfo = isRecord(tool.sourceInfo) ? tool.sourceInfo : undefined;
		return {
			name: asNonEmptyString(tool.name) ?? "<unknown>",
			source: asNonEmptyString(sourceInfo?.source),
			scope: asNonEmptyString(sourceInfo?.scope),
			origin: asNonEmptyString(sourceInfo?.origin),
			path: asNonEmptyString(sourceInfo?.path),
		};
	});
}

function summarizeSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!isRecord(schema)) return undefined;

	const properties = isRecord(schema.properties) ? Object.keys(schema.properties).slice(0, 20) : undefined;
	const required = Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string").slice(0, 20)
		: undefined;

	return {
		type: asNonEmptyString(schema.type),
		properties,
		required,
		additionalProperties: schema.additionalProperties,
	};
}

function summarizeProviderTool(tool: unknown): Record<string, unknown> {
	if (!isRecord(tool)) {
		return { value_type: typeof tool };
	}

	const nestedFunction = isRecord(tool.function) ? tool.function : undefined;
	const parameters =
		tool.parameters ?? tool.input_schema ?? (nestedFunction ? nestedFunction.parameters ?? nestedFunction.input_schema : undefined);

	return {
		type: asNonEmptyString(tool.type),
		name: asNonEmptyString(tool.name) ?? asNonEmptyString(nestedFunction?.name),
		has_description: asNonEmptyString(tool.description) != null || asNonEmptyString(nestedFunction?.description) != null,
		keys: Object.keys(tool).slice(0, 12),
		parameters: summarizeSchema(parameters),
	};
}

function summarizeProviderPayload(payload: ProviderPayloadLike): Record<string, unknown> {
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	return {
		payload_keys: Object.keys(payload).slice(0, 20),
		model: asNonEmptyString(payload.model),
		tool_choice: payload.tool_choice ?? payload.toolChoice,
		parallel_tool_calls: payload.parallel_tool_calls,
		tools_count: tools.length,
		tools: tools.slice(0, 50).map(summarizeProviderTool),
	};
}

function writeDebugEntry(cwd: string | undefined, event: DebugEvent, data: Record<string, unknown>): void {
	const logPath = resolveDebugLogPath(cwd);
	if (!logPath) return;

	try {
		mkdirSync(path.dirname(logPath), { recursive: true });
		appendFileSync(
			logPath,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				pid: process.pid,
				event,
				...data,
			})}\n`,
			"utf8",
		);
	} catch {
		// Debug logging must never break the extension.
	}
}

export function logExtensionLoaded(registeredToolNames: string[]): void {
	writeDebugEntry(process.cwd(), "extension_loaded", {
		cwd: process.cwd(),
		registered_tools: registeredToolNames,
	});
}

export function logSessionStart(
	cwd: string | undefined,
	reason: string | undefined,
	allTools: Array<ToolLike>,
	activeTools: string[],
): void {
	writeDebugEntry(cwd, "session_start", {
		cwd,
		reason,
		all_tools: summarizeToolNames(allTools),
		active_tools: activeTools,
	});
}

export function logBeforeAgentStart(
	cwd: string | undefined,
	activeTools: string[],
	selectedTools: Array<string | ToolLike> | undefined,
): void {
	writeDebugEntry(cwd, "before_agent_start", {
		cwd,
		active_tools: activeTools,
		selected_tools: selectedTools ? summarizeToolNames(selectedTools) : undefined,
	});
}

export function logBeforeProviderRequest(cwd: string | undefined, payload: unknown): void {
	writeDebugEntry(
		cwd,
		"before_provider_request",
		isRecord(payload) ? summarizeProviderPayload(payload) : { payload_type: typeof payload },
	);
}

