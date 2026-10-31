import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseRequestJson,
  parseWindowsProxyServer,
  PROXY_REEXEC_ENV,
  readCodexCredentials,
  readStdinRequest,
  readWindowsProxyEnvironment,
  resolveOutputRelativePath,
  resolveProxyReexec,
  runImageRequest,
  SUNBURST_MODEL,
  validateRequest,
  validateSize,
} from "../scripts/generate.mjs";

test("pins all generation requests to Sunburst and validates requests", () => {
  const request = validateRequest({ prompt: "  A blue whale  " });
  assert.deepEqual(request, {
    prompt: "A blue whale",
    count: 1,
    quality: "high",
    size: "auto",
    referenceImages: [],
    outputPath: undefined,
  });
  assert.equal(SUNBURST_MODEL, "gpt-image-2.5-sunburst");
  assert.throws(() => validateRequest({ prompt: "image", model: "flare" }), /Unsupported request field: model/);
  assert.throws(() => validateRequest({ prompt: "image", count: 26 }), /Count must be/);
  assert.throws(() => validateRequest({ prompt: "image", quality: "medium-plus" }), /Quality must be/);
  assert.equal(validateSize("1536x1024"), "1536x1024");
  assert.throws(() => validateSize("1920x1080"), /multiples of 16/);
  assert.equal(parseRequestJson('{"prompt":"test"}').prompt, "test");
  assert.equal(parseRequestJson('\uFEFF{"prompt":"test"}').prompt, "test");
  assert.throws(() => parseRequestJson(""), /must not be empty/);
  assert.throws(() => parseRequestJson("not json"), /could not be parsed/);
  assert.throws(() => parseRequestJson(JSON.stringify({ prompt: "x".repeat(120_001) })), /must not exceed/);
});

test("reads the request JSON from stdin without a Base64 step", async () => {
  const request = await readStdinRequest({ stream: Readable.from(['{"prompt":"A blue whale",', '"count":2}']) });
  assert.equal(request.prompt, "A blue whale");
  assert.equal(request.count, 2);
  await assert.rejects(readStdinRequest({ stream: Readable.from(["{\"prompt\":\"x\"}"]), maxBytes: 3 }), /must not exceed 3 bytes/);
  await assert.rejects(readStdinRequest({ stream: { isTTY: true } }), /No request JSON was provided on stdin/);
});

test("detects the Windows system proxy without a shell wrapper", () => {
  assert.equal(parseWindowsProxyServer("http=127.0.0.1:8080;https=proxy.local:8443"), "http://proxy.local:8443");
  assert.equal(parseWindowsProxyServer("proxy.local:8443"), "http://proxy.local:8443");
  assert.equal(parseWindowsProxyServer("socks=127.0.0.1:1080"), undefined);
  assert.equal(parseWindowsProxyServer("http=bad proxy:8080"), undefined);
  assert.equal(parseWindowsProxyServer("http=127.0.0.1:8080"), "http://127.0.0.1:8080");

  const responses = new Map([
    ["ProxyEnable", "    ProxyEnable    REG_DWORD    0x1\r\n"],
    ["ProxyServer", "    ProxyServer    REG_SZ    proxy.local:8443\r\n"],
  ]);
  const execFileSyncImpl = (_command, args) => responses.get(args.at(-1));
  assert.deepEqual(readWindowsProxyEnvironment({ platform: "win32", execFileSyncImpl }), { HTTPS_PROXY: "http://proxy.local:8443", HTTP_PROXY: "http://proxy.local:8443" });
  assert.deepEqual(readWindowsProxyEnvironment({ platform: "linux", execFileSyncImpl }), {});
  responses.set("ProxyEnable", "    ProxyEnable    REG_DWORD    0x0\r\n");
  assert.deepEqual(readWindowsProxyEnvironment({ platform: "win32", execFileSyncImpl }), {});
});

test("restarts once with --use-env-proxy only when a proxy applies", () => {
  const readProxy = () => ({ HTTPS_PROXY: "http://proxy.local:8443", HTTP_PROXY: "http://proxy.local:8443" });
  assert.deepEqual(resolveProxyReexec({ env: {}, platform: "win32", readProxy }), { HTTPS_PROXY: "http://proxy.local:8443", HTTP_PROXY: "http://proxy.local:8443" });
  assert.equal(resolveProxyReexec({ env: {}, platform: "linux", readProxy: () => ({}) }), undefined);
  assert.equal(resolveProxyReexec({ env: { [PROXY_REEXEC_ENV]: "1" }, platform: "win32", readProxy }), undefined);
  assert.equal(resolveProxyReexec({ env: { NODE_USE_ENV_PROXY: "1" }, platform: "win32", readProxy }), undefined);
  assert.deepEqual(resolveProxyReexec({ env: { https_proxy: "http://explicit.local:3128" }, platform: "linux", readProxy: () => ({}) }), {
    https_proxy: "http://explicit.local:3128",
  });
  assert.deepEqual(resolveProxyReexec({ env: { HTTPS_PROXY: "http://explicit.local:3128" }, platform: "win32", readProxy }), {
    HTTPS_PROXY: "http://explicit.local:3128",
    HTTP_PROXY: "http://proxy.local:8443",
  });
  assert.deepEqual(resolveProxyReexec({ env: { NODE_USE_ENV_PROXY: "0" }, platform: "win32", readProxy }), {
    HTTPS_PROXY: "http://proxy.local:8443",
    HTTP_PROXY: "http://proxy.local:8443",
  });
});

test("rejects unsafe and non-PNG output paths", () => {
  assert.equal(resolveOutputRelativePath("artwork", "now", "id"), "artwork.png");
  assert.throws(() => resolveOutputRelativePath("../outside.png", "now", "id"), /parent directory/);
  assert.throws(() => resolveOutputRelativePath("D:\\outside.png", "now", "id"), /relative/);
  assert.throws(() => resolveOutputRelativePath("artwork.jpg", "now", "id"), /\.png/);
});

test("reads only the local Codex ChatGPT login, without exposing its token", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
  try {
    const codexHome = join(home, ".codex");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "test-secret-token", account_id: "test-account" },
    }));
    const auth = await readCodexCredentials({ home, env: {} });
    assert.equal(auth.apiKey, "test-secret-token");
    assert.deepEqual(auth.headers, { "ChatGPT-Account-Id": "test-account" });
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "api_key", tokens: { access_token: "api-key-token" } }));
    await assert.rejects(readCodexCredentials({ home, env: {} }), /requires a Codex ChatGPT login/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sends a fixed Sunburst request with Codex credentials and saves a new PNG", async () => {
  const cwd = await mkdtemp(join(process.cwd(), ".codex-sunburst-test-"));
  const imageBytes = Buffer.from("unit-test-image");
  let requestUrl;
  let requestInit;
  try {
    const result = await runImageRequest({ prompt: "A blue whale" }, {
      cwd,
      auth: { apiKey: "mock-codex-token", baseUrl: "https://chatgpt.com/backend-api", headers: { "ChatGPT-Account-Id": "mock-account" } },
      now: () => new Date("2026-10-10T00:00:00.000Z"),
      createId: () => "fixed-id",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }), { status: 200 });
      },
    });

    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/images/generations");
    const headers = new Headers(requestInit.headers);
    assert.equal(headers.get("authorization"), "Bearer mock-codex-token");
    assert.equal(headers.get("chatgpt-account-id"), "mock-account");
    assert.equal(headers.get("originator"), "codex");
    assert.equal(JSON.parse(requestInit.body).model, SUNBURST_MODEL);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].path, "generated-images/image-2026-10-10T00-00-00-000Z-fixed-id.png");
    assert.deepEqual(await readFile(join(cwd, result.images[0].path)), imageBytes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reports a safe network diagnostic code without exposing credentials", async () => {
  const cwd = await mkdtemp(join(process.cwd(), ".codex-sunburst-network-test-"));
  const timeout = new Error("connection timed out");
  timeout.code = "UND_ERR_CONNECT_TIMEOUT";
  try {
    await assert.rejects(
      runImageRequest({ prompt: "A test image" }, {
        cwd,
        auth: { apiKey: "must-not-appear-in-errors", baseUrl: "https://chatgpt.com/backend-api" },
        fetchImpl: async () => { throw new TypeError("fetch failed", { cause: timeout }); },
      }),
      (error) => {
        assert.match(error.message, /Could not reach the Codex image service \(UND_ERR_CONNECT_TIMEOUT\)/);
        assert.doesNotMatch(error.message, /must-not-appear-in-errors/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/generate.mjs", import.meta.url));

// PROXY_REEXEC_ENV keeps the CLI from restarting itself, so each case is one process.
function runCli(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, [PROXY_REEXEC_ENV]: "1", ...env },
  });
}

test("CLI exits 0 with usage for --help and rejects unknown options", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node generate\.mjs/);
  assert.equal(help.stderr, "");

  const unknown = runCli(["--check-connection"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --check-connection/);
  assert.equal(unknown.stdout, "");
});

test("CLI rejects bad stdin and any login failure without touching the network", async () => {
  const emptyCodexHome = await mkdtemp(join(tmpdir(), "codex-cli-test-"));
  try {
    const env = { CODEX_HOME: emptyCodexHome, CODEX_ACCESS_TOKEN: "" };

    const malformed = runCli([], { input: "not json", env });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Request JSON could not be parsed/);

    const emptyArgs = runCli(["--check-auth", "extra"], { env });
    assert.equal(emptyArgs.status, 1);
    assert.match(emptyArgs.stderr, /Unexpected argument for --check-auth/);

    const noLogin = runCli([], { input: '{"prompt":"A blue whale"}', env });
    assert.equal(noLogin.status, 1);
    assert.match(noLogin.stderr, /Codex login credentials were not found/);
    assert.equal(noLogin.stdout, "");
  } finally {
    await rm(emptyCodexHome, { recursive: true, force: true });
  }
});
