/**
 * agents.ts — discover subagent definitions from markdown files.
 *
 * Definitions live in `~/.pi/agent/agents/*.md` (user) and `<project>/.pi/agents/*.md`
 * (project), the same convention Pi's own subagent example uses. Frontmatter
 * carries the configuration; the body is appended to the child's system prompt.
 *
 * Discovery is deliberately total: one malformed file must never take down the
 * other definitions in the same directory, so every failure path yields "skip
 * this file" rather than a throw.
 *
 * Kept free of any `ExtensionAPI` dependency so it can be unit-tested.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/** Why one definition file was skipped. Discovery stays total; the caller decides where to show this. */
export interface AgentDiagnostic {
	filePath: string;
	message: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	/**
	 * Allowlist of tool names. Undefined means Pi's defaults; `[]` means the
	 * definition explicitly asked for no tools, which is not the same thing and
	 * must survive parsing.
	 */
	tools?: string[];
	/** Denylist applied after `tools`. */
	disallowedTools?: string[];
	/** `provider/modelId`, resolved against the model registry. */
	model?: string;
	thinking?: string;
	maxTurns?: number;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

/**
 * Raw frontmatter. A type alias rather than an interface: `parseFrontmatter`
 * constrains its parameter to `Record<string, unknown>`, and only an alias
 * picks up the implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	disallowed_tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	max_turns?: unknown;
};

/**
 * Normalize a frontmatter list to trimmed strings.
 *
 * Both spellings are valid YAML and both appear in the wild:
 *
 *     tools: read, bash
 *     tools: [read, bash]
 *
 * An explicit list is a decision: `tools: []` (or `tools: ""`) says the child
 * gets no tools, so it stays `[]`. Only a missing value is `undefined`, which
 * means "no allowlist" and leaves Pi's defaults in place. A value of any other
 * shape (a number, a map, a nested list) is not a list at all and yields
 * `undefined` rather than throwing.
 */
function parseList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) && typeof value !== "string") return undefined;

	const raw = Array.isArray(value) ? value : value.split(",");
	// Filtered, not defaulted: a list whose entries are all blank or non-strings
	// is still the empty allowlist the author wrote, not a request for defaults.
	return raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseMaxTurns(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.max(1, Math.floor(n));
}

export function loadAgentsFromDir(dir: string, source: "user" | "project", diagnostics?: AgentDiagnostic[]): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: string[];
	try {
		if (!statSync(dir).isDirectory()) return agents;
		entries = readdirSync(dir);
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = join(dir, entry);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch (error) {
			diagnostics?.push({ filePath, message: `could not read file (${error instanceof Error ? error.message : String(error)})` });
			continue;
		}

		// `parseFrontmatter` runs the YAML parser, so a syntax error throws. Catch per file:
		// wrapping the loop would let one broken definition hide every later one.
		try {
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
			const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
			const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
			const missing = [name.trim() ? "" : "name", description.trim() ? "" : "description"].filter(Boolean);
			if (missing.length > 0) {
				diagnostics?.push({ filePath, message: `missing ${missing.join(" and ")} in frontmatter` });
				continue;
			}

			agents.push({
				name,
				description,
				tools: parseList(frontmatter.tools),
				disallowedTools: parseList(frontmatter.disallowed_tools),
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
				maxTurns: parseMaxTurns(frontmatter.max_turns),
				systemPrompt: body,
				source,
				filePath,
			});
		} catch (error) {
			diagnostics?.push({ filePath, message: error instanceof Error ? error.message : "invalid frontmatter" });
			continue;
		}
	}

	return agents;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from `cwd` looking for the nearest `.pi/agents` directory. */
export function findProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function userAgentsDir(): string {
	return join(getAgentDir(), "agents");
}

/**
 * Collect the agent definitions visible from `cwd`.
 *
 * Project definitions win over user definitions with the same name, so a
 * repository can override a global agent without renaming it. The map is keyed
 * by the normalized name because lookup is case-insensitive: keying by the raw
 * string would let `scout` (user) and `Scout` (project) coexist, and the
 * case-insensitive lookup would then return whichever was inserted first —
 * silently defeating the override.
 */
export function discoverAgents(cwd: string, scope: AgentScope = "user", diagnostics?: AgentDiagnostic[]): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();

	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(userAgentsDir(), "user", diagnostics)) byName.set(agentKey(agent.name), agent);
	}
	if (scope !== "user") {
		const projectDir = findProjectAgentsDir(cwd);
		if (projectDir) {
			for (const agent of loadAgentsFromDir(projectDir, "project", diagnostics)) byName.set(agentKey(agent.name), agent);
		}
	}

	return [...byName.values()];
}

/** Compact, bounded diagnostics for an error message. */
export function formatAgentDiagnostics(diagnostics: readonly AgentDiagnostic[], maxItems = 5): string {
	if (diagnostics.length === 0) return "";
	const shown = diagnostics.slice(0, maxItems).map((entry) => {
		// YAML errors embed multi-line source frames. Keep the line/column text but
		// flatten them so one bad file cannot turn an error into a wall of source.
		const compact = entry.message.replace(/\s+/g, " ").trim();
		const message = compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
		return `${entry.filePath} — ${message}`;
	});
	if (diagnostics.length > maxItems) shown.push(`(+${diagnostics.length - maxItems} more)`);
	return shown.join("; ");
}

/** The one spelling used for map keys and lookups. */
function agentKey(name: string): string {
	return name.trim().toLowerCase();
}

/** Resolve an agent type name, case-insensitively. */
export function findAgent(agents: readonly AgentConfig[], name: string): AgentConfig | undefined {
	const wanted = agentKey(name);
	return agents.find((agent) => agentKey(agent.name) === wanted);
}

/** One line per agent for the tool description. */
export function formatAgentList(
	agents: readonly Pick<AgentConfig, "name" | "description" | "source" | "tools">[],
	maxItems: number,
): string {
	// `none` on its own reads as "this tool is unusable", which would stop the model
	// from delegating at all. Say that the default still applies.
	if (agents.length === 0) return "none — omit subagent_type to spawn a general-purpose agent";
	const listed = agents.slice(0, maxItems);
	const lines = listed.map((agent) => {
		const scope = agent.source === "project" ? "project" : "user";
		// `tools: []` is an explicit "no tools", which is not the same fact as an
		// absent allowlist. Showing both as no suffix would hide the distinction the
		// definition author just made.
		const tools =
			agent.tools === undefined
				? ""
				: agent.tools.length > 0
					? ` (tools: ${agent.tools.join(", ")})`
					: " (tools: none)";
		return `- ${agent.name} [${scope}]: ${agent.description}${tools}`;
	});
	if (agents.length > listed.length) lines.push(`- (+${agents.length - listed.length} more)`);
	return lines.join("\n");
}
