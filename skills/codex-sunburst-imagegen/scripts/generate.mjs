#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUNBURST_MODEL = "gpt-image-2.5-sunburst";
export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images";
export const MAX_COUNT = 25;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCES = 8;
const MAX_REQUEST_BYTES = 120_000;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1_000_000;
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export function parseRequestJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Request JSON must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new Error(`Request JSON must not exceed ${MAX_REQUEST_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("Request JSON could not be parsed");
  }
  return value;
}

export async function readStdinRequest({ stream = process.stdin, maxBytes = MAX_REQUEST_BYTES } = {}) {
  if (stream.isTTY) throw new Error("No request JSON was provided on stdin");
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > maxBytes) throw new Error(`Request JSON must not exceed ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return parseRequestJson(Buffer.concat(chunks).toString("utf8"));
}

export const PROXY_REEXEC_ENV = "CODEX_SUNBURST_IMAGE_PROXY_READY";
const WINDOWS_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_ENV_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

export function parseWindowsProxyServer(raw) {
  let https;
  let http;
  let fallback;
  for (const entry of String(raw ?? "").split(";")) {
    const value = entry.trim();
    if (!value) continue;
    if (value.startsWith("https=")) https ??= value.slice("https=".length);
    else if (value.startsWith("http=")) http ??= value.slice("http=".length);
    else if (value.includes("=")) continue;
    else fallback ??= value;
  }
  const server = (https ?? http ?? fallback)?.trim();
  if (!server || /\s/u.test(server)) return undefined;
  return server.includes("://") ? server : `http://${server}`;
}

export function readWindowsProxyEnvironment({ platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (!/^win/iu.test(platform)) return {};
  const query = (name) => execFileSyncImpl("reg.exe", ["query", WINDOWS_PROXY_KEY, "/v", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let enabled;
  try {
    enabled = query("ProxyEnable");
  } catch {
    return {};
  }
  const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/iu.exec(enabled);
  if (!enabledMatch || Number.parseInt(enabledMatch[1], 16) !== 1) return {};
  let raw;
  try {
    raw = query("ProxyServer");
  } catch {
    return {};
  }
  const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)/u.exec(raw);
  const server = parseWindowsProxyServer(serverMatch?.[1] ?? "");
  return server ? { HTTPS_PROXY: server, HTTP_PROXY: server } : {};
}

function isEnvFlagEnabled(value) {
  return typeof value === "string" && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export function resolveProxyReexec({ env = process.env, platform = process.platform, readProxy = readWindowsProxyEnvironment } = {}) {
  if (env[PROXY_REEXEC_ENV] === "1" || isEnvFlagEnabled(env.NODE_USE_ENV_PROXY)) return undefined;
  const proxy = { ...readProxy({ platform }) };
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) proxy[name] = value;
  }
  return Object.keys(proxy).length ? proxy : undefined;
}

export function validateRequest(value) {
  if (!isRecord(value)) throw new Error("Request must be a JSON object");
  const allowed = new Set(["prompt", "count", "quality", "size", "reference_images", "output_path"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported request field: ${key}`);
  }

  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("Prompt must be a non-empty string");
  if (value.prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt exceeds ${MAX_PROMPT_LENGTH} characters`);

  const count = value.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`Count must be an integer from 1 to ${MAX_COUNT}`);

  const quality = value.quality ?? "high";
  if (!["low", "medium", "high"].includes(quality)) throw new Error("Quality must be low, medium, or high");

  const size = value.size ?? "auto";
  validateSize(size);

  const referenceImages = value.reference_images ?? [];
  if (!Array.isArray(referenceImages) || referenceImages.length > MAX_REFERENCES) {
    throw new Error(`Reference images must be an array of at most ${MAX_REFERENCES} paths`);
  }
  for (const path of referenceImages) {
    if (typeof path !== "string" || !path.trim() || path.length > 1_000) {
      throw new Error("Each reference image path must be a non-empty string of at most 1000 characters");
    }
  }

  const outputPath = value.output_path;
  if (outputPath !== undefined && (typeof outputPath !== "string" || !outputPath.trim() || outputPath.length > 1_000)) {
    throw new Error("Output path must be a non-empty relative PNG path of at most 1000 characters");
  }

  return { prompt: value.prompt.trim(), count, quality, size, referenceImages, outputPath };
}

export function validateSize(size) {
  if (size === "auto") return size;
  if (typeof size !== "string") throw new Error('Size must be "auto" or WIDTHxHEIGHT');
  const match = /^(\d{3,4})x(\d{3,4})$/u.exec(size);
  if (!match) throw new Error('Size must be "auto" or WIDTHxHEIGHT, such as 1536x1024');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > 3840 || height > 3840) throw new Error("Size edges must not exceed 3840 pixels");
  if (width % 16 !== 0 || height % 16 !== 0) throw new Error("Size width and height must both be multiples of 16");
  if (Math.max(width, height) / Math.min(width, height) > 3) throw new Error("Size aspect ratio must be no wider or taller than 3:1");
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) throw new Error("Size must contain between 655360 and 8294400 pixels");
  return size;
}

export async function readCodexCredentials({ env = process.env, home = homedir(), readFileImpl = readFile } = {}) {
  let accessToken = env.CODEX_ACCESS_TOKEN;
  let accountId;
  const codexHome = env.CODEX_HOME?.trim() ? resolve(env.CODEX_HOME) : join(home, ".codex");
  const authPath = join(codexHome, "auth.json");

  try {
    const auth = JSON.parse(await readFileImpl(authPath, "utf8"));
    if (!isRecord(auth)) throw new Error("Codex auth file has an invalid format");
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
      throw new Error("This image CLI requires a Codex ChatGPT login; it does not use API keys or Pi credentials");
    }
    const tokens = auth.tokens;
    if (!isRecord(tokens)) throw new Error("No Codex login token was found; run `codex login`");
    accessToken ??= tokens.access_token;
    accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  } catch (error) {
    if (error?.code !== "ENOENT" || !accessToken) {
      if (error?.code === "ENOENT") throw new Error("Codex login credentials were not found; run `codex login` in the local Codex CLI");
      throw error;
    }
  }

  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("No active Codex access token was found; run `codex login` again");
  }
  return {
    apiKey: accessToken,
    baseUrl: "https://chatgpt.com/backend-api",
    headers: accountId ? { "ChatGPT-Account-Id": accountId } : {},
  };
}

export function resolveOutputRelativePath(requestedPath, timestamp, id) {
  if (requestedPath === undefined) return `generated-images/image-${timestamp}-${id}.png`;
  const normalized = requestedPath.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || isAbsolute(requestedPath)) {
    throw new Error("Output path must be relative to the current working directory");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Output path must not contain empty, current, or parent directory segments");
  }
  const extension = extname(parts.at(-1));
  if (extension && extension.toLowerCase() !== ".png") throw new Error("Output path must use the .png extension");
  if (!extension) parts[parts.length - 1] += ".png";
  return parts.join("/");
}

export async function runImageRequest(input, {
  cwd = process.cwd(),
  auth,
  fetchImpl = fetch,
  now = () => new Date(),
  createId = randomUUID,
} = {}) {
  const request = validateRequest(input);
  const credentials = auth ?? await readCodexCredentials();
  const root = resolve(cwd);
  const timestamp = now().toISOString().replace(/[:.]/gu, "-");
  const batchId = createId().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40);
  if (!batchId) throw new Error("Could not create a safe output filename");
  const basePath = resolveOutputRelativePath(request.outputPath, timestamp, batchId);
  const outputPaths = Array.from({ length: request.count }, (_, index) =>
    request.count === 1 ? basePath : addBatchIndex(basePath, index + 1),
  );
  const destinations = outputPaths.map((path) => {
    const absolutePath = resolve(root, path);
    assertPathWithin(root, absolutePath);
    return { path, absolutePath, directory: dirname(absolutePath) };
  });

  for (const destination of destinations) {
    await assertSafeOutputDirectory(root, destination.directory);
    await assertOutputAvailable(destination.absolutePath);
  }

  const referenceImages = await readReferenceImages(request.referenceImages, root);
  const results = await Promise.allSettled(destinations.map(({ path }, index) =>
    generateOne({ request, path, root, auth: credentials, referenceImages, fetchImpl, createId: () => `${batchId}-${String(index + 1).padStart(2, "0")}` }),
  ));

  const images = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") images.push(result.value);
    else failures.push({ index: index + 1, error: safeErrorMessage(result.reason) });
  });
  if (images.length === 0) throw new Error(`Image generation failed: ${failures[0]?.error ?? "unknown error"}`);
  return { model: SUNBURST_MODEL, requestedCount: request.count, images, failures };
}

async function generateOne({ request, path, root, auth, referenceImages, fetchImpl, createId }) {
  const url = `${IMAGE_ENDPOINT}/${referenceImages.length ? "edits" : "generations"}`;
  const body = {
    model: SUNBURST_MODEL,
    prompt: request.prompt,
    n: 1,
    quality: request.quality,
    size: request.size,
    ...(referenceImages.length ? { images: referenceImages.map((image_url) => ({ image_url })) } : {}),
  };
  const headers = new Headers(auth.headers ?? {});
  headers.set("authorization", `Bearer ${auth.apiKey}`);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("originator", "codex");
  headers.set("x-codex-image-turn-id", createId());

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("Image request timed out after 180 seconds");
    const causeCode = typeof error?.cause?.code === "string" ? error.cause.code : typeof error?.code === "string" ? error.code : "network error";
    throw new Error(`Could not reach the Codex image service (${causeCode})`);
  }

  const responseText = await readLimitedText(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    const detail = extractErrorMessage(responseText);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Codex image login was rejected (HTTP ${response.status}); run "codex login" and retry. ${detail}`.trim());
    }
    throw new Error(`Codex image service returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Codex image service returned invalid JSON");
  }
  const bytes = decodeImage(parsed);
  const outputDirectory = await ensureSafeOutputDirectory(root, dirname(resolve(root, path)));
  const outputPath = join(outputDirectory, basename(path));
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: relative(root, outputPath).replace(/\\/gu, "/"),
    absolutePath: outputPath,
    dimensions: readPngDimensions(bytes),
  };
}

async function readReferenceImages(paths, cwd) {
  const dataUrls = [];
  for (const rawPath of paths) {
    const candidate = resolve(cwd, rawPath);
    const extension = extname(rawPath).toLowerCase();
    const mimeType = IMAGE_TYPES.get(extension);
    if (!mimeType) throw new Error("Reference images must be PNG, JPG, JPEG, or WebP files");
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) throw new Error(`Reference image not found: ${rawPath}`);
    if (info.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`Reference image exceeds 20 MiB: ${rawPath}`);
    const bytes = await readFile(candidate);
    if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`Reference image exceeds 20 MiB: ${rawPath}`);
    dataUrls.push(`data:${mimeType};base64,${bytes.toString("base64")}`);
  }
  return dataUrls;
}

function decodeImage(value) {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Codex image response did not contain an image list");
  const image = value.data.find((item) => isRecord(item) && typeof item.b64_json === "string");
  if (!image) throw new Error("Codex image response did not contain base64 image data");
  const data = image.b64_json;
  if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
    throw new Error("Codex image response contained invalid or oversized image data");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64").replace(/=+$/u, "") !== data.replace(/=+$/u, "")) {
    throw new Error("Codex image response contained invalid or oversized image data");
  }
  return bytes;
}

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("Codex image response exceeded the maximum size");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Codex image response exceeded the maximum size");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function assertSafeOutputDirectory(root, outputDirectory) {
  const workspace = resolve(root);
  const destination = resolve(outputDirectory);
  assertPathWithin(workspace, destination);
  const rootInfo = await lstat(workspace);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Working directory must be a real directory");

  let cursor = workspace;
  const segments = relative(workspace, destination).split(sep).filter(Boolean);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("Image output path must not traverse symbolic links");
      if (!info.isDirectory()) throw new Error("Image output path is blocked by a non-directory path segment");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

async function ensureSafeOutputDirectory(root, outputDirectory) {
  await assertSafeOutputDirectory(root, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await assertSafeOutputDirectory(root, outputDirectory);
  return outputDirectory;
}

async function assertOutputAvailable(path) {
  try {
    await lstat(path);
    throw new Error("Image output file already exists; use a fresh PNG path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertPathWithin(root, candidate) {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Image output path must remain inside the current working directory");
}

function addBatchIndex(path, index) {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}-${String(index).padStart(2, "0")}${extension}`;
}

function readPngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    return typeof message === "string" ? message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 400) : "";
  } catch {
    return "";
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message.slice(0, 500) : "Image generation failed";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const USAGE = [
  "Usage: node generate.mjs [--check-auth | --help]",
  "       node generate.mjs  # reads one request JSON object from stdin",
].join("\n");

function reexecWithEnvProxy() {
  const proxy = resolveProxyReexec();
  if (!proxy) return false;
  const result = spawnSync(process.execPath, ["--use-env-proxy", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ...proxy, [PROXY_REEXEC_ENV]: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`Could not restart Node with the system proxy settings: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
  return true;
}

async function main() {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === "--help" || flag === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (flag === "--check-auth") {
    if (rest.length) throw new Error("Unexpected argument for --check-auth");
    await readCodexCredentials();
    process.stdout.write("Codex login is available. The access token was not displayed.\n");
    return;
  }
  if (flag) throw new Error(`Unknown option: ${flag}`);

  const result = await runImageRequest(await readStdinRequest());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!reexecWithEnvProxy()) {
    main().catch((error) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
  }
}
