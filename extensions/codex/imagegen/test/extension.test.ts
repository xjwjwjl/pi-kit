import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCodexImageGenExtension,
  type CodexImageGenExtensionOptions,
} from "../index.ts";

function createHarness(options: CodexImageGenExtensionOptions = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, any>();
  let tool: any;
  let activeTools = ["read", "bash"];

  createCodexImageGenExtension(options)({
    registerTool(registered: unknown) {
      tool = registered;
      activeTools.push((registered as { name: string }).name);
    },
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as any);

  return {
    handlers,
    commands,
    get tool() {
      return tool;
    },
    get activeTools() {
      return activeTools;
    },
  };
}

const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  baseUrl: "https://chatgpt.com/backend-api",
};

test("registers and activates the image tool only for Codex models", () => {
  const harness = createHarness();
  assert.equal(harness.tool.name, "codex_image_gen");

  const sessionStart = harness.handlers.get("session_start")!;
  sessionStart({}, { model: { provider: "anthropic", api: "anthropic-messages" } });
  assert.equal(harness.activeTools.includes("codex_image_gen"), false);

  sessionStart({}, { model: CODEX_MODEL });
  assert.equal(harness.activeTools.includes("codex_image_gen"), true);

  const modelSelect = harness.handlers.get("model_select")!;
  modelSelect({ model: { provider: "openai", api: "openai-responses" } }, {});
  assert.equal(harness.activeTools.includes("codex_image_gen"), false);
});

test("defaults to Flare and lets the command switch to Sunburst", async () => {
  const harness = createHarness();
  const command = harness.commands.get("codex-image-model");
  assert.ok(command);

  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
  };

  assert.deepEqual(command.getArgumentCompletions(""), [
    { value: "flare", label: "flare" },
    { value: "sunburst", label: "sunburst" },
    { value: "status", label: "status" },
  ]);
  await command.handler("status", ctx);
  assert.match(notifications.at(-1)!, /flare \(gpt-image-2\.5-flare\)/);

  await command.handler("sunburst", ctx);
  await command.handler("status", ctx);
  assert.match(notifications.at(-1)!, /sunburst \(gpt-image-2\.5-sunburst\)/);
});

test("uses Pi's resolved Codex credentials and returns the generated image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-extension-test-"));
  const imageBytes = Buffer.from("extension-test-image");
  let authModel: unknown;

  try {
    const harness = createHarness({
      now: () => new Date("2026-09-24T12:34:56.000Z"),
      createId: () => "extension-test-id",
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const result = await harness.tool.execute(
      "call-1",
      { prompt: "A small orange fox" },
      undefined,
      undefined,
      {
        model: CODEX_MODEL,
        cwd,
        modelRegistry: {
          async getApiKeyAndHeaders(model: unknown) {
            authModel = model;
            return {
              ok: true,
              apiKey: "test-token",
              baseUrl: "https://chatgpt.com/backend-api",
              headers: { "chatgpt-account-id": "test-account" },
            };
          },
        },
      },
    );

    assert.equal(authModel, CODEX_MODEL);
    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /generated-images\//);
    assert.deepEqual(result.content[1], {
      type: "image",
      data: imageBytes.toString("base64"),
      mimeType: "image/png",
    });
    assert.deepEqual(result.details, {
      requestedCount: 1,
      generatedCount: 1,
      paths: ["generated-images/image-2026-09-24T12-34-56-000Z-extension-test-id.png"],
      failures: [],
      model: "gpt-image-2.5-flare",
    });
    assert.deepEqual(
      await readFile(join(cwd, "generated-images/image-2026-09-24T12-34-56-000Z-extension-test-id.png")),
      imageBytes,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("uses Sunburst for image generation after the command switches models", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-sunburst-test-"));
  const imageBytes = Buffer.from("sunburst-test-image");
  const requestedModels: unknown[] = [];

  try {
    const harness = createHarness({
      createId: () => "sunburst-test-id",
      fetchImpl: async (_input, init) => {
        requestedModels.push(JSON.parse(String(init?.body)).model);
        return new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const command = harness.commands.get("codex-image-model");
    const ctx = { hasUI: true, ui: { notify() {} } };
    await command.handler("sunburst", ctx);

    const result = await harness.tool.execute(
      "call-sunburst",
      { prompt: "A detailed image", count: 2, output_path: "designs/sunburst-poster" },
      undefined,
      undefined,
      {
        model: CODEX_MODEL,
        cwd,
        modelRegistry: {
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-token", baseUrl: "https://chatgpt.com/backend-api" };
          },
        },
      },
    );

    assert.deepEqual(requestedModels, ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"]);
    assert.deepEqual(result.details, {
      requestedCount: 2,
      generatedCount: 2,
      paths: ["designs/sunburst-poster-01.png", "designs/sunburst-poster-02.png"],
      failures: [],
      model: "gpt-image-2.5-sunburst",
    });
    assert.equal(result.content.filter((item: { type: string }) => item.type === "image").length, 2);
    assert.deepEqual(
      await readFile(join(cwd, "designs/sunburst-poster-01.png")),
      imageBytes,
    );
    assert.deepEqual(
      await readFile(join(cwd, "designs/sunburst-poster-02.png")),
      imageBytes,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refuses to call the Images API for non-Codex models", async () => {
  const harness = createHarness();
  let resolvedAuth = false;
  await assert.rejects(
    harness.tool.execute(
      "call-1",
      { prompt: "A small orange fox" },
      undefined,
      undefined,
      {
        model: { provider: "openai", api: "openai-responses" },
        cwd: tmpdir(),
        modelRegistry: {
          async getApiKeyAndHeaders() {
            resolvedAuth = true;
            return { ok: true, apiKey: "should-not-be-used" };
          },
        },
      },
    ),
    /only with the openai-codex Responses model/,
  );
  assert.equal(resolvedAuth, false);
});
