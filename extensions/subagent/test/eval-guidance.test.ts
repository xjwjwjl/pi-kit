import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { main, summarize } from "../scripts/eval-guidance.ts";
import { BASE_CONTEXT, TOOL_NAMES, createPlan, loadContract, loadFixture, parseModel, parseOptions } from "../scripts/eval-guidance/config.ts";
import { adjudicate, auditConfig, auditModelSampling, auditSampling, createLiveRuntime, readonlyCredentials, Redactor, RequestBudget, runCase, skipped, validatePayload, type EvalModel } from "../scripts/eval-guidance/runtime.ts";

const MODEL: EvalModel = {
	provider: "probe", id: "model", name: "Probe", api: "openai-completions", input: ["text"], reasoning: true,
	contextWindow: 100_000, maxTokens: 10_000, baseUrl: "https://unused.invalid", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const USAGE = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function root(t: TestContext) {
	const path = mkdtempSync(join(tmpdir(), "pi-eval-script-test-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return { role: "assistant", provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(), content, stopReason, errorMessage, usage: structuredClone(USAGE) };
}
function stream(value: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (value.stopReason === "error" || value.stopReason === "aborted") events.push({ type: "error", reason: value.stopReason, error: value });
		else events.push({ type: "done", reason: value.stopReason as "stop" | "length" | "toolUse", message: value });
		events.end();
	});
	return events;
}
async function fakeRuntime(t: TestContext, directory: string, reply: (n: number, context: unknown) => AssistantMessage) {
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("REAL NETWORK FORBIDDEN"); });
	const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: join(directory, "cache.json"), allowModelNetwork: false, refreshOnCreate: false });
	t.mock.method(runtime, "checkAuth", async () => ({ type: "api_key", source: "offline-test" }));
	t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "offline-test-key" } }));
	t.mock.method(runtime, "getModel", () => MODEL);
	let calls = 0;
	const requests = t.mock.method(runtime, "streamSimple", (_model: EvalModel, context: Parameters<ModelRuntime["streamSimple"]>[1]) => stream(reply(++calls, context)));
	t.after(() => assert.equal(fetch.mock.callCount(), 0));
	return { runtime, requests };
}
function setup(directory: string, caseId = "G02") {
	const options = parseOptions(["--model", "probe/model", "--case", caseId, "--output", directory]);
	const fixture = loadFixture(options.fixturePath);
	const contract = loadContract(options.baselinePath);
	const spec = createPlan(options, fixture, contract)[0];
	const workspace = join(directory, "workspace");
	const agentDir = join(directory, "empty-agent");
	mkdirSync(workspace); mkdirSync(agentDir);
	return { options, fixture, contract, spec, workspace, agentDir };
}

test("evaluation defaults offline, requires explicit live model/budget, and validates arguments", () => {
	assert.equal(parseOptions([]).live, false);
	assert.equal(parseOptions([]).maxCaseRequests, 8);
	assert.deepEqual(parseModel("provider/a/b"), { provider: "provider", id: "a/b" });
	assert.throws(() => parseModel("missing"));
	assert.throws(() => parseOptions(["--live"]), /explicit/);
	assert.throws(() => parseOptions(["--live", "--model", "p/m"]), /max-requests/);
	assert.throws(() => parseOptions(["--live", "--model", "p/m", "--max-requests", "2", "--dry-run"]), /mutually/);
	for (const value of ["0", "-1", "1.5", "NaN", "10001"]) assert.throws(() => parseOptions(["--max-requests", value]));
	assert.throws(() => parseOptions(["--thinking", "invented"]));
	assert.throws(() => parseOptions(["--model", "p/m", "--model", "p/m"]), /Duplicate/);
	assert.throws(() => parseOptions(["--case", "G01", "--case", "G01"]), /Duplicate/);
	assert.throws(() => parseOptions(["--unknown", "x"]), /Unknown/);
	assert.throws(() => parseOptions(["--model"]), /Missing/);
	assert.equal(parseOptions(["--live", "--model", "p/m", "--max-requests", "2"]).live, true);
});

test("bundled versioned inputs produce paired, order-balanced plans without tmp-path dependencies", () => {
	const options = parseOptions(["--model", "p/a", "--model", "q/b", "--case", "G02", "--repeat", "2"]);
	const fixture = loadFixture(options.fixturePath);
	const contract = loadContract(options.baselinePath);
	assert.deepEqual(fixture.cases.map(c => c.id), ["G01", "G02", "G07", "G08", "G09"]);
	assert.equal(fixture.cases.find(c => c.id === "G09")?.mode, "trajectory");
	assert.equal(fixture.files.size, 18);
	const plan = createPlan(options, fixture, contract);
	assert.equal(plan.length, 8);
	assert.deepEqual(plan.slice(0, 2).map(p => p.variant.name), ["baseline", "candidate"]);
	assert.deepEqual(plan.slice(4, 6).map(p => p.variant.name), ["candidate", "baseline"]);
	assert.equal(new Set(plan.map(p => p.id)).size, plan.length);
	assert.notEqual(contract.variants[0].hash, contract.variants[1].hash);
	assert.throws(() => createPlan({ ...options, caseIds: ["missing"] }, fixture, contract), /Unknown case/);
	assert.throws(() => createPlan({ ...options, models: Array(100).fill({ provider: "p", id: "m" }), repeat: 100 }, fixture, contract), /10000/);
});

test("invalid fixture paths, duplicate cases and malformed baseline fail before model setup", t => {
	const path = join(root(t), "fixture.json");
	writeFileSync(path, JSON.stringify({ name: "x", cases: [{ id: "A", prompt: "task", expected: "direct" }], files: { "../escape": ["secret"] } }));
	assert.throws(() => loadFixture(path), /traversal/i);
	writeFileSync(path, JSON.stringify({ name: "x", cases: [1], files: { a: ["x"] } }));
	assert.throws(() => loadFixture(path), /case.*object/);
	writeFileSync(path, JSON.stringify({ name: "x", cases: [{ id: "A", prompt: "task", expected: "direct", mode: "watch" }], files: { a: ["x"] } }));
	assert.throws(() => loadFixture(path), /mode/);
	writeFileSync(path, JSON.stringify({ description: "x", promptGuidelines: [] }));
	assert.throws(() => loadContract(path), /Invalid baseline/);
});

test("help and dry-run never create a model runtime or read user auth/config", async t => {
	const directory = root(t);
	const create = t.mock.method(ModelRuntime, "create", async () => { throw new Error("MODEL RUNTIME MUST NOT BE CREATED"); });
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("NETWORK FORBIDDEN"); });
	const logs: string[] = [], errors: string[] = [];
	const io = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
	assert.equal(await main(["--help"], io), 0);
	assert.match(logs[0], /Default is dry-run/);
	assert.equal(await main(["--model", "absent/model", "--agent-dir", join(directory, "nonexistent-config"), "--output", directory], io), 0);
	const last = JSON.parse(logs.at(-1)!);
	assert.equal(last.modelRequests, 0); assert.equal(last.credentialsRead, false);
	assert.equal(last.plannedCases, 10);
	const manifest = JSON.parse(readFileSync(join(last.outputDir, "manifest.json"), "utf8"));
	assert.equal(manifest.mode, "dry-run");
	assert.ok(manifest.plan.some((entry: { mode: string }) => entry.mode === "trajectory"));
	assert.deepEqual(manifest.toolNames, TOOL_NAMES);
	assert.equal(readdirSync(last.outputDir).includes("requests.jsonl"), false);
	assert.equal(await main(["--live", "--model", "p/m"], io), 2);
	assert.equal(create.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 0);
});

test("read-only credential store filters providers, clones data and refuses refresh before its callback", async () => {
	const original = { type: "oauth" as const, access: "access-secret", refresh: "refresh-secret", expires: 9999999999999 };
	let reads = 0, refreshed = false;
	const redactor = new Redactor();
	const store = readonlyCredentials(new Set(["p"]), () => { reads++; return original; }, redactor);
	assert.equal(await store.read("other"), undefined); assert.equal(reads, 0);
	const copy = await store.read("p");
	assert.ok(copy?.type === "oauth"); copy.access = "modified";
	assert.equal(original.access, "access-secret");
	assert.deepEqual(await store.list(), [{ providerId: "p", type: "oauth" }]);
	await assert.rejects(store.modify("p", async () => { refreshed = true; return original; }), /read-only/);
	await assert.rejects(store.delete("p"), /read-only/);
	assert.equal(refreshed, false);
	await assert.rejects(store.read("p", { signal: AbortSignal.abort() }));
	assert.doesNotMatch(redactor.json({ error: "access-secret refresh-secret" }), /access-secret|refresh-secret/);
});

test("rejects command-valued config/credentials and redacts before JSON escaping", async () => {
	for (const value of ["!echo key", { headers: { Authorization: " !secret" } }, { models: [{ headers: { key: "!x" } }] }]) assert.throws(() => auditConfig(value), /Command-based/);
	const redactor = new Redactor();
	const store = readonlyCredentials(new Set(["p"]), () => ({ type: "api_key", key: "!command" }), redactor);
	await assert.rejects(store.read("p"), /Command-based/);
	redactor.add('quote"and\\secret');
	assert.equal(JSON.parse(redactor.json({ value: 'quote"and\\secret' })).value, "[REDACTED]");
	assert.doesNotMatch(redactor.text("Bearer secret-token https://user:password@example.test"), /secret-token|user:password/);
});

test("configured live runtime stays offline at setup and observes resolved ambient secrets", async t => {
	const directory = root(t);
	const { runtime } = await fakeRuntime(t, directory, () => message([]));
	const secret = "ambient-secret-value";
	t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: secret } }));
	let config: Parameters<typeof ModelRuntime.create>[0];
	t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => { config = options; return runtime; });
	const options = parseOptions(["--model", "probe/model", "--agent-dir", directory]);
	const redactor = new Redactor();
	const result = await createLiveRuntime(options, directory, redactor);
	assert.equal(config?.allowModelNetwork, false); assert.equal(config?.refreshOnCreate, false);
	await result.runtime.getAuth("probe");
	assert.doesNotMatch(redactor.json({ error: `server echoed ${secret}` }), /ambient-secret-value/);
	assert.ok(config?.credentials);
});

test("Bearer headers and environment templates redact bare-token echoes", async t => {
	const token = "OFFLINE_HEADER_TOKEN_2e58a19f";
	const key = "PI_EVAL_TEST_HEADER";
	const previous = process.env[key];
	process.env[key] = `Bearer ${token}`;
	t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	const redactor = new Redactor();
	const store = readonlyCredentials(new Set(["p"]), () => ({ type: "api_key", env: { AUTH_HEADER: "${PI_EVAL_TEST_HEADER}" } }), redactor);
	await store.read("p");
	assert.doesNotMatch(redactor.json({ error: `Incorrect API key provided: ${token}` }), new RegExp(token));
	redactor.add(`Bearer ${token}-resolved`);
	assert.doesNotMatch(redactor.text(`server echoed ${token}-resolved`), /OFFLINE_HEADER_TOKEN/);
});

test("sampling cannot override model/tools/storage/output limits, including per-thinking fields", () => {
	auditSampling({ temperature: 0, top_p: 0.8, seed: 7 });
	for (const samplingParams of [
		{ model: "not-selected" }, { tools: [{ type: "web_search_preview" }] }, { store: true },
		{ max_output_tokens: 999999 }, { max_tokens: 999999 }, { input: [] }, { tool_choice: "none" },
		{ reasoning: { effort: "max" } }, { temperature: "0" }, { temperature: Infinity },
	]) assert.throws(() => auditModelSampling({ ...MODEL, samplingParams } as EvalModel), /Sampling/);
	assert.throws(() => auditModelSampling({ ...MODEL, samplingParamsByThinkingLevel: { low: { tools: [] } } } as EvalModel), /Sampling/);
});

test("final-payload guard accepts only selected-model local tools and no enabled storage/background", () => {
	const responseTools = TOOL_NAMES.map(name => ({ type: name === "codemode" ? "custom" : "function", name }));
	const chatTools = TOOL_NAMES.map(name => ({ type: "function", function: { name } }));
	validatePayload({ model: "model", tools: responseTools, store: false }, "model");
	validatePayload({ model: "model", tools: chatTools }, "model");
	for (const override of [{ model: "other" }, { store: true }, { store: "true" }, { background: true },
		{ tools: [{ type: "web_search_preview" }] }, { tools: [{ type: "mcp" }] }, { tools: [] },
		{ tools: TOOL_NAMES.map(name => ({ type: "function", name, function: { name: "external" } })) },
	]) assert.throws(() => validatePayload({ model: "model", tools: responseTools, ...override }, "model"));
});

test("live setup rejects unsafe sampling before any model request", async t => {
	const directory = root(t);
	const { runtime, requests } = await fakeRuntime(t, directory, () => message([]));
	t.mock.method(runtime, "getModel", () => ({ ...MODEL, samplingParams: { model: "not-selected", tools: [{ type: "web_search_preview" }], store: true } } as EvalModel));
	t.mock.method(ModelRuntime, "create", async () => runtime);
	const options = parseOptions(["--model", "probe/model", "--agent-dir", directory]);
	await assert.rejects(createLiveRuntime(options, directory, new Redactor()), /Sampling/);
	assert.equal(requests.mock.callCount(), 0);
});

test("actual supported SDK adapters produce guarded local-tool payloads without transport", async t => {
	const directory = root(t);
	const blockedFetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("TRANSPORT FORBIDDEN"); });
	const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: join(directory, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
	const jwt = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64url")}.offline`;
	t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: jwt } }));
	for (const api of ["openai-completions", "openai-responses", "openai-codex-responses"] as const) {
		const provider = api === "openai-codex-responses" ? "openai-codex" : "openai";
		const base = runtime.getModels(provider)[0] ?? MODEL;
		const model: EvalModel = { ...base, provider, id: "offline-model", api, baseUrl: "https://unused.invalid/v1" };
		let observed = false;
		const response = await runtime.streamSimple(model, {
			messages: [{ role: "user", content: "offline payload validation", timestamp: 0 }],
			tools: TOOL_NAMES.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
		}, { transport: "sse", maxRetries: 0, fetch: blockedFetch, onPayload(payload) {
			validatePayload(payload, model.id); observed = true; throw new Error("OFFLINE_STOP_BEFORE_TRANSPORT");
		} }).result();
		assert.equal(observed, true, `${api}: ${response.errorMessage}`);
		assert.equal(response.stopReason, "error");
	}
	assert.equal(blockedFetch.mock.callCount(), 0);
});

test("adapter payload violations become unscored environment errors before transport", async t => {
	const directory = root(t), input = setup(directory);
	const { runtime } = await fakeRuntime(t, directory, () => message([]));
	t.mock.method(runtime, "streamSimple", (_model: EvalModel, _context: unknown, options: Parameters<ModelRuntime["streamSimple"]>[2]) => {
		const events = createAssistantMessageEventStream();
		void (async () => {
			try { await options?.onPayload?.({ model: "other", tools: [{ type: "web_search_preview" }], store: true }, MODEL); events.push({ type: "done", reason: "stop", message: message([]) }); }
			catch (error) { events.push({ type: "error", reason: "error", error: message([], "error", (error as Error).message) }); }
			events.end();
		})();
		return events;
	});
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(2) });
	assert.equal(result.validity, "environment_error"); assert.equal(result.matchesExpectation, null);
	assert.equal(result.agentInvocations.length, 0);
});

test("inconclusive states never become direct routing failures", () => {
	for (const validity of ["request_budget", "request_timeout", "case_timeout", "cancelled", "output_truncated", "provider_error", "environment_error", "not_run"] as const) {
		assert.equal(adjudicate(validity, false, "delegate").matchesExpectation, null);
	}
	assert.deepEqual(adjudicate("decision_observed", true, "delegate"), { decision: "delegated", matchesExpectation: true });
	assert.equal(adjudicate("request_budget", true, "delegate").matchesExpectation, true);
	assert.equal(adjudicate("request_budget", true, "direct").matchesExpectation, false);
	assert.equal(adjudicate("decision_observed", true, "direct").matchesExpectation, false);
	assert.equal(adjudicate("model_stopped", false, "delegate").matchesExpectation, false);
	const budget = new RequestBudget(2);
	assert.equal(budget.take(), true); assert.equal(budget.take(), true); assert.equal(budget.take(), false);
	assert.equal(budget.used, 2);
});

test("real SDK fake-stream run observes delegation without executing a child or exposing host tools", async t => {
	const directory = root(t), input = setup(directory);
	let contextText = "";
	const { runtime, requests } = await fakeRuntime(t, directory, (_n, context) => {
		contextText = JSON.stringify(context);
		return message([{ type: "toolCall", id: "delegate", name: "agent", arguments: { description: "Inspect alpha only", prompt: "Read-only inspect extensions/alpha; cite source locations. No writes." } }], "toolUse");
	});
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });
	assert.equal(result.validity, "decision_observed"); assert.equal(result.decision, "delegated");
	assert.equal(result.matchesExpectation, true); assert.equal(result.agentInvocations.length, 1);
	assert.equal(result.agentInvocations[0].request, 1); assert.equal(result.childExecution, false);
	assert.equal(result.requests, 1); assert.equal(requests.mock.callCount(), 1);
	assert.ok(contextText.includes(BASE_CONTEXT)); assert.ok(!contextText.includes("Additional docs:"));
	assert.ok(!contextText.includes('"name":"bash"')); assert.ok(!contextText.includes('"name":"write"'));
	assert.equal(result.usage.totalTokens, 5);
});

test("trajectory cases observe repeated agent calls and post-delegation duplicate reads", async t => {
	const directory = root(t), input = setup(directory, "G09");
	const replies = [
		message([{ type: "toolCall", id: "read-before", name: "read", arguments: { path: "./extensions/alpha/src/batcher.ts", limit: 5 } }], "toolUse"),
		message([{ type: "toolCall", id: "delegate-1", name: "agent", arguments: { description: "Inspect alpha", prompt: "Read-only inspect alpha; cite evidence." } }], "toolUse"),
		message([{ type: "toolCall", id: "read-after", name: "read", arguments: { path: "extensions/alpha/src/batcher.ts", limit: 5 } }], "toolUse"),
		message([{ type: "toolCall", id: "delegate-2", name: "agent", arguments: { description: "Inspect beta", prompt: "Read-only inspect beta; cite evidence." } }], "toolUse"),
		message([{ type: "text", text: "Synthesized answer" }]),
	];
	const { runtime, requests } = await fakeRuntime(t, directory, n => replies[n - 1] ?? message([{ type: "text", text: "done" }]));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });

	assert.equal(result.mode, "trajectory");
	assert.equal(result.validity, "decision_observed");
	assert.equal(result.agentCallCount, 2);
	assert.equal(result.agentInvocations.length, 2);
	assert.equal(result.requests, 5);
	assert.equal(result.postDelegationAccesses, 1);
	assert.equal(result.duplicatePostDelegationAccesses, 1);
	assert.deepEqual(result.accesses.map(access => access.afterDelegation), [false, true]);
	assert.equal(result.matchesExpectation, true);
	assert.equal(requests.mock.callCount(), 5);
	const summary = summarize([result]);
	assert.equal(summary.agentCalls, 2);
	assert.equal(summary.casesWithMultipleAgentCalls, 1);
	assert.equal(summary.postDelegationAccesses, 1);
	assert.equal(summary.duplicatePostDelegationAccesses, 1);
});

test("reads in the delegation turn are not counted as post-delegation", async t => {
	const directory = root(t), input = setup(directory, "G09");
	const { runtime } = await fakeRuntime(t, directory, n => n === 1
		? message([
			{ type: "toolCall", id: "delegate", name: "agent", arguments: { description: "Inspect alpha", prompt: "Read-only inspect alpha." } },
			{ type: "toolCall", id: "read-same", name: "read", arguments: { path: "extensions/alpha/src/batcher.ts", limit: 5 } },
		], "toolUse")
		: message([{ type: "text", text: "done" }]));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(4) });

	assert.equal(result.agentCallCount, 1);
	assert.equal(result.requests, 2);
	assert.equal(result.postDelegationAccesses, 0);
	assert.equal(result.duplicatePostDelegationAccesses, 0);
});

test("an observed trajectory delegation still matches routing when the request budget ends", async t => {
	const directory = root(t), input = setup(directory, "G09");
	input.options.maxCaseRequests = 2;
	const { runtime } = await fakeRuntime(t, directory, n => message([
		{ type: "toolCall", id: `delegate-${n}`, name: "agent", arguments: { description: "Inspect", prompt: "Read-only inspect alpha." } },
	], "toolUse"));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });

	assert.equal(result.validity, "request_budget");
	assert.equal(result.agentCallCount, 2);
	assert.equal(result.matchesExpectation, true);
	assert.equal(result.decision, "delegated");
});

test("direct stop is recorded separately from task completeness and private thinking is not logged", async t => {
	const directory = root(t), input = setup(directory, "G01");
	const { runtime } = await fakeRuntime(t, directory, () => message([{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "text", text: "Project overview" }]));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });
	assert.equal(result.validity, "model_stopped"); assert.equal(result.decision, "direct_stop");
	assert.equal(result.matchesExpectation, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_THOUGHT/);
});

test("per-case budget stops a real SDK loop, and output/provider errors stay inconclusive", async t => {
	const directory = root(t), input = setup(directory);
	input.options.maxCaseRequests = 2;
	const { runtime, requests } = await fakeRuntime(t, directory, n => message([{ type: "toolCall", id: `list-${n}`, name: "ls", arguments: {} }], "toolUse"));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });
	assert.equal(result.validity, "request_budget"); assert.equal(result.matchesExpectation, null);
	assert.equal(requests.mock.callCount(), 2); assert.equal(result.requests, 2);
	for (const stopReason of ["length", "error"] as const) {
		t.mock.method(runtime, "streamSimple", () => stream(message([], stopReason, stopReason === "error" ? "429 provider busy" : undefined)));
		const next = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(8) });
		assert.equal(next.validity, stopReason === "length" ? "output_truncated" : "provider_error");
		assert.equal(next.matchesExpectation, null);
	}
});

test("codemode nested agent invocations are observed once through the real sandbox", async t => {
	const directory = root(t), input = setup(directory);
	const { runtime, requests } = await fakeRuntime(t, directory, () => message([{ type: "toolCall", id: "script", name: "codemode", arguments: { code: "text(await tools.ls({})); text(await tools.read({path:'README.md',limit:2})); text(await tools.agent({description:'Inspect alpha only',prompt:'Read-only inspect extensions/alpha and cite source evidence.'}));" } }], "toolUse"));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(3) });
	assert.equal(result.validity, "decision_observed"); assert.equal(result.matchesExpectation, true);
	assert.equal(result.agentInvocations.length, 1); assert.match(result.agentInvocations[0].id, /script\//);
	assert.equal(result.requests, 1); assert.equal(requests.mock.callCount(), 1);
	assert.deepEqual(result.accesses.map(a => a.tool), ["ls", "read"]);
});

test("cooperative request and case deadlines stop fake streams without scoring routing failure", async t => {
	const directory = root(t), input = setup(directory);
	const { runtime } = await fakeRuntime(t, directory, () => message([]));
	t.mock.method(runtime, "streamSimple", (_model: EvalModel, _context: unknown, options: Parameters<ModelRuntime["streamSimple"]>[2]) => {
		const events = createAssistantMessageEventStream();
		const stop = () => { events.push({ type: "error", reason: "aborted", error: message([], "aborted", "cooperative test cancellation") }); events.end(); };
		if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true });
		return events;
	});
	for (const kind of ["request_timeout", "case_timeout"] as const) {
		input.options.requestTimeoutMs = kind === "request_timeout" ? 20 : 1000;
		input.options.caseTimeoutMs = kind === "case_timeout" ? 20 : 1000;
		const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(2) });
		assert.equal(result.validity, kind); assert.equal(result.matchesExpectation, null); assert.equal(result.requests, 1);
	}
});

test("provider errors are not retried or counted as routing failures in later cases", async t => {
	const directory = root(t);
	const { runtime, requests } = await fakeRuntime(t, directory, () => message([], "error", "429 provider busy"));
	t.mock.method(ModelRuntime, "create", async () => runtime);
	const logs: string[] = [], errors: string[] = [];
	const exit = await main(["--live", "--model", "probe/model", "--case", "G02", "--max-requests", "8", "--agent-dir", directory, "--output", directory], { log: s => logs.push(s), error: s => errors.push(s) });
	assert.equal(exit, 2); assert.deepEqual(errors, []); assert.equal(requests.mock.callCount(), 1);
	const summary = JSON.parse(readFileSync(join(JSON.parse(logs.at(-1)!).outputDir, "summary.json"), "utf8"));
	assert.deepEqual(summary.cases.map((c: {validity:string}) => c.validity), ["provider_error", "not_run"]);
	assert.equal(summary.observed, 0); assert.equal(summary.routingMismatches, 0); assert.equal(summary.inconclusive, 2);
});

test("pre-cancelled case never starts a request and is not scored", async t => {
	const directory = root(t), input = setup(directory);
	const { runtime, requests } = await fakeRuntime(t, directory, () => message([]));
	const result = await runCase({ ...input, runtime, model: MODEL, budget: new RequestBudget(1), signal: AbortSignal.abort() });
	assert.equal(result.validity, "cancelled"); assert.equal(result.requests, 0);
	assert.equal(result.matchesExpectation, null); assert.equal(requests.mock.callCount(), 0);
});

test("CLI live-path test uses fake runtime only, persists traces and enforces total budget", async t => {
	const directory = root(t);
	const { runtime, requests } = await fakeRuntime(t, directory, () => message([{ type: "toolCall", id: "delegate", name: "agent", arguments: { description: "Inspect module", prompt: "Read-only inspect alpha." } }], "toolUse"));
	t.mock.method(ModelRuntime, "create", async () => runtime);
	const logs: string[] = [], errors: string[] = [];
	const exit = await main(["--live", "--model", "probe/model", "--case", "G02", "--max-requests", "1", "--agent-dir", directory, "--output", directory], { log: s => logs.push(s), error: s => errors.push(s) });
	assert.equal(exit, 2); assert.deepEqual(errors, []); assert.equal(requests.mock.callCount(), 1);
	const final = JSON.parse(logs.at(-1)!);
	assert.equal(final.requests, 1); assert.equal(final.observed, 1); assert.equal(final.inconclusive, 1);
	const results = JSON.parse(readFileSync(join(final.outputDir, "summary.json"), "utf8"));
	assert.equal(results.modelStartAttempts, 1); assert.equal(results.childExecution, false);
	assert.equal(readFileSync(join(final.outputDir, "requests.jsonl"), "utf8").trim().split("\n").length, 1);
	assert.match(readFileSync(join(final.outputDir, "report.md"), "utf8"), /not proof of task quality/);
	const options = parseOptions(["--model", "probe/model", "--case", "G02"]);
	const fixture = loadFixture(options.fixturePath), contract = loadContract(options.baselinePath);
	assert.equal(summarize([skipped(createPlan(options, fixture, contract)[0], fixture, options, "not attempted")]).inconclusive, 1);
});
