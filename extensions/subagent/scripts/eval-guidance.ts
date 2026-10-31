#!/usr/bin/env node
/** Standalone, opt-in parent-routing evaluation; never loaded as a Pi extension. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	BASE_CONTEXT, TOOL_NAMES, HELP, createPlan, hash, loadContract, loadFixture, parseOptions,
} from "./eval-guidance/config.ts";
import { createLiveRuntime, Redactor, RequestBudget, runCase, skipped, type CaseResult } from "./eval-guidance/runtime.ts";

export function summarize(results: CaseResult[]) {
	return {
		cases: results.length,
		observed: results.filter(r => r.matchesExpectation !== null).length,
		routingMatches: results.filter(r => r.matchesExpectation === true).length,
		routingMismatches: results.filter(r => r.matchesExpectation === false).length,
		inconclusive: results.filter(r => r.matchesExpectation === null).length,
		requests: results.reduce((sum, r) => sum + r.requests, 0),
		agentCalls: results.reduce((sum, r) => sum + r.agentCallCount, 0),
		casesWithMultipleAgentCalls: results.filter(r => r.agentCallCount > 1).length,
		postDelegationAccesses: results.reduce((sum, r) => sum + r.postDelegationAccesses, 0),
		duplicatePostDelegationAccesses: results.reduce((sum, r) => sum + r.duplicatePostDelegationAccesses, 0),
		firstDelegations: results.filter(r => r.agentInvocations.length).map(r => ({ id: r.id, request: r.agentInvocations[0].request })),
	};
}

function report(results: CaseResult[], sdk: string): string {
	const stats = summarize(results);
	const cell = (s: unknown) => String(s).replace(/[|\r\n]/g, " ");
	return `# Agent guidance routing evaluation\n\n` +
		`Rules-based observations; no independent judge or real child execution. Pi SDK ${sdk}.\n\n` +
		`Read/ls operate on a closed in-memory text fixture. No Bash, writes, host-file reads, MCP, extra model tools or external services are exposed. This toolset is not a replay of the daily Pi environment.\n\n` +
		`Cases: ${stats.cases}; routing matches: ${stats.routingMatches}; mismatches: ${stats.routingMismatches}; inconclusive: ${stats.inconclusive}; model-start attempts: ${stats.requests}; agent calls: ${stats.agentCalls}; cases with multiple agent calls: ${stats.casesWithMultipleAgentCalls}; post-delegation reads: ${stats.postDelegationAccesses} (duplicate paths: ${stats.duplicatePostDelegationAccesses}).\n\n` +
		`A direct stop is only a model stop, not proof of task quality/completeness. Budgets, provider errors and truncation are inconclusive, never zero-score routing failures. Small samples do not establish stable success rates.\n\n` +
		`| Case | Model | Variant | Repeat | Decision | Validity | Expected routing match | Requests | Agent calls | Post-delegation reads | First agent request |\n` +
		`|---|---|---|---:|---|---|---|---:|---:|---:|---:|\n` +
		results.map(r => `| ${[r.caseId, r.model, r.variant, r.repeat, r.decision, r.validity, r.matchesExpectation ?? "inconclusive", r.requests, r.agentCallCount, `${r.postDelegationAccesses}${r.duplicatePostDelegationAccesses ? ` (dup ${r.duplicatePostDelegationAccesses})` : ""}`, r.agentInvocations[0]?.request ?? "—"].map(cell).join(" | ")} |`).join("\n") +
		`\n\nNo task-quality score is computed. Trajectory cases return a stub child result and continue to the per-case request budget; agent-call counts and post-delegation duplicate-path reads are descriptive observations, not a quality score. Review handoff scope, permissions and evidence requirements in the case JSON. JSON traces contain public responses only, not thinking text or request auth. Logs can still contain supplied fixture data; manage them like session data.\n\n` +
		`Output token limits are adapter-dependent (Codex may ignore them); request counts/timeouts are not a monetary hard cap. Usage/cost fields are SDK/provider metadata, not a bill; zero/missing prices or failed-request usage do not prove free execution.\n`;
}

function harnessHash(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	return hash(["eval-guidance.ts", "eval-guidance/config.ts", "eval-guidance/runtime.ts", "eval-guidance/environment.ts"]
		.map(path => readFileSync(join(directory, path), "utf8")).join("\n"));
}

export async function main(argv: string[], io: { log(text: string): void; error(text: string): void } = console): Promise<number> {
	const redactor = new Redactor();
	let outputDir: string | undefined;
	const save = (path: string, value: unknown) => writeFileSync(path, redactor.json(value) + "\n", { flag: "wx", mode: 0o600 });
	try {
		const options = parseOptions(argv);
		if (options.help) { io.log(HELP); return 0; }
		const fixture = loadFixture(options.fixturePath);
		const contract = loadContract(options.baselinePath);
		const plan = createPlan(options, fixture, contract);
		mkdirSync(options.outputParent, { recursive: true });
		outputDir = mkdtempSync(join(options.outputParent, "pi-agent-guidance-"));
		const workspace = join(outputDir, "workspace");
		const privateAgentDir = join(outputDir, "empty-agent");
		mkdirSync(workspace); mkdirSync(privateAgentDir);
		const manifest = {
			schemaVersion: 1, mode: options.live ? "live" : "dry-run", evaluation: "parent-routing-only", judge: "rules-only",
			createdAt: new Date().toISOString(), sdk: VERSION, harnessHash: harnessHash(), toolNames: TOOL_NAMES,
			baseContext: BASE_CONTEXT, thinking: options.thinking, requestedMaxOutputTokens: options.maxOutputTokens,
			budget: { totalRequests: options.maxRequests, perCaseRequests: options.maxCaseRequests, requestTimeoutMs: options.requestTimeoutMs, caseTimeoutMs: options.caseTimeoutMs },
			fixture: { name: fixture.name, hash: fixture.hash, files: [...fixture.files].map(([path, text]) => ({ path, hash: hash(text) })) },
			variants: contract.variants, agentParameters: contract.parameters,
			plan: plan.map(spec => ({ id: spec.id, model: `${spec.model.provider}/${spec.model.id}`, caseId: spec.scenario.id, mode: spec.scenario.mode ?? "decision", prompt: spec.scenario.prompt, expected: spec.scenario.expected, variant: spec.variant.name, repeat: spec.repeat })),
			limitations: ["Restricted read/ls toolset, not production replay", "No real child execution or task-quality judge", "Cooperative cancellation is not force-kill", "Output token and price metadata may not be enforced or complete"],
		};
		save(join(outputDir, "manifest.json"), manifest);
		save(join(outputDir, "fixture.json"), { name: fixture.name, cases: fixture.cases, files: Object.fromEntries([...fixture.files].map(([path, text]) => [path, text.split("\n")])) });
		if (!options.live) {
			io.log(JSON.stringify({ mode: "dry-run", outputDir, plannedCases: plan.length, models: options.models, cases: options.caseIds.length ? options.caseIds : fixture.cases.map(c => c.id), modelRequests: 0, credentialsRead: false }));
			return 0;
		}
		const { runtime, models, modelsConfigHash } = await createLiveRuntime(options, outputDir, redactor);
		save(join(outputDir, "selected-models.json"), { modelsConfigHash, models: [...models.values()].map(model => ({
			provider: model.provider, id: model.id, api: model.api, maxTokens: model.maxTokens,
			thinkingLevelMap: model.thinkingLevelMap, samplingParams: model.samplingParams,
			samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel, cost: model.cost,
		})) });
		const budget = new RequestBudget(options.maxRequests);
		const results: CaseResult[] = [];
		const casesDir = join(outputDir, "cases");
		mkdirSync(casesDir);
		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.on("SIGINT", cancel);
		process.on("SIGTERM", cancel);
		const providers = [...new Set(options.models.map(model => model.provider))];
		let nextProvider = 0;
		const record = (result: CaseResult) => {
			save(join(casesDir, `${result.id}.json`), result);
			results.push(result);
			io.log(redactor.json({ id: result.id, decision: result.decision, validity: result.validity, requests: result.requests, agentInvocations: result.agentInvocations.length }, 0));
		};
		async function worker() {
			for (;;) {
				const provider = providers[nextProvider++];
				if (!provider) return;
				let blocked: string | undefined;
				for (const spec of plan.filter(spec => spec.model.provider === provider)) {
					if (controller.signal.aborted || blocked || budget.used >= budget.limit) {
						record(skipped(spec, fixture, options, controller.signal.aborted ? "Run cancelled" : blocked ?? "Total request budget exhausted"));
						continue;
					}
					const model = models.get(`${spec.model.provider}/${spec.model.id}`)!;
					const result = await runCase({
						spec, options, fixture, contract, runtime, model, budget, workspace, agentDir: privateAgentDir, signal: controller.signal,
						onRequest: event => appendFileSync(join(outputDir!, "requests.jsonl"), redactor.json(event, 0) + "\n", { mode: 0o600 }),
					});
					record(result);
					// No retry, fallback provider or repeated auth/rate-limit failures.
					if (result.validity === "provider_error" || result.validity === "environment_error") blocked = "Provider/setup failed earlier in this run; remaining cases not attempted";
				}
			}
		}
		const workers = Array.from({ length: Math.min(2, providers.length) }, () => worker());
		try { await Promise.all(workers); }
		catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
		finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
		results.sort((a, b) => plan.findIndex(s => s.id === a.id) - plan.findIndex(s => s.id === b.id));
		const summary = summarize(results);
		save(join(outputDir, "summary.json"), { ...summary, modelStartAttempts: budget.used, childExecution: false, cases: results.map(({ messages: _messages, accesses: _accesses, ...rest }) => rest) });
		writeFileSync(join(outputDir, "report.md"), redactor.text(report(results, VERSION)), { flag: "wx", mode: 0o600 });
		io.log(redactor.json({ outputDir, ...summary }, 0));
		return summary.inconclusive ? 2 : summary.routingMismatches ? 1 : 0;
	} catch (error) {
		const message = redactor.text(error instanceof Error ? error.message : String(error));
		if (outputDir) save(join(outputDir, "failure.json"), { validity: "environment_error", error: message });
		io.error(message);
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
