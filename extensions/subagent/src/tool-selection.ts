/**
 * tool-selection.ts — resolve the `tools` a parent asks a child to have.
 *
 * The model knows tool names, not extension paths: it sees its own tool list.
 * `pi.getAllTools()` carries the missing half — each tool's `sourceInfo` names
 * the extension that registered it — so a request like `["lark_doc"]` becomes
 * one `additionalExtensionPaths` entry plus a child tool allowlist.
 *
 * Kept free of any `ExtensionAPI` dependency so it can be unit-tested. The core
 * tool list is read from the SDK's exported `create*ToolDefinition` factories.
 */

import * as pi from "@earendil-works/pi-coding-agent";
import type { RegisteredMcpServer, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_BUILTIN_EXTENSIONS } from "./builtin-extensions.ts";
import { childExcludedTools, SUBAGENT_TOOLS } from "./child-policy.ts";
import { MCP_RESOURCE_TOOLS } from "./tool-policy.ts";

/**
 * Pi's own tool names. They are always available in a child and have synthetic
 * `builtin:<name>` source paths that must never be passed to the loader as
 * extension sources.
 *
 * Derived from the SDK's `create<Name>ToolDefinition` exports, following the
 * SDK's own export naming convention, so a new core tool is picked up
 * automatically. The test asserts the known names, so a rename fails loudly at
 * upgrade time instead of silently treating a core tool as a built-in extension.
 */
export const CORE_BUILTIN_TOOLS: readonly string[] = Object.entries(pi)
	.filter(([name, value]) => /^create\w+ToolDefinition$/.test(name) && typeof value === "function")
	.map(([, create]) => (create as (cwd: string) => { name: string })(".").name);

const CORE = new Set<string>(CORE_BUILTIN_TOOLS);

export interface ToolSelectionRequest {
	/** Tool names the parent asked for. Duplicates and blanks are ignored. */
	requested: readonly string[];
	/** The parent's registry, from `pi.getAllTools()`. */
	allTools: readonly ToolInfo[];
	/** Dynamic server registrations from `pi.getMcpServers()`, not file configuration. */
	mcpServers?: readonly RegisteredMcpServer[];
	/** Whether the project is trusted, which gates project-scoped extensions. */
	trusted: boolean;
	/**
	 * The definition's own allowlist, if it has one.
	 *
	 * `undefined` means the definition has no allowlist, so the child keeps Pi's
	 * defaults. `[]` is an allowlist that happens to be empty: the definition
	 * asked for no tools, and the child must get none.
	 */
	definitionTools?: readonly string[];
	/** The definition's denylist. A requested tool here is a policy conflict. */
	disallowedTools?: readonly string[];
	/**
	 * Resolve the definition's own plain tool names to extension paths too.
	 *
	 * A definition's allowlist names tools the child must have, but `noExtensions`
	 * means the extensions that register them are not loaded unless the parent
	 * asks. With this flag the definition can carry its own tools (`tools:
	 * ["lark_doc"]`) without a parent `tools` request. Only the paths are added;
	 * the definition's selection stays exactly what its author wrote.
	 */
	loadDefinitionTools?: boolean;
	/** Used to annotate errors that come from the definition's own tools, not the caller's request. */
	definitionPath?: string;
}

export interface CoreToolOverride {
	name: string;
	path: string;
}

export interface ToolSelection {
	/** Extensions to load in the child, deduplicated, in request order. */
	extensionPaths: string[];
	/** Explicit core names that the parent expects a loaded extension to replace. */
	coreOverrides?: CoreToolOverride[];
	/** Snapshots of dynamic servers needed by the selected MCP tools. */
	mcpServers?: RegisteredMcpServer[];
	/**
	 * The child's `tools` option: a plain allowlist, or `+name` modifiers when
	 * the definition has no allowlist. `[]` is a plain allowlist with nothing in
	 * it — the child gets no tools. Undefined leaves the child's defaults.
	 */
	tools?: string[];
}

/** `+name` / `-name`, which Pi applies on top of the default tool set. */
function isModifier(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

function excludedMessage(name: string): string {
	if (name === "ask_user") return 'Tool "ask_user" cannot be given to a child: there is no user to ask.';
	if ((SUBAGENT_TOOLS as readonly string[]).includes(name)) {
		return `Tool "${name}" cannot be given to a child: subagents cannot spawn or message other agents.`;
	}
	return `Tool "${name}" is excluded from child sessions by PI_SUBAGENT_EXCLUDED_TOOLS.`;
}

/** Pi's `toolPatternRegExp` escapes exactly these characters. */
function escapeRegExp(text: string): string {
	return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a tool name against one `disallowed_tools` entry.
 *
 * This mirrors Pi's `createToolNameMatcher` / `toolPatternRegExp`
 * (`dist/core/mcp-servers.js`): an entry is either an exact tool name or a
 * pattern in which every `*` becomes `.*` and the remaining text is escaped,
 * anchored at both ends. That is the whole supported syntax — there is no `?`,
 * character class, or alternation. Anything broader here would approve a tool
 * that the child's `excludeTools` then removes.
 */
function matchesToolPattern(name: string, pattern: string): boolean {
	if (!pattern.includes("*")) return name === pattern;
	const source = pattern.split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/** The first `disallowed_tools` entry that excludes `name`, if any. */
function disallowedPattern(name: string, patterns: readonly string[]): string | undefined {
	return patterns.find((pattern) => matchesToolPattern(name, pattern));
}

/** The `builtin:<name>` name of a tool's built-in extension source. */
function builtinExtensionName(name: string, path: string): string {
	if (!path.startsWith("builtin:")) {
		throw new Error(
			`Tool "${name}" reports a built-in source but its path "${path}" is not a builtin:<name> path.`,
		);
	}
	return path.slice("builtin:".length);
}

/** Everything a name has to be checked against, shared by both name sources. */
interface ResolveContext {
	all: ReadonlyMap<string, ToolInfo>;
	disallowed: readonly string[];
	trusted: boolean;
	selfPath: string | undefined;
	definitionPath?: string;
}

/**
 * Validate one tool name and return the extension path a child must load.
 *
 * `undefined` means the tool is a core built-in the child already has. Every
 * rejection is a thrown `Error` with a model-readable reason.
 */
function extensionPathFor(name: string, context: ResolveContext): string | undefined {
	if (childExcludedTools().includes(name)) {
		throw new Error(excludedMessage(name));
	}

	const denied = disallowedPattern(name, context.disallowed);
	if (denied !== undefined) {
		throw new Error(
			denied === name
				? `Tool "${name}" is excluded by the agent definition's disallowed_tools.`
				: `Tool "${name}" is excluded by the agent definition's disallowed_tools pattern "${denied}".`,
		);
	}

	const tool = context.all.get(name);
	if (!tool) {
		const excluded = new Set(childExcludedTools());
		const available = [...context.all.keys()].filter((candidate) => !excluded.has(candidate)).sort();
		const shown = available.slice(0, 20);
		const suffix = shown.length > 0
			? ` Available tools: ${shown.join(", ")}${available.length > shown.length ? ", …" : ""}.`
			: " No tools are registered in this session.";
		throw new Error(`Unknown tool "${name}": it is not registered in this session.${suffix}`);
	}

	const { sourceInfo } = tool;
	if (sourceInfo.source === "sdk" || sourceInfo.path.startsWith("<")) {
		throw new Error(
			`Tool "${name}" is provided by an SDK or inline extension and cannot be loaded in a child.`,
		);
	}
	if (sourceInfo.scope === "project" && !context.trusted) {
		throw new Error(`Tool "${name}" comes from a project extension. Trust the project before delegating it.`);
	}
	if (context.selfPath !== undefined && sourceInfo.path === context.selfPath) {
		throw new Error(`Tool "${name}" comes from the subagent extension and cannot be given to a child.`);
	}

	// Core built-ins are already in the child; their `builtin:<name>` path is not
	// an extension source. Anything else with a builtin source is a built-in
	// extension: the loader resolves `builtin:<name>` only against the factories
	// it was handed, so an unsupported one is rejected here with a reason instead
	// of surfacing as the loader's "Unknown built-in extension" diagnostic.
	if (sourceInfo.source === "builtin") {
		if (CORE.has(name)) return undefined;

		const builtinName = builtinExtensionName(name, sourceInfo.path);
		if (!SUPPORTED_BUILTIN_EXTENSIONS.has(builtinName)) {
			throw new Error(
				`Tool "${name}" comes from built-in extension "${builtinName}", which a child cannot load. ` +
					`Supported: ${[...SUPPORTED_BUILTIN_EXTENSIONS].join(", ")}.`,
			);
		}
		return `builtin:${builtinName}`;
	}

	// A file extension may override a core tool name (`bash` with a sandbox, say).
	// The child must load that extension or it silently gets the built-in instead.
	return sourceInfo.path;
}

/**
 * Merge the requested names into the definition's tool selection.
 *
 * Pi accepts either a plain allowlist or a list of `+name`/`-name` modifiers,
 * never both. A definition without an allowlist (`undefined`) keeps the child's
 * default tools and receives the request as `+name`; a definition with one gets
 * the request appended. The parent's request is additive in both cases.
 *
 * An explicit empty allowlist (`[]`) is a third case, not a missing one: the
 * author said "no tools", so the result is a plain allowlist holding only the
 * requested names. Turning it into `+name` modifiers would hand the child the
 * defaults the definition just refused.
 */
function combineTools(definition: readonly string[] | undefined, names: readonly string[]): string[] | undefined {
	if (definition === undefined) {
		return names.length > 0 ? names.map((name) => `+${name}`) : undefined;
	}

	if (definition.length === 0) {
		return [...names];
	}

	const modified = definition.some(isModifier);
	if (modified && definition.some((entry) => !isModifier(entry))) {
		throw new Error(
			"The agent definition mixes tool names with +name/-name modifiers; Pi cannot apply both. " +
				"Fix the definition's tools list before requesting extra tools.",
		);
	}

	if (modified) {
		const combined = [...definition];
		for (const name of names) {
			// A definition that removes a tool has made a decision about it. Adding
			// `+name` after `-name` would silently reverse that decision, so the
			// request is a policy conflict instead.
			if (combined.includes(`-${name}`)) {
				throw new Error(
					`Tool "${name}" is removed by the agent definition's tools list (-${name}); a request cannot re-enable it.`,
				);
			}
			const modifier = `+${name}`;
			if (!combined.includes(modifier)) combined.push(modifier);
		}
		return combined;
	}

	const combined = [...definition];
	for (const name of names) if (!combined.includes(name)) combined.push(name);
	return combined;
}

/**
 * Resolve requested tool names to extension paths and a child tool selection.
 *
 * Every failure is a thrown `Error` with a model-readable reason: an unknown
 * name is a typo, a project extension in an untrusted project is a trust
 * decision, and a subagent or UI tool is a policy that cannot be negotiated.
 */
export function resolveToolSelection(request: ToolSelectionRequest): ToolSelection {
	const requested = [...new Set(request.requested.map((name) => name.trim()).filter(Boolean))];
	// Kept as `undefined` rather than defaulted to `[]`: the two mean different
	// things downstream, and collapsing them is what gave a "no tools" definition
	// the child's default tools.
	const definition = request.definitionTools === undefined ? undefined : [...request.definitionTools];
	const all = new Map(request.allTools.map((tool) => [tool.name, tool] as const));
	const context: ResolveContext = {
		all,
		disallowed: request.disallowedTools ?? [],
		trusted: request.trusted,
		definitionPath: request.definitionPath,
		// A child must never load the extension that owns the subagent tools, even
		// if some future tool from it is requested under a different name.
		selfPath: all.get(SUBAGENT_TOOLS[0])?.sourceInfo.path,
	};

	const names: string[] = [];
	const extensionPaths: string[] = [];
	const seenPaths = new Set<string>();
	const coreOverrides = new Map<string, string>();

	// One extension loaded by two tools is still one path, whichever source named it.
	const addPath = (path: string | undefined): void => {
		if (path === undefined || seenPaths.has(path)) return;
		seenPaths.add(path);
		extensionPaths.push(path);
	};

	const mcpNamespaces = new Set<string>();
	let mcpResources = false;
	const annotateDefinition = (error: unknown): Error => {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(context.definitionPath ? `${message} (agent definition: ${context.definitionPath})` : message);
	};
	const loadTool = (name: string, fromDefinition = false): void => {
		try {
			const path = extensionPathFor(name, context);
			addPath(path);
			if (path !== undefined && CORE.has(name)) coreOverrides.set(name, path);
			if (path !== "builtin:mcp") return;
			const tool = all.get(name)!;
			if (tool.namespace) mcpNamespaces.add(tool.namespace.name);
			if (MCP_RESOURCE_TOOLS.includes(name)) mcpResources = true;
		} catch (error) {
			// A requested name must not be blamed on the definition file. The one
			// exception is the definition's denylist, which is where that decision lives.
			const definitionOrigin = fromDefinition || (error instanceof Error && error.message.includes("disallowed_tools"));
			if (definitionOrigin && context.definitionPath) throw annotateDefinition(error);
			throw error;
		}
	};

	for (const name of requested) {
		loadTool(name);
		names.push(name);
	}

	// The definition's own allowlist names tools the child must have, but its
	// extension is not loaded by `noExtensions: true`. Resolving those names is
	// what lets `tools: ["lark_doc"]` work without a parent `tools` request.
	// Only paths are added here: the definition's selection is left untouched.
	if (request.loadDefinitionTools === true) {
		for (const entry of definition ?? []) {
			// `-name` only removes a default tool; it names no extension to load.
			// `+name` does name a tool, so its extension must be loaded just like a
			// plain allowlist entry — otherwise a definition using `+lark_doc` gets
			// the modifier without the tool.
			if (entry.startsWith("-")) continue;
			const name = entry.startsWith("+") ? entry.slice(1) : entry;
			if (name.includes("*")) {
				throw annotateDefinition(new Error(
					`Agent definition tool "${entry}" is a pattern and cannot be resolved to an extension. ` +
						"List concrete tool names in its tools list.",
				));
			}
			loadTool(name, true);
		}
	}

	// Built-in MCP owns the tool, not the extension that registered its server.
	// Copy needed configs unless another grant already loads their registrar:
	// that extension must retain ownership, including session_start registrations.
	// Resource tools intentionally reach all servers, as in the parent SDK.
	const mcpServers = (request.mcpServers ?? [])
		.filter((server) => !seenPaths.has(server.extensionPath) &&
			(mcpResources || mcpNamespaces.has(`mcp__${server.name.replaceAll("-", "_")}`)))
		.map((server) => structuredClone(server));
	let tools: string[] | undefined;
	try {
		tools = combineTools(definition, names);
	} catch (error) {
		if (context.definitionPath) throw annotateDefinition(error);
		throw error;
	}
	return {
		extensionPaths, ...(coreOverrides.size ? { coreOverrides: [...coreOverrides].map(([name, path]) => ({ name, path })) } : {}), tools,
		...(mcpServers.length ? { mcpServers } : {}),
	};
}
