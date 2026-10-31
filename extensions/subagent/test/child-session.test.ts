import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CHILD_MODEL_RUNTIME_MUTATION, createChildSession, disposeChildSession } from "../src/runner.ts";

/** A minimal model, so session creation does not need credentials or a catalog. */
const MODEL = {
	provider: "probe",
	id: "probe",
	name: "probe",
	api: "openai-completions",
	input: ["text"],
	contextWindow: 10_000,
	maxTokens: 1_000,
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A throwaway extension that registers one tool, written outside the repo. */
const PROBE_EXTENSION = `
export default (pi) => {
	pi.registerTool({
		name: "probe_tool",
		label: "Probe",
		description: "probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
};
`;

function tempProject(t: { after: (fn: () => void) => void }): { cwd: string; agentDir: string; extension: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-child-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const extension = join(root, "probe-extension.ts");
	writeFileSync(extension, PROBE_EXTENSION);
	return { cwd, agentDir, extension };
}

test("a requested extension is loaded in the child, with its tool", async (t) => {
	const { cwd, agentDir, extension } = tempProject(t);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: [extension],
		tools: ["+probe_tool"],
	});
	t.after(() => session.dispose());

	const names = session.getAllTools().map((tool) => tool.name);
	assert.ok(names.includes("probe_tool"), `expected probe_tool in ${names.join(", ")}`);
	assert.ok(!names.includes("agent"), "the subagent tools stay excluded");
	assert.ok(!names.includes("ask_user"), "a child has no user to ask");
});

test("a requested built-in extension is loaded by its builtin: path", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: ["builtin:codemode"],
		tools: ["+codemode"],
	});
	t.after(() => session.dispose());

	const names = session.getAllTools().map((tool) => tool.name);
	assert.ok(names.includes("codemode"), `expected codemode in ${names.join(", ")}`);
});

test("a requested extension that cannot load fails instead of silently missing", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: {} as ModelRegistry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: ["builtin:does-not-exist"],
			}),
		/Could not load the requested extension/,
	);
});

test("a registry without the private runtime fails instead of silently losing credentials", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	// `Object.create` gives a real `ModelRegistry` instance (so `instanceof` holds)
	// with no `runtime` on it — what a Pi that renamed or dropped the private field
	// would look like. Falling back to a runtime built from `agentDir` there would
	// only surface as a bare "fetch failed" on the first prompt, so it must be a
	// clear error instead.
	const registry = Object.create(ModelRegistry.prototype) as ModelRegistry;

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: registry,
				model: MODEL as never,
				prompt: "x",
			}),
		/no longer exposes the model runtime/,
	);
});

test("no extension is loaded when none is requested", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
	});
	t.after(() => session.dispose());

	const names = session.getAllTools().map((tool) => tool.name);
	assert.ok(!names.includes("probe_tool"), `the unrequested extension must not load: ${names.join(", ")}`);
	assert.ok(names.includes("read"), "built-in tools are still there");
});

test("an explicit empty tool list gives the child no tools", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	// `[]` is an allowlist that happens to be empty, not a missing one. Skipping it
	// here is what gave a "no tools" definition the child's default tools.
	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		tools: [],
	});
	t.after(() => session.dispose());

	assert.deepEqual(session.getActiveToolNames(), [], "an empty allowlist activates no tools");
	const names: string[] = session.getAllTools().map((tool) => tool.name);
	assert.ok(!names.includes("read"), `a built-in tool must not be available: ${names.join(", ")}`);
	assert.equal(names.length, 0, `an empty allowlist registers nothing: ${names.join(", ")}`);
});

/** Write `.pi/APPEND_SYSTEM.md` in the project, returning its unique marker. */
function projectAppendSystemPrompt(cwd: string): string {
	const marker = `APPENDED-PROJECT-PROMPT-${Math.random().toString(36).slice(2, 10)}`;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), `${marker}\n`);
	return marker;
}

// The child session is created without a caller-supplied settings manager unless
// the runner makes one, and Pi's default is `projectTrusted: true`. An untrusted
// project's `.pi/APPEND_SYSTEM.md` would then be injected into a child whose
// parent had just refused to trust that project — the trust decision has to reach
// the child, not stop at agent discovery.
test("an untrusted project's APPEND_SYSTEM.md stays out of the child prompt", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const marker = projectAppendSystemPrompt(cwd);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		trusted: false,
	});
	t.after(() => session.dispose());

	assert.ok(
		!session.systemPrompt.includes(marker),
		"an untrusted project must not inject its append system prompt into the child",
	);
});

test("a trusted project's APPEND_SYSTEM.md still reaches the child prompt", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const marker = projectAppendSystemPrompt(cwd);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		trusted: true,
	});
	t.after(() => session.dispose());

	assert.ok(
		session.systemPrompt.includes(marker),
		"a trusted project's append system prompt is part of the child's prompt",
	);
});

test("a child session starts and shuts down its extensions", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const key = `__subagentLifecycleProbe${Math.random().toString(36).slice(2)}`;
	const lifecycle = join(agentDir, "..", "lifecycle.ts");
	writeFileSync(
		lifecycle,
		`
const state = (globalThis[${JSON.stringify(key)}] ??= { start: 0, shutdown: 0 });
export default (pi) => {
	pi.on("session_start", () => { state.start += 1; });
	pi.on("session_shutdown", () => { state.shutdown += 1; });
};
`,
	);

	type Probe = { start: number; shutdown: number };
	const probe = (): Probe | undefined => (globalThis as unknown as Record<string, Probe>)[key];
	t.after(() => {
		delete (globalThis as unknown as Record<string, Probe>)[key];
	});

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: [lifecycle],
	});

	assert.equal(probe()?.start, 1, "session_start must fire before the child is returned");

	await disposeChildSession(session);
	assert.equal(probe()?.shutdown, 1, "session_shutdown must fire before the session is disposed");
});

test("disposeChildSession reports real SDK shutdown handler failures", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const lifecycle = join(agentDir, "..", "throwing-shutdown.ts");
	writeFileSync(lifecycle, `
export default (pi) => {
	pi.on("session_shutdown", () => { throw new Error("SHUTDOWN_SYNC_BOOM"); });
	pi.on("session_shutdown", async () => { throw new Error("SHUTDOWN_ASYNC_BOOM"); });
};
`);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: [lifecycle],
	});
	const warning = await disposeChildSession(session);
	assert.match(warning ?? "", /SHUTDOWN_SYNC_BOOM/);
	assert.match(warning ?? "", /SHUTDOWN_ASYNC_BOOM/);
});

test("disposeChildSession emits session_shutdown before dispose", async () => {
	const order: string[] = [];
	const session = {
		extensionRunner: {
			emit: async (event: { type: string }) => {
				order.push(event.type);
			},
		},
		dispose: () => {
			order.push("dispose");
		},
	} as unknown as Parameters<typeof disposeChildSession>[0];

	await disposeChildSession(session);
	assert.deepEqual(order, ["session_shutdown", "dispose"]);
});

test("disposeChildSession reports shutdown and dispose failures", async () => {
	const session = {
		extensionRunner: { emit: async () => { throw new Error("shutdown boom"); } },
		dispose: () => { throw new Error("dispose boom"); },
	} as unknown as Parameters<typeof disposeChildSession>[0];

	const warning = await disposeChildSession(session);
	assert.match(warning ?? "", /shutdown boom/);
	assert.match(warning ?? "", /dispose boom/);
});

test("disposeChildSession reports a shutdown timeout", async () => {
	const session = {
		extensionRunner: { emit: () => new Promise(() => {}) },
		dispose: async () => {},
	} as unknown as Parameters<typeof disposeChildSession>[0];

	const warning = await disposeChildSession(session, 5);
	assert.match(warning ?? "", /timed out after 5ms/);
});

test("a session-creation failure rejects after loader.reload", async (t) => {
	const { cwd } = tempProject(t);
	// Make the session directory creation fail after the loader has already
	// registered extensions, exercising the cleanup path.
	const agentDir = join(cwd, "agent-file");
	writeFileSync(agentDir, "not a directory");
	await assert.rejects(
		() => createChildSession({
			cwd,
			agentDir,
			modelRegistry: {} as ModelRegistry,
			model: MODEL as never,
			prompt: "x",
		}),
		/not a directory|ENOTDIR/,
	);
});

/** A provider extension, written to the temporary project. */
function providerExtension(path: string, when: "load" | "session_start"): void {
	const registration = `
		pi.registerProvider("probe-provider", {
			name: "Probe Provider",
			baseUrl: "https://example.invalid",
			apiKey: "x",
			api: "openai-completions",
			models: [],
		});`;
	const body =
		when === "load"
			? `export default (pi) => {${registration}\n};`
			: `export default (pi) => {\n\tpi.on("session_start", () => {${registration}\n\t});\n};`;
	writeFileSync(path, body);
}

async function providerRuntime(agentDir: string): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	return { runtime, registry: new ModelRegistry(runtime) };
}

test("a child extension cannot register a provider while loading", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const extension = join(agentDir, "..", "provider-load.ts");
	providerExtension(extension, "load");
	const { runtime, registry } = await providerRuntime(agentDir);
	const before = runtime.getRegisteredProviderIds();

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: registry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: [extension],
			}),
		(error: unknown) =>
			error instanceof Error && error.message.includes(CHILD_MODEL_RUNTIME_MUTATION),
	);

	assert.deepEqual(runtime.getRegisteredProviderIds(), before, "the shared runtime must be unchanged");
});

test("a child extension cannot register a provider on session_start", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const extension = join(agentDir, "..", "provider-start.ts");
	providerExtension(extension, "session_start");
	const { runtime, registry } = await providerRuntime(agentDir);
	const before = runtime.getRegisteredProviderIds();

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: registry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: [extension],
			}),
		(error: unknown) =>
			error instanceof Error && error.message.includes(CHILD_MODEL_RUNTIME_MUTATION),
	);

	assert.deepEqual(runtime.getRegisteredProviderIds(), before, "the shared runtime must be unchanged");
});

test("a child can still read models through the guarded runtime", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const { registry } = await providerRuntime(agentDir);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: registry,
		model: MODEL as never,
		prompt: "x",
	});
	t.after(() => session.dispose());

	assert.equal(session.model?.id, "probe", "the explicit child model survives the guard");
	assert.ok(session.modelRuntime.getModels().length > 0, "the shared catalog is still readable");
});


test("a child transcript uses the subagent session directory", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
	});
	t.after(() => session.dispose());

	const file = session.sessionManager.getSessionFile();
	assert.ok(file, "the child session is persisted");
	assert.ok(file.includes("subagent-sessions"), `expected a dedicated directory: ${file}`);
	assert.ok(
		!file.includes(join(agentDir, "sessions")),
		`the parent session directory must not receive child transcripts: ${file}`,
	);
});

/** A requested extension that loads but throws while handling `session_start`. */
const BIND_FAILURE_EXTENSION = `
export default (pi) => {
	pi.registerTool({
		name: "bind_failure_tool",
		label: "Bind failure probe",
		description: "probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
	pi.on("session_start", () => {
		throw new Error("BIND_FAILURE_SENTINEL");
	});
};
`;

test("a requested extension that fails during session_start is reported, not silently missing", async (t) => {
	const { cwd, agentDir } = tempProject(t);
	const extension = join(cwd, "bind-failure.ts");
	writeFileSync(extension, BIND_FAILURE_EXTENSION);

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: {} as ModelRegistry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: [extension],
				tools: ["+bind_failure_tool"],
			}),
		(error: Error) => {
			assert.match(error.message, /failed while starting the child session/);
			assert.match(error.message, /BIND_FAILURE_SENTINEL/);
			return true;
		},
	);
});

/** A requested extension that registers an MCP server without loading builtin:mcp. */
const UNCONNECTED_MCP_EXTENSION = `
export default (pi) => {
	pi.registerMcpServer("probe-server", { command: "offline-probe" });
	pi.registerTool({
		name: "probe_tool",
		label: "Probe",
		description: "probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
};
`;

test("an unconnected MCP registration is a warning, not a startup failure", async (t) => {
	const { cwd, agentDir, extension } = tempProject(t);
	writeFileSync(extension, UNCONNECTED_MCP_EXTENSION);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: [extension],
		tools: ["+probe_tool"],
	});
	t.after(() => session.dispose());

	const names = session.getAllTools().map((tool) => tool.name);
	assert.ok(names.includes("probe_tool"), `the requested tool must stay available: ${names.join(", ")}`);
});

test("an explicit core override that never registers fails instead of falling back", async (t) => {
	const { cwd, agentDir, extension } = tempProject(t);

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: {} as ModelRegistry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: [extension],
				tools: ["+bash"],
				coreOverrides: [{ name: "bash", path: extension }],
			}),
		/fall back to the SDK built-in/,
	);
});

test("an explicit core override registered by the extension is accepted", async (t) => {
	const { cwd, agentDir, extension } = tempProject(t);
	writeFileSync(extension, `
export default (pi) => {
	pi.registerTool({
		name: "bash",
		label: "Sandbox bash",
		description: "probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "sandbox" }] };
		},
	});
};
`);

	const session = await createChildSession({
		cwd,
		agentDir,
		modelRegistry: {} as ModelRegistry,
		model: MODEL as never,
		prompt: "x",
		extensionPaths: [extension],
		tools: ["+bash"],
		coreOverrides: [{ name: "bash", path: extension }],
	});
	t.after(() => session.dispose());

	const bash = session.getAllTools().find((tool) => tool.name === "bash");
	assert.ok(bash);
	assert.notEqual(bash.sourceInfo.source, "sdk", "the extension override must win over the SDK built-in");
});

test("a missing relative extension path fails like an absolute one", async (t) => {
	const { cwd, agentDir } = tempProject(t);

	await assert.rejects(
		() =>
			createChildSession({
				cwd,
				agentDir,
				modelRegistry: {} as ModelRegistry,
				model: MODEL as never,
				prompt: "x",
				extensionPaths: ["missing-probe-extension.ts"],
			}),
		/Could not load the requested extension/,
	);
});
