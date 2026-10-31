/** SDK-facing tool grants: an extension path loads code, never grants all its tools. */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { childExcludeTools } from "./child-policy.ts";

/** Pi 1.2/1.3's default; the SDK does not export DEFAULT_TOOL_NAMES. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
export const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface ChildToolPolicy {
	tools: string[];
	excludeTools: string[];
	customTools: ToolDefinition[];
}

export function createChildToolPolicy(
	cwd: string,
	settings: SettingsManager,
	selection?: readonly string[],
	excluded?: readonly string[],
): ChildToolPolicy {
	// Pin implicit core grants to the SDK implementations. Otherwise an extension
	// loaded for one requested tool could also replace a default `bash` or `read`.
	// Explicit core grants remain overridable (for a deliberately selected sandbox).
	const core = {
		read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
		bash: createBashToolDefinition(cwd, {
			commandPrefix: settings.getShellCommandPrefix(),
			shellPath: settings.getShellPath(),
		}),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		powershell: createPowerShellToolDefinition(cwd),
	};
	const isModifier = (name: string): boolean => name.startsWith("+") || name.startsWith("-");
	const modifiers = selection?.some(isModifier) ?? false;
	if (modifiers && selection?.some((name) => !isModifier(name))) {
		throw new Error("Invalid tools option: tool names cannot be mixed with +name or -name entries");
	}
	if (modifiers && selection?.some((name) => name.includes("*"))) {
		throw new Error("Invalid tools option: +name and -name entries take exact tool names, not patterns");
	}

	// Settings select the core baseline, not permission to use arbitrary extension
	// tools. getDefaultTools() has already resolved settings-level modifiers.
	const baseline = (settings.getDefaultTools() ?? DEFAULT_TOOLS).filter((name) => Object.hasOwn(core, name));
	const tools = new Set(selection === undefined || modifiers ? baseline : selection);
	const explicit = new Set<string>();
	for (const entry of selection ?? []) {
		if (modifiers) {
			const name = entry.slice(1);
			if (entry.startsWith("-")) tools.delete(name);
			else if (name) {
				tools.add(name);
				explicit.add(name);
			}
		} else {
			explicit.add(entry);
		}
	}

	const excludeTools = new Set(childExcludeTools(excluded));
	// Pi otherwise retains MCP tools when a non-empty allowlist has no mcp__
	// entry. Resource tools share that exemption but do not match mcp__*.
	if (![...tools].some((name) => name.startsWith("mcp__"))) excludeTools.add("mcp__*");
	for (const name of MCP_RESOURCE_TOOLS) if (!tools.has(name)) excludeTools.add(name);

	return {
		// Always plain, even when empty: modifiers leave SDK registration unbounded.
		tools: [...tools],
		excludeTools: [...excludeTools],
		// The SDK's heterogeneous customTools registry erases each tool's schema.
		customTools: Object.entries(core)
			.filter(([name]) => tools.has(name) && !explicit.has(name))
			.map(([, definition]) => definition) as unknown as ToolDefinition[],
	};
}
