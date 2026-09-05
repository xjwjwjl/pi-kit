import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSxFastModeExtension } from "../index.ts";

const type = <T>(value: T): T => value;

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;
type Command = { handler: (args: string, ctx: any) => unknown | Promise<unknown> };

function fakePi(fastFlag = false) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, unknown>();

  const pi = {
    registerFlag(name: string, _config: unknown) {
      flags.set(name, fastFlag);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerCommand(name: string, config: Command) {
      commands.set(name, config);
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  return { pi, handlers, commands };
}

function fakeContext(
  cwd: string,
  model: { provider: string; id: string } | undefined,
  trusted = true,
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();

  return {
    cwd,
    model,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
      },
    },
    notifications,
    statuses,
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-fast-mode-extension-"));
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "project", ".pi"), { recursive: true });
  return root;
}

async function emit(
  handlers: Map<string, Handler[]>,
  event: string,
  value: unknown,
  ctx: unknown,
): Promise<unknown> {
  const handler = handlers.get(event)?.[0];
  assert.ok(handler, `missing ${event} handler`);
  return handler(value, ctx);
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("registers the fast flag, command, and lifecycle handlers", () => {
  const { pi, handlers, commands } = fakePi();
  createSxFastModeExtension({ agentDir: "C:/agent" })(type(pi) as never);

  assert.ok(commands.has("fast"));
  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("model_select"));
  assert.ok(handlers.has("before_provider_request"));
  assert.ok(handlers.has("session_shutdown"));
});

test("injects priority for any non-blacklisted openai-codex model", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "codex-fast-mode": { enabled: true, blacklist: [] } }),
      "utf8",
    );

    const { pi, handlers } = fakePi();
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const ctx = fakeContext(cwd, { provider: "openai-codex", id: "future-codex-model" });
    await emit(handlers, "session_start", {}, ctx);

    const result = await emit(
      handlers,
      "before_provider_request",
      { payload: { model: "future-codex-model", input: [] } },
      ctx,
    );

    assert.deepEqual(result, {
      model: "future-codex-model",
      input: [],
      service_tier: "priority",
    });
    assert.equal(ctx.statuses.get("codex-fast"), "Codex Fast");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults to enabled when no settings are configured", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    const { pi, handlers } = fakePi();
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const ctx = fakeContext(cwd, { provider: "openai-codex", id: "gpt-5.5" });
    await emit(handlers, "session_start", {}, ctx);

    assert.deepEqual(
      await emit(handlers, "before_provider_request", { payload: { input: [] } }, ctx),
      { input: [], service_tier: "priority" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not inject for blacklisted or non-Codex models", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "codex-fast-mode": { enabled: true, blacklist: ["gpt-5.5"] } }),
      "utf8",
    );

    const { pi, handlers } = fakePi();
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const blacklisted = fakeContext(cwd, { provider: "openai-codex", id: "gpt-5.5" });
    await emit(handlers, "session_start", {}, blacklisted);
    assert.equal(
      await emit(handlers, "before_provider_request", { payload: {} }, blacklisted),
      undefined,
    );

    const otherProvider = fakeContext(cwd, { provider: "openai", id: "gpt-5.5" });
    assert.equal(
      await emit(handlers, "before_provider_request", { payload: {} }, otherProvider),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an explicit service tier", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "codex-fast-mode": { enabled: true } }),
      "utf8",
    );

    const { pi, handlers } = fakePi();
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const ctx = fakeContext(cwd, { provider: "openai-codex", id: "gpt-5.5" });
    await emit(handlers, "session_start", {}, ctx);

    assert.equal(
      await emit(
        handlers,
        "before_provider_request",
        { payload: { service_tier: "flex" } },
        ctx,
      ),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project settings override global settings and commands write project scope", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    const globalPath = path.join(agentDir, "settings.json");
    const projectPath = path.join(cwd, ".pi", "settings.json");
    await writeFile(
      globalPath,
      JSON.stringify({ "codex-fast-mode": { enabled: false, blacklist: ["gpt-5.4"] } }),
      "utf8",
    );
    await writeFile(
      projectPath,
      JSON.stringify({ unrelated: true, "codex-fast-mode": { enabled: true, blacklist: [] } }),
      "utf8",
    );

    const { pi, handlers, commands } = fakePi();
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const ctx = fakeContext(cwd, { provider: "openai-codex", id: "gpt-5.4" });
    await emit(handlers, "session_start", {}, ctx);
    assert.notEqual(
      await emit(handlers, "before_provider_request", { payload: {} }, ctx),
      undefined,
    );

    await commands.get("fast")?.handler("off", ctx);
    const projectSettings = await readJson(projectPath);
    const globalSettings = await readJson(globalPath);
    assert.equal(projectSettings.unrelated, true);
    assert.equal(projectSettings["codex-fast-mode"].enabled, false);
    assert.equal(globalSettings["codex-fast-mode"].enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--fast enables and persists global settings when no project override exists", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    const globalPath = path.join(agentDir, "settings.json");
    await writeFile(
      globalPath,
      JSON.stringify({ unrelated: true, "codex-fast-mode": { enabled: false } }),
      "utf8",
    );

    const { pi, handlers } = fakePi(true);
    createSxFastModeExtension({ agentDir })(type(pi) as never);
    const ctx = fakeContext(cwd, { provider: "openai-codex", id: "gpt-5.5" });
    await emit(handlers, "session_start", {}, ctx);

    const settings = await readJson(globalPath);
    assert.equal(settings.unrelated, true);
    assert.equal(settings["codex-fast-mode"].enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension instances do not share in-memory state", async () => {
  const root = await makeTempRoot();
  try {
    const first = fakePi();
    const second = fakePi();
    createSxFastModeExtension({ agentDir: path.join(root, "agent-a") })(type(first.pi) as never);
    createSxFastModeExtension({ agentDir: path.join(root, "agent-b") })(type(second.pi) as never);

    const firstCtx = fakeContext(path.join(root, "project-a"), { provider: "openai-codex", id: "gpt-5.5" });
    await first.commands.get("fast")?.handler("on", firstCtx);

    const secondCtx = fakeContext(path.join(root, "project-b"), { provider: "openai", id: "gpt-5.5" });
    assert.equal(
      await emit(second.handlers, "before_provider_request", { payload: {} }, secondCtx),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
