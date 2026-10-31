import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `getAgentDir` reads this at call time, so the suite never touches the real Pi home.
const agentDir = await mkdtemp(path.join(tmpdir(), "subagent-agents-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { discoverAgents, findAgent, findProjectAgentsDir, formatAgentDiagnostics, formatAgentList, loadAgentsFromDir, userAgentsDir } =
	await import("../src/agents.ts");

async function writeAgent(dir: string, file: string, content: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, file), content);
}

test("loadAgentsFromDir parses frontmatter and keeps the body as the system prompt", async () => {
	const dir = path.join(agentDir, "parse");
	await writeAgent(
		dir,
		"scout.md",
		[
			"---",
			"name: scout",
			"description: Fast recon",
			"tools: read, grep, find",
			"model: anthropic/claude-haiku-4-5",
			"thinking: low",
			"max_turns: 12",
			"---",
			"",
			"You are a scout.",
		].join("\n"),
	);

	const [agent] = loadAgentsFromDir(dir, "user");
	assert.equal(agent.name, "scout");
	assert.equal(agent.description, "Fast recon");
	assert.deepEqual(agent.tools, ["read", "grep", "find"]);
	assert.equal(agent.model, "anthropic/claude-haiku-4-5");
	assert.equal(agent.thinking, "low");
	assert.equal(agent.maxTurns, 12);
	assert.match(agent.systemPrompt, /You are a scout\./);
	assert.equal(agent.source, "user");
});

test("loadAgentsFromDir accepts a YAML array for tools", async () => {
	const dir = path.join(agentDir, "array-tools");
	await writeAgent(dir, "w.md", ["---", "name: w", "description: d", "tools: [read, bash]", "---", "body"].join("\n"));
	assert.deepEqual(loadAgentsFromDir(dir, "user")[0].tools, ["read", "bash"]);
});

test("loadAgentsFromDir reads disallowed_tools", async () => {
	const dir = path.join(agentDir, "deny");
	await writeAgent(
		dir,
		"d.md",
		["---", "name: d", "description: d", "disallowed_tools: write, edit", "---", "body"].join("\n"),
	);
	assert.deepEqual(loadAgentsFromDir(dir, "user")[0].disallowedTools, ["write", "edit"]);
});

test("loadAgentsFromDir keeps an explicit empty tools list apart from no tools", async () => {
	const dir = path.join(agentDir, "empty-tools");
	await writeAgent(dir, "none.md", ["---", "name: none", "description: d", "tools: []", "---", "b"].join("\n"));
	await writeAgent(dir, "absent.md", ["---", "name: absent", "description: d", "---", "b"].join("\n"));
	await writeAgent(dir, "plain.md", ["---", "name: plain", "description: d", "tools: read, bash", "---", "b"].join("\n"));

	const byName = new Map(loadAgentsFromDir(dir, "user").map((agent) => [agent.name, agent]));
	// `tools: []` is a decision to give the child nothing, not a missing value
	// that would leave Pi's defaults in place.
	assert.deepEqual(byName.get("none")?.tools, []);
	assert.equal(byName.get("absent")?.tools, undefined, "no tools key means no allowlist");
	assert.deepEqual(byName.get("plain")?.tools, ["read", "bash"]);
});

test("loadAgentsFromDir treats an empty tools string as an empty allowlist", async () => {
	const dir = path.join(agentDir, "blank-tools");
	await writeAgent(dir, "b.md", ["---", "name: b", "description: d", 'tools: ""', "---", "body"].join("\n"));

	assert.deepEqual(loadAgentsFromDir(dir, "user")[0].tools, []);
});

test("loadAgentsFromDir skips a definition missing name or description", async () => {
	const dir = path.join(agentDir, "incomplete");
	await writeAgent(dir, "a.md", ["---", "name: a", "---", "body"].join("\n"));
	await writeAgent(dir, "b.md", "no frontmatter at all\n");
	assert.deepEqual(loadAgentsFromDir(dir, "user"), []);
});

test("loadAgentsFromDir ignores non-markdown files and a missing directory", async () => {
	const dir = path.join(agentDir, "mixed");
	await writeAgent(dir, "notes.txt", "name: nope");
	assert.deepEqual(loadAgentsFromDir(dir, "user"), []);
	assert.deepEqual(loadAgentsFromDir(path.join(agentDir, "does-not-exist"), "user"), []);
});

test("loadAgentsFromDir rejects a nonsense max_turns rather than guessing", async () => {
	const dir = path.join(agentDir, "turns");
	await writeAgent(dir, "t.md", ["---", "name: t", "description: d", "max_turns: -3", "---", "b"].join("\n"));
	assert.equal(loadAgentsFromDir(dir, "user")[0].maxTurns, undefined);
});

test("diagnostics stay on one line and retain the YAML location", () => {
	const shown = formatAgentDiagnostics([{
		filePath: "broken.md",
		message: "Flow sequence in block collection must be sufficiently indented\n\nname: [unclosed\ndescription: d\n^",
	}]);
	assert.equal(shown, "broken.md — Flow sequence in block collection must be sufficiently indented name: [unclosed description: d ^");
	assert.doesNotMatch(shown, /\n/);
});

test("findAgent matches case-insensitively", async () => {
	const dir = path.join(agentDir, "case");
	await writeAgent(dir, "e.md", ["---", "name: Explore", "description: d", "---", "b"].join("\n"));
	const agents = loadAgentsFromDir(dir, "user");
	assert.equal(findAgent(agents, "explore")?.name, "Explore");
	assert.equal(findAgent(agents, "EXPLORE")?.name, "Explore");
	assert.equal(findAgent(agents, "missing"), undefined);
});

test("discoverAgents lets a project definition override a user one", async () => {
	await writeAgent(
		userAgentsDir(),
		"shared.md",
		["---", "name: shared", "description: from user", "---", "user body"].join("\n"),
	);
	const project = await mkdtemp(path.join(tmpdir(), "subagent-proj-"));
	await writeAgent(
		path.join(project, ".pi", "agents"),
		"shared.md",
		["---", "name: shared", "description: from project", "---", "project body"].join("\n"),
	);

	const agents = discoverAgents(project, "both");
	const shared = findAgent(agents, "shared");
	assert.equal(shared?.description, "from project");
	assert.equal(shared?.source, "project");
});

test("a project definition overrides a user one regardless of name case", async () => {
	// Lookup is case-insensitive, so `scout` and `Scout` are the same agent. Keying
	// the map by the raw name let both coexist, and the lookup returned whichever
	// was inserted first — silently defeating the project override.
	await writeAgent(
		userAgentsDir(),
		"case-user.md",
		["---", "name: scout", "description: from user", "---", "user body"].join("\n"),
	);
	const project = await mkdtemp(path.join(tmpdir(), "subagent-case-proj-"));
	await writeAgent(
		path.join(project, ".pi", "agents"),
		"case-project.md",
		["---", "name: Scout", "description: from project", "---", "project body"].join("\n"),
	);

	const agents = discoverAgents(project, "both");
	const matches = agents.filter((agent) => agent.name.toLowerCase() === "scout");
	assert.equal(matches.length, 1, "the two spellings are one agent");
	assert.equal(findAgent(agents, "scout")?.description, "from project");
	assert.equal(findAgent(agents, "SCOUT")?.source, "project");
});

test("discoverAgents honours the scope", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "subagent-scope-"));
	await writeAgent(path.join(project, ".pi", "agents"), "p.md", ["---", "name: p", "description: d", "---", "b"].join("\n"));

	assert.equal(findAgent(discoverAgents(project, "project"), "shared"), undefined);
	assert.equal(findAgent(discoverAgents(project, "user"), "p"), undefined);
	assert.ok(findAgent(discoverAgents(project, "both"), "p"));
});

test("loadAgentsFromDir skips a file with broken YAML frontmatter and keeps the rest", async () => {
	const dir = path.join(agentDir, "broken-yaml");
	// An unclosed flow sequence is a real YAML syntax error, so `yaml.parse` throws.
	await writeAgent(dir, "a-broken.md", ["---", "name: [unclosed", "---", "body"].join("\n"));
	await writeAgent(dir, "b-good.md", ["---", "name: good", "description: survives", "---", "body"].join("\n"));

	const diagnostics: Array<{ filePath: string; message: string }> = [];
	const agents = loadAgentsFromDir(dir, "user", diagnostics);
	assert.deepEqual(
		agents.map((agent) => agent.name),
		["good"],
	);
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0].filePath, /a-broken\.md$/);
	assert.ok(diagnostics[0].message.length > 0);
});

test("discoverAgents survives a malformed definition in the project directory", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "subagent-broken-"));
	const dir = path.join(project, ".pi", "agents");
	await writeAgent(dir, "a-broken.md", ["---", "name: [unclosed", "---", "body"].join("\n"));
	await writeAgent(dir, "b-good.md", ["---", "name: resilient", "description: d", "---", "body"].join("\n"));

	const agents = discoverAgents(project, "project");
	assert.equal(findAgent(agents, "resilient")?.name, "resilient");
});

test("findProjectAgentsDir walks up from a nested directory", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "subagent-walk-"));
	await writeAgent(path.join(project, ".pi", "agents"), "a.md", ["---", "name: a", "description: d", "---", "b"].join("\n"));
	const nested = path.join(project, "src", "deep", "deeper");
	await mkdir(nested, { recursive: true });

	assert.equal(findProjectAgentsDir(nested), path.join(project, ".pi", "agents"));
	assert.equal(findProjectAgentsDir(await mkdtemp(path.join(tmpdir(), "subagent-none-"))), undefined);
});

test("formatAgentList distinguishes an empty tools list from no list", () => {
	const empty = formatAgentList([{ name: "a", description: "d", source: "user" as const, tools: [] }], 5);
	assert.match(empty, /\(tools: none\)/, "an explicit empty allowlist is not the same as no allowlist");

	const absent = formatAgentList([{ name: "b", description: "d", source: "user" as const }], 5);
	assert.ok(!absent.includes("tools:"), "an absent allowlist says nothing");
});

test("formatAgentList reports the scope and truncates", () => {
	const agents = [
		{ name: "a", description: "one", source: "user" as const },
		{ name: "b", description: "two", source: "project" as const, tools: ["read"] },
		{ name: "c", description: "three", source: "user" as const },
	];
	assert.match(formatAgentList(agents, 2), /a \[user\]: one/);
	assert.match(formatAgentList(agents, 2), /b \[project\]: two \(tools: read\)/);
	assert.match(formatAgentList(agents, 2), /\+1 more/);
	assert.match(
		formatAgentList([], 5),
		/^none — omit subagent_type/,
		"an empty roster must not read as 'the tool is unusable'",
	);
});
