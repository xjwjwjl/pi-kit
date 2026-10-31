import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
	readStoredCredential, SessionManager, SettingsManager,
	type AgentSession, type CreateAgentSessionOptions, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { BASE_CONTEXT, TOOL_NAMES, hash, type AgentContract, type CaseSpec, type Fixture, type Options } from "./config.ts";
import { createReadOnlyTools, type FixtureAccess } from "./environment.ts";

export type EvalModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export type Validity = "decision_observed" | "model_stopped" | "request_budget" | "request_timeout" | "case_timeout" | "cancelled" | "output_truncated" | "provider_error" | "environment_error" | "not_run";
export interface AgentInvocation { id: string; args: unknown; request: number }
export interface PublicMessage {
	stopReason: string; errorMessage?: string; usage: AssistantMessage["usage"];
	content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: unknown }>;
}
export interface CaseResult {
	id: string; model: string; caseId: string; variant: string; repeat: number; expected: "direct" | "delegate";
	mode: "decision" | "trajectory";
	decision: "delegated" | "direct_stop" | "unresolved"; validity: Validity; matchesExpectation: boolean | null;
	requests: number; durationMs: number; promptHash: string; systemHash?: string; fixtureHash: string;
	requestedThinking: string; actualThinking?: string; childExecution: false; error?: string; httpStatus?: number;
	agentInvocations: AgentInvocation[]; agentCallCount: number;
	accesses: FixtureAccess[]; postDelegationAccesses: number; duplicatePostDelegationAccesses: number;
	messages: PublicMessage[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; estimatedCost: number };
}

export class RequestBudget {
	used = 0;
	readonly limit: number;
	constructor(limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid total request budget");
		this.limit = limit;
	}
	take(): boolean {
		if (this.used >= this.limit) return false;
		this.used++;
		return true;
	}
}

/** Redact values before JSON escaping; never serialize request auth or private thinking. */
export class Redactor {
	private secrets = new Set<string>();
	add(value: unknown): void {
		if (typeof value !== "string" || value.length < 4) return;
		this.secrets.add(value);
		const authorization = /^\s*(?:Bearer|Basic)\s+(\S+)\s*$/i.exec(value);
		if (authorization?.[1].length && authorization[1].length >= 4) this.secrets.add(authorization[1]);
	}
	text(value: string): string {
		let text = value;
		for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[REDACTED]");
		return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]").replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
	}
	json(value: unknown, space = 2): string { return JSON.stringify(value, (_key, item) => typeof item === "string" ? this.text(item) : item, space); }
}

/** Reject executable config values, including model headers and stored key/env values. */
export function auditConfig(value: unknown): void {
	if (typeof value === "string" && value.trimStart().startsWith("!")) throw new Error("Command-based configuration is not allowed in evaluations");
	if (Array.isArray(value)) for (const entry of value) auditConfig(entry);
	else if (value && typeof value === "object") for (const entry of Object.values(value)) auditConfig(entry);
}

function collectSecrets(value: unknown, redactor: Redactor, secretField = false): void {
	if (typeof value === "string") {
		if (secretField) {
			redactor.add(value); redactor.add(process.env[value]);
			for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) redactor.add(process.env[match[1] ?? match[2]]);
		}
		try {
			const url = new URL(value);
			redactor.add(url.username); redactor.add(url.password);
			for (const [key, text] of url.searchParams) if (/key|token|secret|auth/i.test(key)) redactor.add(text);
		} catch { /* Most configuration strings are not URLs. */ }
	} else if (Array.isArray(value)) {
		for (const item of value) collectSecrets(item, redactor, secretField);
	} else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) collectSecrets(item, redactor, secretField || /api.?key|access|refresh|token|authorization|password|secret|headers|^key$|^env$/i.test(key));
	}
}

export function readonlyCredentials(
	providers: ReadonlySet<string>, read: (id: string) => Credential | undefined, redactor: Redactor,
): CredentialStore {
	return {
		async read(id, options) {
			options?.signal?.throwIfAborted();
			if (!providers.has(id)) return undefined;
			let value: Credential | undefined;
			try { value = read(id); } catch { throw new Error(`Cannot read stored credentials for ${id}`); }
			auditConfig(value);
			collectSecrets(value, redactor);
			return value === undefined ? undefined : structuredClone(value);
		},
		async list(options) {
			const entries = [];
			for (const providerId of providers) {
				const value = await this.read(providerId, options);
				if (value) entries.push({ providerId, type: value.type });
			}
			return entries;
		},
		// Do not invoke modify's callback: OAuth refresh can occur inside it.
		async modify() { throw new Error("Evaluation credentials are read-only; refresh/modification is forbidden"); },
		async delete() { throw new Error("Evaluation credentials are read-only; deletion is forbidden"); },
	};
}

const SAFE_SAMPLING = new Set(["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"]);
export function auditSampling(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid evaluation sampling parameters");
	for (const [key, item] of Object.entries(value)) {
		if (!SAFE_SAMPLING.has(key) || typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Sampling parameter is not allowed in evaluations: ${key}`);
	}
}
export function auditModelSampling(model: EvalModel): void {
	auditSampling(model.samplingParams);
	if (model.samplingParamsByThinkingLevel) for (const value of Object.values(model.samplingParamsByThinkingLevel)) auditSampling(value);
}

/** Check the final adapter payload, after model sampling and extension transformations. */
export function validatePayload(value: unknown, modelId: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid evaluation payload");
	const payload = value as Record<string, unknown>;
	if (payload.model !== modelId || (payload.store !== undefined && payload.store !== false) || (payload.background !== undefined && payload.background !== false)) throw new Error("Evaluation model/storage boundary was overridden");
	if (!Array.isArray(payload.tools)) throw new Error("Evaluation tools missing from payload");
	const names: string[] = [];
	for (const value of payload.tools) {
		const tool = value as { type?: string; name?: string; function?: { name?: string } } | null;
		if (!tool || !["function", "custom"].includes(tool.type ?? "")) throw new Error("Native/external tools are forbidden in evaluations");
		if (tool.name && tool.function?.name && tool.name !== tool.function.name) throw new Error("Conflicting tool names in evaluation payload");
		const name = tool.name ?? tool.function?.name;
		if (!name || !TOOL_NAMES.includes(name) || (tool.type === "custom" && name !== "codemode")) throw new Error("Unexpected tool in evaluation payload");
		names.push(name);
	}
	if (names.length !== TOOL_NAMES.length || new Set(names).size !== TOOL_NAMES.length) throw new Error("Evaluation tool declarations changed");
}

export async function createLiveRuntime(options: Options, outputDir: string, redactor: Redactor) {
	const modelsPath = join(options.agentDir, "models.json");
	const configData = existsSync(modelsPath) ? readFileSync(modelsPath) : undefined;
	let config: Record<string, unknown> = {};
	if (configData !== undefined) {
		try { config = JSON.parse(configData.toString("utf8")); } catch { throw new Error("Cannot parse model configuration"); }
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Model configuration must be an object");
	}
	const providers = new Set(options.models.map(model => model.provider));
	const definitions = config.providers as Record<string, unknown> | undefined;
	for (const id of providers) { auditConfig(definitions?.[id]); collectSecrets(definitions?.[id], redactor); }
	const credentials = readonlyCredentials(providers, id => readStoredCredential(id, join(options.agentDir, "auth.json")), redactor);
	const runtime = await ModelRuntime.create({
		credentials, modelsPath: configData !== undefined ? modelsPath : null,
		modelsStorePath: join(outputDir, "catalog-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
	});
	if (configData !== undefined && !readFileSync(modelsPath).equals(configData)) throw new Error("Model configuration changed during setup; start a fresh run");
	// Observe resolved auth as well as stored/configured values (for ambient API-key sources).
	const getAuth = runtime.getAuth.bind(runtime);
	runtime.getAuth = (async (...args: Parameters<ModelRuntime["getAuth"]>) => {
		const auth = await getAuth(...args);
		collectSecrets(auth?.auth, redactor, true);
		return auth;
	}) as ModelRuntime["getAuth"];
	const models = new Map<string, EvalModel>();
	for (const ref of options.models) {
		const key = `${ref.provider}/${ref.id}`;
		const model = runtime.getModel(ref.provider, ref.id);
		if (!model) throw new Error(`Model unavailable in local configuration: ${key}`);
		if (!["openai-codex-responses", "openai-completions", "openai-responses"].includes(model.api)) throw new Error(`Unsupported evaluation API: ${model.api}`);
		auditModelSampling(model);
		models.set(key, model);
	}
	return { runtime, models, modelsConfigHash: configData === undefined ? null : hash(configData) };
}

export function adjudicate(validity: Validity, delegated: boolean, expected: CaseResult["expected"]) {
	const decision = delegated ? "delegated" : validity === "model_stopped" ? "direct_stop" : "unresolved";
	return {
		decision: decision as CaseResult["decision"],
		// A delegation is already observed even if a trajectory later exhausts its
		// request budget; only the remaining trajectory metrics are incomplete.
		matchesExpectation: validity === "decision_observed" || validity === "model_stopped" || (validity === "request_budget" && delegated)
			? (decision === "delegated") === (expected === "delegate") : null,
	};
}

export function skipped(spec: CaseSpec, fixture: Fixture, options: Options, reason: string): CaseResult {
	return {
		id: spec.id, model: `${spec.model.provider}/${spec.model.id}`, caseId: spec.scenario.id, variant: spec.variant.name,
		repeat: spec.repeat, expected: spec.scenario.expected, mode: spec.scenario.mode ?? "decision",
		...adjudicate("not_run", false, spec.scenario.expected),
		validity: "not_run", requests: 0, durationMs: 0, promptHash: spec.variant.hash, fixtureHash: fixture.hash,
		requestedThinking: options.thinking, childExecution: false, error: reason,
		agentInvocations: [], agentCallCount: 0, accesses: [], postDelegationAccesses: 0, duplicatePostDelegationAccesses: 0,
		messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedCost: 0 },
	};
}

export async function runCase(input: {
	spec: CaseSpec; options: Options; fixture: Fixture; contract: AgentContract; runtime: ModelRuntime; model: EvalModel;
	budget: RequestBudget; workspace: string; agentDir: string; signal?: AbortSignal;
	onRequest?: (event: { id: string; request: number; total: number; model: string; timestamp: string }) => void;
}): Promise<CaseResult> {
	const { spec, options, fixture, contract, runtime, model, budget } = input;
	const result = skipped(spec, fixture, options, "");
	delete result.error;
	const trajectory = spec.scenario.mode === "trajectory";
	let validity: Validity | undefined;
	const controller = new AbortController();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const started = Date.now();
	let session: AgentSession | undefined;
	const cancel = () => { validity ??= "cancelled"; controller.abort(); void session?.abort(); };
	input.signal?.addEventListener("abort", cancel, { once: true });
	const deadline = setTimeout(() => { validity ??= "case_timeout"; controller.abort(); void session?.abort(); }, options.caseTimeoutMs);
	const stop = (reason: Validity): never => { validity ??= reason; throw new Error(`EVALUATION_STOP:${reason}`); };
	const proxy = new Proxy(runtime, {
		get(target, property) {
			if (property === "streamSimple") return (requestModel: EvalModel, context: Parameters<ModelRuntime["streamSimple"]>[1], requestOptions: Parameters<ModelRuntime["streamSimple"]>[2] = {}) => {
				if (result.agentInvocations.length && !trajectory) stop("decision_observed");
				if (controller.signal.aborted) stop(validity ?? "cancelled");
				if (requestModel.provider !== model.provider || requestModel.id !== model.id) stop("environment_error");
				try { auditModelSampling(requestModel); auditSampling(requestOptions.samplingParams); }
				catch (error) { validity = "environment_error"; throw error; }
				if (result.requests >= options.maxCaseRequests || !budget.take()) stop("request_budget");
				result.requests++;
				try { input.onRequest?.({ id: result.id, request: result.requests, total: budget.used, model: result.model, timestamp: new Date().toISOString() }); }
				catch { stop("environment_error"); }
				const timer = setTimeout(() => { validity ??= "request_timeout"; controller.abort(); void session?.abort(); }, options.requestTimeoutMs);
				timers.add(timer);
				const clear = () => { clearTimeout(timer); timers.delete(timer); };
				try {
					const stream = target.streamSimple(requestModel, context, {
						...requestOptions, signal: AbortSignal.any([controller.signal, requestOptions.signal ?? controller.signal]),
						timeoutMs: options.requestTimeoutMs, maxRetries: 0, transport: "sse", cacheRetention: "none", sessionId: undefined,
						maxTokens: Math.min(options.maxOutputTokens, model.maxTokens),
						async onPayload(payload, actualModel) {
							const transformed = await requestOptions.onPayload?.(payload, actualModel);
							try { validatePayload(transformed ?? payload, model.id); }
							catch (error) { validity = "environment_error"; throw error; }
							return transformed;
						},
						onResponse(response, actualModel) { result.httpStatus = response.status; return requestOptions.onResponse?.(response, actualModel); },
					});
					void stream.result().then(clear, clear);
					return stream;
				} catch (error) { clear(); throw error; }
			};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	try {
		if (input.signal?.aborted) cancel();
		if (controller.signal.aborted) stop("cancelled");
		const settingsManager = SettingsManager.inMemory({
			extensions: [], packages: [], cacheWarming: "off", compaction: { enabled: false }, transport: "sse",
			retry: { enabled: false, maxRetries: 0, provider: { timeoutMs: options.requestTimeoutMs, maxRetries: 0 } },
		});
		// Tag reads that happen after an agent call. The count is a descriptive signal
		// for duplicate work/verification, not a correctness judgment.
		const tools = createReadOnlyTools(input.workspace, fixture.files, entry => {
			const firstAgentRequest = result.agentInvocations[0]?.request;
			result.accesses.push({
				...entry,
				// Reads in the delegation turn run before the parent receives the tool
				// result. Only reads in a later model request count as post-delegation.
				afterDelegation: firstAgentRequest !== undefined && result.requests > firstAgentRequest,
			});
		});
		const agent: ToolDefinition = {
			name: "agent", label: "Agent", description: spec.variant.description, parameters: contract.parameters,
			promptSnippet: contract.promptSnippet, promptGuidelines: spec.variant.promptGuidelines,
			async execute(id, args) {
				result.agentInvocations.push({ id, args, request: result.requests });
				return {
					content: [{ type: "text", text: trajectory
						? "Completed. The delegated scope was inspected and the findings are ready for the delegating agent's synthesis."
						: "Delegation decision observed; no child was executed." }],
					details: { evaluation: true },
					// Decision cases stop at the first observable call. Trajectory cases let the
					// parent continue after a stub result so later calls and reads are observable.
					...(trajectory ? {} : { terminate: true }),
				};
			},
		};
		const loader = new DefaultResourceLoader({
			cwd: input.workspace, agentDir: input.agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			agentsFilesOverride: () => ({ agentsFiles: fixture.files.has("AGENTS.md") ? [{ path: join(input.workspace, "AGENTS.md"), content: fixture.files.get("AGENTS.md")! }] : [] }),
			extensionFactories: [createCodemodeExtension({ models: false }), pi => {
				pi.on("before_agent_start", event => { event.systemPromptOptions.sections.docs = BASE_CONTEXT; });
			}],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: input.workspace, agentDir: input.agentDir, modelRuntime: proxy,
			model: model as NonNullable<CreateAgentSessionOptions["model"]>, thinkingLevel: options.thinking,
			tools: TOOL_NAMES, customTools: [...tools, agent], resourceLoader: loader, settingsManager,
			sessionManager: SessionManager.inMemory(input.workspace),
		}));
		result.actualThinking = session.thinkingLevel;
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const message = event.message;
			if (message.errorMessage?.includes("EVALUATION_STOP:")) return;
			result.messages.push({
				stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage,
				content: message.content.flatMap<PublicMessage["content"][number]>(part => part.type === "text" ? [{ type: "text" as const, text: part.text }] : part.type === "toolCall" ? [{ type: "toolCall" as const, id: part.id, name: part.name, arguments: part.arguments }] : []),
			});
		});
		await session.prompt(spec.scenario.prompt, { expandPromptTemplates: false });
		result.systemHash = hash(session.systemPrompt);
		const last = result.messages.at(-1);
		if (!validity) validity = result.agentInvocations.length ? "decision_observed" : last?.stopReason === "stop" ? "model_stopped" : last?.stopReason === "length" ? "output_truncated" : last?.stopReason === "aborted" ? "cancelled" : "provider_error";
		if (last?.errorMessage) result.error = last.errorMessage;
	} catch (error) {
		validity ??= result.requests ? "provider_error" : "environment_error";
		if (!(error instanceof Error && error.message.startsWith("EVALUATION_STOP:"))) result.error = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(deadline);
		for (const timer of timers) clearTimeout(timer);
		input.signal?.removeEventListener("abort", cancel);
		session?.dispose();
	}
	result.validity = validity ?? "environment_error";
	result.agentCallCount = result.agentInvocations.length;
	const accessKey = (entry: FixtureAccess): string => `${entry.tool}:${entry.key ?? entry.path}`;
	const beforeDelegation = new Set(result.accesses
		.filter(entry => entry.afterDelegation !== true)
		.map(accessKey));
	result.postDelegationAccesses = result.accesses.filter(entry => entry.afterDelegation === true).length;
	result.duplicatePostDelegationAccesses = result.accesses.filter(entry =>
		entry.afterDelegation === true && beforeDelegation.has(accessKey(entry))).length;
	Object.assign(result, adjudicate(result.validity, result.agentInvocations.length > 0, result.expected));
	result.durationMs = Date.now() - started;
	for (const message of result.messages) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result.usage[key] += message.usage[key] ?? 0;
		result.usage.estimatedCost += message.usage.cost?.total ?? 0;
	}
	return result;
}
