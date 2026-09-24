import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCodexImageRequest,
  generateCodexImage,
  generateCodexImageBatch,
  isCodexModel,
  MAX_CODEX_IMAGE_BATCH_COUNT,
  parseCodexImageResponse,
  resolveCodexImageGenerationUrl,
  resolveImageOutputRelativePath,
} from "../src/imagegen-api.ts";

const AUTH = {
  apiKey: "test-access-token",
  baseUrl: "https://chatgpt.com/backend-api",
  headers: { "chatgpt-account-id": "test-account" },
};

test("identifies only the Codex Responses provider", () => {
  assert.equal(isCodexModel({ provider: "openai-codex", api: "openai-codex-responses" }), true);
  assert.equal(isCodexModel({ provider: "openai-codex", api: "openai-responses" }), false);
  assert.equal(isCodexModel({ provider: "openai", api: "openai-codex-responses" }), false);
  assert.equal(isCodexModel(undefined), false);
});

test("resolves the Codex Images generation endpoint from provider base URLs", () => {
  assert.equal(
    resolveCodexImageGenerationUrl("https://chatgpt.com/backend-api/"),
    "https://chatgpt.com/backend-api/codex/images/generations",
  );
  assert.equal(
    resolveCodexImageGenerationUrl("https://chatgpt.com/backend-api/codex"),
    "https://chatgpt.com/backend-api/codex/images/generations",
  );
  assert.equal(
    resolveCodexImageGenerationUrl("https://chatgpt.com/backend-api/codex/responses"),
    "https://chatgpt.com/backend-api/codex/images/generations",
  );
  assert.throws(() => resolveCodexImageGenerationUrl("http://chatgpt.com/backend-api"), /HTTPS/);
  assert.throws(() => resolveCodexImageGenerationUrl("https://example.com/backend-api"), /chatgpt.com/);
  assert.throws(() => resolveCodexImageGenerationUrl("not a URL"), /Invalid/);
});

test("builds single-image requests for Flare by default and Sunburst on selection", () => {
  assert.deepEqual(buildCodexImageRequest("  A paper-cut landscape  "), {
    model: "gpt-image-2.5-flare",
    prompt: "A paper-cut landscape",
    n: 1,
    quality: "medium",
    size: "auto",
  });
  assert.equal(buildCodexImageRequest("A detailed portrait", "sunburst").model, "gpt-image-2.5-sunburst");
  assert.throws(() => buildCodexImageRequest("  "), /must not be empty/);
  assert.throws(() => buildCodexImageRequest("x".repeat(20_001)), /character limit/);
});

test("runs count requests concurrently, each requesting one image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-batch-test-"));
  const imageBytes = Buffer.from("batch-image");
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
  const timeout = setTimeout(releaseGate, 1_000);
  const requestBodies: Record<string, unknown>[] = [];

  try {
    const batch = await generateCodexImageBatch({
      prompt: "Four apple icons",
      count: MAX_CODEX_IMAGE_BATCH_COUNT,
      outputPath: "art/hero.png",
      cwd,
      auth: AUTH,
      now: () => new Date("2026-09-24T12:34:56.000Z"),
      createId: () => "batch-test-id",
      fetchImpl: async (_input, init) => {
        active++;
        maxActive = Math.max(maxActive, active);
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        started++;
        if (started === MAX_CODEX_IMAGE_BATCH_COUNT) {
          clearTimeout(timeout);
          releaseGate();
        }
        await gate;
        await new Promise((resolveRequest) => setTimeout(resolveRequest, 5));
        active--;
        return new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(maxActive, MAX_CODEX_IMAGE_BATCH_COUNT);
    assert.equal(requestBodies.length, MAX_CODEX_IMAGE_BATCH_COUNT);
    assert.ok(requestBodies.every((body) => body.n === 1 && body.prompt === "Four apple icons"));
    assert.equal(batch.requestedCount, MAX_CODEX_IMAGE_BATCH_COUNT);
    assert.equal(batch.images.length, MAX_CODEX_IMAGE_BATCH_COUNT);
    assert.deepEqual(batch.failures, []);
    assert.deepEqual(batch.images.map((image) => image.relativePath), [
      "art/hero-01.png",
      "art/hero-02.png",
      "art/hero-03.png",
      "art/hero-04.png",
    ]);
    for (const image of batch.images) {
      assert.deepEqual(await readFile(join(cwd, image.relativePath)), imageBytes);
    }
  } finally {
    clearTimeout(timeout);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects counts above the batch limit before sending requests", async () => {
  let fetchCalled = false;
  await assert.rejects(
    generateCodexImageBatch({
      prompt: "Too many images",
      count: MAX_CODEX_IMAGE_BATCH_COUNT + 1,
      cwd: tmpdir(),
      auth: AUTH,
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    }),
    /integer from 1 to 4/,
  );
  assert.equal(fetchCalled, false);
});

test("keeps successful images when one parallel request fails without retrying", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-partial-batch-test-"));
  let fetchCalls = 0;

  try {
    const batch = await generateCodexImageBatch({
      prompt: "A set of icons",
      count: 3,
      cwd,
      auth: AUTH,
      createId: () => "partial-batch",
      fetchImpl: async (_input, init) => {
        fetchCalls++;
        const requestId = new Headers(init?.headers).get("x-codex-image-turn-id");
        if (requestId?.endsWith("-02")) {
          return new Response(JSON.stringify({ error: { message: "One request was rate limited" } }), { status: 429 });
        }
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("ok").toString("base64") }] }), {
          status: 200,
        });
      },
    });

    assert.equal(fetchCalls, 3);
    assert.equal(batch.requestedCount, 3);
    assert.equal(batch.images.length, 2);
    assert.deepEqual(batch.failures.map((failure) => failure.index), [2]);
    assert.match(batch.failures[0]!.error, /rate-limited or quota-limited/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("defaults images to generated-images and validates explicit relative PNG paths", () => {
  assert.equal(
    resolveImageOutputRelativePath(undefined, "2026-09-24T12-34-56-000Z", "test-id"),
    "generated-images/image-2026-09-24T12-34-56-000Z-test-id.png",
  );
  assert.equal(resolveImageOutputRelativePath("art/banner", "stamp", "id"), "art/banner.png");
  assert.equal(resolveImageOutputRelativePath("art/banner.PNG", "stamp", "id"), "art/banner.PNG");
  assert.throws(() => resolveImageOutputRelativePath("../outside.png", "stamp", "id"), /must not contain/);
  assert.throws(() => resolveImageOutputRelativePath("D:\\\\outside.png", "stamp", "id"), /must be relative/);
  assert.throws(() => resolveImageOutputRelativePath("/tmp/outside.png", "stamp", "id"), /must be relative/);
  assert.throws(() => resolveImageOutputRelativePath("art/banner.jpg", "stamp", "id"), /\.png extension/);
});

test("rejects unsafe output paths before sending a generation request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-path-test-"));
  let fetchCalled = false;

  try {
    await assert.rejects(
      generateCodexImage({
        prompt: "A test image",
        outputPath: "../outside.png",
        cwd,
        auth: AUTH,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
      }),
      /parent directory segments/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects existing files and file-blocked parent paths before making a request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-existing-path-test-"));
  const existingFile = join(cwd, "existing.png");
  const blockingFile = join(cwd, "not-a-directory");
  await writeFile(existingFile, "keep me");
  await writeFile(blockingFile, "keep me too");
  let fetchCalled = false;

  try {
    for (const [outputPath, expectedError] of [
      ["existing.png", /already exists/],
      ["not-a-directory/child.png", /blocked by a non-directory/],
    ] as const) {
      await assert.rejects(
        generateCodexImage({
          prompt: "A test image",
          outputPath,
          cwd,
          auth: AUTH,
          fetchImpl: async () => {
            fetchCalled = true;
            return new Response("{}", { status: 200 });
          },
        }),
        expectedError,
      );
    }
    assert.equal(fetchCalled, false);
    assert.equal(await readFile(existingFile, "utf-8"), "keep me");
    assert.equal(await readFile(blockingFile, "utf-8"), "keep me too");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects symlink output directories that escape the workspace", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-symlink-test-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-imagegen-outside-test-"));
  let fetchCalled = false;

  try {
    try {
      await symlink(outside, join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "UNKNOWN") {
        t.skip("Platform does not permit creating a directory symlink");
        return;
      }
      throw error;
    }

    await assert.rejects(
      generateCodexImage({
        prompt: "A test image",
        outputPath: "external/outside.png",
        cwd,
        auth: AUTH,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
      }),
      /inside the current working directory/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("parses base64 image data and rejects malformed or oversized output", () => {
  const data = Buffer.from("test-image-bytes").toString("base64");
  assert.equal(parseCodexImageResponse({ data: [{ b64_json: data }] }), data);
  assert.throws(() => parseCodexImageResponse({ data: [{}] }), /base64 image data/);
  assert.throws(() => parseCodexImageResponse({ data: [{ b64_json: "***" }] }), /invalid or oversized/);
  assert.throws(() => parseCodexImageResponse({}), /image list/);
});

test("sends an authenticated request and saves/returns the generated image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-imagegen-test-"));
  const imageBytes = Buffer.from("test-png-payload");
  let requestUrl = "";
  let requestInit: RequestInit | undefined;

  try {
    const result = await generateCodexImage({
      prompt: "  A blue bird  ",
      cwd,
      auth: AUTH,
      now: () => new Date("2026-09-24T12:34:56.000Z"),
      createId: () => "fixed-test-id",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(
          JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(requestInit?.method, "POST");
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-access-token");
    assert.equal(headers.get("chatgpt-account-id"), "test-account");
    assert.equal(headers.get("originator"), "pi");
    assert.equal(headers.get("x-codex-image-turn-id"), "fixed-test-id");
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      model: "gpt-image-2.5-flare",
      prompt: "A blue bird",
      n: 1,
      quality: "medium",
      size: "auto",
    });

    assert.equal(result.relativePath, "generated-images/image-2026-09-24T12-34-56-000Z-fixed-test-id.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.data, imageBytes.toString("base64"));
    assert.deepEqual(await readFile(join(cwd, result.relativePath)), imageBytes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("surfaces useful authorization and quota errors", async () => {
  await assert.rejects(
    generateCodexImage({
      prompt: "A test image",
      cwd: tmpdir(),
      auth: AUTH,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "Image quota exhausted" } }), { status: 429 }),
    }),
    /quota-limited \(HTTP 429\).*Image quota exhausted/,
  );

  await assert.rejects(
    generateCodexImage({
      prompt: "A test image",
      cwd: tmpdir(),
      auth: AUTH,
      fetchImpl: async () => new Response("", { status: 401 }),
    }),
    /unauthorized \(HTTP 401\).*\/login openai-codex/,
  );
});
