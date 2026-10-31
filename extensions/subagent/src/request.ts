import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { discoverAgents, findAgent, formatAgentDiagnostics, formatAgentList, type AgentConfig, type AgentDiagnostic } from "./agents.ts";
import { renderParentContext } from "./parent-context.ts";
import type { RunOnceOptions, ThinkingLevel } from "./runner.ts";
import { resolveToolSelection, type ToolSelection } from "./tool-selection.ts";

export interface AgentRequest {
	description: string;
	prompt: string;
	subagent_type?: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	max_turns?: number;
	inherit_context?: boolean;
}

export function resolveModel(
	ctx: ExtensionContext, explicit: string | undefined, fromDefinition: string | undefined, source?: string,
): Model<string> | undefined {
	const spec = explicit ?? fromDefinition;
	if (!spec) return ctx.model;
	const suffix = source ? ` (${source})` : "";
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) {
		throw new Error(`Invalid model "${spec}"${suffix}: expected "provider/modelId". Omit model to inherit the parent model.`);
	}
	const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) as Model<string> | undefined;
	if (!model) {
		throw new Error(`Unknown model "${spec}"${suffix}: it is not available in this session. ` +
			"Omit model to inherit the parent model, or pass a provider/modelId available in /model.");
	}
	return model;
}

/** The SDK's thinking-level vocabulary; validated here so a typo cannot silently become "off". */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function resolveThinking(params: AgentRequest, definition: AgentConfig | undefined): ThinkingLevel | undefined {
	const raw = params.thinking ?? definition?.thinking;
	if (raw === undefined) return undefined;
	const level = raw.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		const origin = params.thinking !== undefined
			? ""
			: ` in agent definition "${definition?.name}" at ${definition?.filePath}`;
		throw new Error(`Invalid thinking level "${raw}"${origin}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	return level as ThinkingLevel;
}

/** Resolve policy before entering the execution queue, without loading untrusted definitions. */
export function resolveRequest(
	pi: ExtensionAPI, ctx: ExtensionContext, params: AgentRequest, signal?: AbortSignal,
	resolveTools: typeof resolveToolSelection = resolveToolSelection,
): RunOnceOptions {
	const trusted = ctx.isProjectTrusted();
	const diagnostics: AgentDiagnostic[] = [];
	const available = discoverAgents(ctx.cwd, trusted ? "both" : "user", diagnostics);
	const definition = params.subagent_type ? findAgent(available, params.subagent_type) : undefined;
	if (params.subagent_type && !definition) {
		const listed = available.map((agent) => agent.name).join(", ") || "none — define one in ~/.pi/agent/agents/";
		const note = trusted ? "" : " Project agents in .pi/agents/ require a trusted project.";
		const ignored = formatAgentDiagnostics(diagnostics);
		throw new Error(`Unknown agent type "${params.subagent_type}". Available: ${listed}.${note}` +
			(ignored ? ` Ignored definitions: ${ignored}.` : ""));
	}

	let selection: ToolSelection = { extensionPaths: [], tools: definition?.tools };
	// Explicit [] must reach the policy as no tools, not turn back into SDK defaults.
	if (params.tools?.length || definition?.tools !== undefined) {
		selection = resolveTools({
			requested: params.tools ?? [], definitionTools: definition?.tools,
			disallowedTools: definition?.disallowedTools, allTools: pi.getAllTools(), mcpServers: pi.getMcpServers(), trusted,
			loadDefinitionTools: true, definitionPath: definition?.filePath,
		});
	}
	const definitionSource = definition ? `agent definition "${definition.name}" at ${definition.filePath}` : undefined;
	const modelSource = params.model === undefined && definition?.model !== undefined ? definitionSource : undefined;
	return {
		cwd: ctx.cwd, modelRegistry: ctx.modelRegistry,
		agentName: definition?.name ?? "general-purpose",
		agentSource: definition?.source ?? "built-in",
		model: resolveModel(ctx, params.model, definition?.model, modelSource),
		thinkingLevel: resolveThinking(params, definition), maxTurns: params.max_turns ?? definition?.maxTurns,
		tools: selection.tools, excludeTools: definition?.disallowedTools, extensionPaths: selection.extensionPaths,
		coreOverrides: selection.coreOverrides, mcpServers: selection.mcpServers,
		systemPrompt: definition?.systemPrompt, trusted, signal,
		prompt: params.inherit_context
			? renderParentContext(ctx.sessionManager.buildContextEntries()) + params.prompt
			: params.prompt,
	};
}

/** Registration cannot decide project trust, so advertise user definitions only. */
export function agentRosterLine(cwd = process.cwd()): string {
	try {
		const listed = formatAgentList(discoverAgents(cwd, "user"), 12);
		return `${listed}\nProject agents in \`.pi/agents/\` are available in trusted projects and can be passed by name as \`subagent_type\`.`;
	} catch {
		return "none — omit subagent_type for a general-purpose agent";
	}
}
