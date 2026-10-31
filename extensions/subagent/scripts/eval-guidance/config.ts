import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir, type CreateAgentSessionOptions, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../../index.ts";
import { createReadOnlyTools } from "./environment.ts";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
export interface ModelRef { provider: string; id: string }
export interface EvalCase { id: string; prompt: string; expected: "direct" | "delegate"; mode?: "decision" | "trajectory" }
export interface Fixture { name: string; cases: EvalCase[]; files: Map<string, string>; hash: string }
export interface Variant { name: "baseline" | "candidate"; description: string; promptGuidelines: string[]; hash: string }
export interface AgentContract { parameters: ToolDefinition["parameters"]; promptSnippet: string; variants: Variant[] }
export interface Options {
	live: boolean; help: boolean; models: ModelRef[]; caseIds: string[]; repeat: number;
	maxRequests: number; maxCaseRequests: number; requestTimeoutMs: number; caseTimeoutMs: number;
	maxOutputTokens: number; thinking: ThinkingLevel; agentDir: string; outputParent: string;
	fixturePath: string; baselinePath: string;
}

export const TOOL_NAMES = ["read", "ls", "agent", "codemode"];
export const BASE_CONTEXT = "Project files are available through read and ls. Use those tools for exact project data; do not assume Bash, external SDK documents, external services or other host files are reachable. Analyze the supplied code rather than assuming external SDK behavior. Respect the user's scope and delegation restrictions. Do not invent facts, checks or completed work.";
export const HELP = `Usage: npm run eval:guidance -- [options]
Default is dry-run: no credentials are read and no model requests are made.

  --model provider/modelId   Repeat for each model; required for --live
  --case G01                Repeat to select cases (default: all bundled cases)
  --repeat N                Paired repetitions (default: 1, max: 100)
  --max-requests N           Total model-start budget; explicitly required for --live
  --max-case-requests N      Per-case budget (default: 8)
  --request-timeout-ms N     Cooperative request deadline (default: 60000)
  --case-timeout-ms N        Cooperative case deadline (default: 180000)
  --max-output-tokens N     Requested output limit (default: 8192; Codex may ignore it)
  --thinking LEVEL          Fixed Pi thinking level (default: low)
  --agent-dir PATH          Read-only model/auth configuration (default: Pi agent dir)
  --output PATH             Parent directory for a fresh run folder (default: OS temp)
  --fixture PATH            Fixture/cases JSON (default: bundled fixture.json)
  --baseline PATH           Baseline prompt JSON (default: bundled baseline.json)
  --dry-run                 Explicitly select the default offline mode
  --live                    Enable paid parent-model requests; never real subagents
  --help                    Show this help
`;

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function parseModel(value: string): ModelRef {
	const slash = value.indexOf("/");
	if (slash < 1 || slash === value.length - 1 || /\s/.test(value)) throw new Error(`Expected provider/modelId: ${value}`);
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function positive(value: string, name: string, max: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be between 1 and ${max}`);
	return n;
}

export function parseOptions(args: string[]): Options {
	const options: Options = {
		live: false, help: false, models: [], caseIds: [], repeat: 1, maxRequests: 32, maxCaseRequests: 8,
		requestTimeoutMs: 60_000, caseTimeoutMs: 180_000, maxOutputTokens: 8_192, thinking: "low",
		agentDir: getAgentDir(), outputParent: tmpdir(),
		fixturePath: fileURLToPath(new URL("./fixture.json", import.meta.url)),
		baselinePath: fileURLToPath(new URL("./baseline.json", import.meta.url)),
	};
	let explicitBudget = false;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--help") { options.help = true; continue; }
		if (flag === "--live") { options.live = true; continue; }
		if (flag === "--dry-run") { dryRun = true; continue; }
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		switch (flag) {
			case "--model": options.models.push(parseModel(value)); break;
			case "--case": options.caseIds.push(value); break;
			case "--repeat": options.repeat = positive(value, flag, 100); break;
			case "--max-requests": options.maxRequests = positive(value, flag, 10_000); explicitBudget = true; break;
			case "--max-case-requests": options.maxCaseRequests = positive(value, flag, 100); break;
			case "--request-timeout-ms": options.requestTimeoutMs = positive(value, flag, 300_000); break;
			case "--case-timeout-ms": options.caseTimeoutMs = positive(value, flag, 3_600_000); break;
			case "--max-output-tokens": options.maxOutputTokens = positive(value, flag, 131_072); break;
			case "--thinking":
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error(`Invalid thinking level: ${value}`);
				options.thinking = value as ThinkingLevel;
				break;
			case "--agent-dir": options.agentDir = value; break;
			case "--output": options.outputParent = value; break;
			case "--fixture": options.fixturePath = value; break;
			case "--baseline": options.baselinePath = value; break;
			default: throw new Error(`Unknown option: ${flag}`);
		}
	}
	if (options.help) return options;
	if (options.live && dryRun) throw new Error("--live and --dry-run are mutually exclusive");
	if (options.live && (!options.models.length || !explicitBudget)) throw new Error("--live requires explicit --model and --max-requests");
	if (options.models.length > 16) throw new Error("At most 16 models may be selected");
	const modelKeys = options.models.map(m => `${m.provider}/${m.id}`);
	if (new Set(modelKeys).size !== modelKeys.length) throw new Error("Duplicate model selection");
	if (new Set(options.caseIds).size !== options.caseIds.length) throw new Error("Duplicate case selection");
	return options;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function readJson(path: string, limit: number): unknown {
	const data = readFileSync(path);
	if (data.length > limit) throw new Error(`JSON input exceeds ${limit} bytes: ${path}`);
	return JSON.parse(data.toString("utf8"));
}

export function loadFixture(path: string): Fixture {
	const input = object(readJson(path, 4 * 1024 * 1024), "fixture");
	if (typeof input.name !== "string" || !input.name.trim() || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 64) throw new Error("Fixture needs a name and nonempty cases");
	const cases = input.cases.map(value => {
		const c = object(value, "case");
		if (typeof c.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) || typeof c.prompt !== "string" || !c.prompt.trim() || c.prompt.length > 65_536 || (c.expected !== "direct" && c.expected !== "delegate")) throw new Error("Invalid case id, prompt or expected action");
		if (c.mode !== undefined && c.mode !== "decision" && c.mode !== "trajectory") throw new Error("Invalid case mode");
		return { id: c.id, prompt: c.prompt, expected: c.expected, ...(c.mode !== undefined ? { mode: c.mode as EvalCase["mode"] } : {}) } as EvalCase;
	});
	if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Duplicate fixture case id");
	const files = new Map<string, string>();
	for (const [name, lines] of Object.entries(object(input.files, "fixture files"))) {
		if (!Array.isArray(lines) || !lines.every(line => typeof line === "string")) throw new Error(`Fixture file must be an array of lines: ${name}`);
		files.set(name, lines.join("\n"));
	}
	if (!files.size) throw new Error("Fixture must contain files");
	createReadOnlyTools("/fixture", files); // Validate path/data conflicts without any host fs access.
	return { name: input.name, cases, files, hash: hash(JSON.stringify({ name: input.name, cases, files: [...files] })) };
}

export function loadContract(baselinePath: string): AgentContract {
	let captured: ToolDefinition | undefined;
	subagentExtension({ registerTool: (tool: ToolDefinition) => { captured = tool; }, on() {} } as unknown as ExtensionAPI);
	if (!captured) throw new Error("Agent tool was not registered");
	const baseline = object(readJson(baselinePath, 65_536), "baseline");
	if (typeof baseline.description !== "string" || !baseline.description.trim() || !Array.isArray(baseline.promptGuidelines) || !baseline.promptGuidelines.length || !baseline.promptGuidelines.every(x => typeof x === "string" && x.trim())) throw new Error("Invalid baseline prompt metadata");
	const roster = "\n\nAvailable agent types:\nnone — omit subagent_type for a general-purpose agent.";
	const make = (name: Variant["name"], description: string, promptGuidelines: string[]): Variant => {
		const metadata = { description: description.split("\n\nAvailable agent types:")[0] + roster, promptGuidelines };
		return { name, ...metadata, hash: hash(JSON.stringify(metadata)) };
	};
	return {
		parameters: captured.parameters, promptSnippet: captured.promptSnippet ?? "Delegate separable, context-heavy work to a child agent",
		variants: [make("baseline", baseline.description, baseline.promptGuidelines as string[]), make("candidate", captured.description, [...(captured.promptGuidelines ?? [])])],
	};
}

export interface CaseSpec { id: string; model: ModelRef; variant: Variant; scenario: EvalCase; repeat: number }
export function createPlan(options: Options, fixture: Fixture, contract: AgentContract): CaseSpec[] {
	const selected = options.caseIds.length ? options.caseIds.map(id => {
		const c = fixture.cases.find(c => c.id === id);
		if (!c) throw new Error(`Unknown case: ${id}`);
		return c;
	}) : fixture.cases;
	if (selected.length * options.models.length * options.repeat * contract.variants.length > 10_000) throw new Error("Plan exceeds 10000 cases");
	const plan: CaseSpec[] = [];
	for (let repeat = 1; repeat <= options.repeat; repeat++) for (const scenario of selected) for (let m = 0; m < options.models.length; m++) {
		const variants = repeat % 2 ? contract.variants : [...contract.variants].reverse();
		for (const variant of variants) plan.push({ id: `m${m + 1}-${scenario.id}-${variant.name}-r${repeat}`, model: options.models[m], variant, scenario, repeat });
	}
	return plan;
}
