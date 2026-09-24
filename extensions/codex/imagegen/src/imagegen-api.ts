import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CODEX_IMAGE_MODELS = {
  flare: "gpt-image-2.5-flare",
  sunburst: "gpt-image-2.5-sunburst",
} as const;
export type CodexImageModelChoice = keyof typeof CODEX_IMAGE_MODELS;
export type CodexImageModel = (typeof CODEX_IMAGE_MODELS)[CodexImageModelChoice];
export const DEFAULT_CODEX_IMAGE_MODEL: CodexImageModelChoice = "flare";
export const CODEX_IMAGE_GENERATION_TOOL = "codex_image_gen";
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_CODEX_IMAGE_BATCH_COUNT = 4;

const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_RESPONSE_BYTES = MAX_BASE64_LENGTH + 1_000_000;
const MAX_ERROR_DETAIL_LENGTH = 500;
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;

export interface CodexImageAuth {
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string | null>;
}

export interface GeneratedCodexImage {
  data: string;
  mimeType: "image/png";
  relativePath: string;
  model: CodexImageModel;
}

export interface GenerateCodexImageOptions {
  prompt: string;
  model?: CodexImageModelChoice;
  outputPath?: string;
  cwd: string;
  auth: CodexImageAuth;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createId?: () => string;
}

export interface GenerateCodexImageBatchOptions extends Omit<GenerateCodexImageOptions, "outputPath"> {
  count?: number;
  outputPath?: string;
}

export interface CodexImageBatchFailure {
  index: number;
  error: string;
}

export interface GeneratedCodexImageBatch {
  requestedCount: number;
  images: GeneratedCodexImage[];
  failures: CodexImageBatchFailure[];
}

export function isCodexModel(
  model: { provider?: string; api?: string } | undefined,
): boolean {
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function resolveCodexImageGenerationUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid OpenAI Codex base URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("OpenAI Codex image generation requires an HTTPS base URL");
  }
  if (url.username || url.password) {
    throw new Error("OpenAI Codex base URL must not contain embedded credentials");
  }
  if (url.hostname !== "chatgpt.com") {
    throw new Error("OpenAI Codex credentials may only be sent to chatgpt.com");
  }

  let path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/codex/responses")) {
    path = path.slice(0, -"/responses".length);
  } else if (!path.endsWith("/codex")) {
    path = `${path}/codex`;
  }

  url.pathname = `${path}/images/generations`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildCodexImageRequest(
  prompt: string,
  model: CodexImageModelChoice = DEFAULT_CODEX_IMAGE_MODEL,
): Record<string, unknown> {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) throw new Error("Image prompt must not be empty");
  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Image prompt exceeds the ${MAX_PROMPT_LENGTH} character limit`);
  }

  return {
    model: CODEX_IMAGE_MODELS[model],
    prompt: normalizedPrompt,
    n: 1,
    quality: "medium",
    size: "auto",
  };
}

export function resolveImageOutputRelativePath(
  requestedPath: string | undefined,
  timestamp: string,
  id: string,
): string {
  const suppliedPath = requestedPath?.trim();
  const candidate = suppliedPath || `generated-images/image-${timestamp}-${id}.png`;
  if (candidate.length > 1_000) throw new Error("Image output path exceeds the 1000 character limit");
  if (candidate.includes("\0")) throw new Error("Image output path contains an invalid null character");

  const normalizedPath = candidate.replace(/\\/gu, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:/u.test(normalizedPath) || isAbsolute(candidate)) {
    throw new Error("Image output path must be relative to the current working directory");
  }

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Image output path must not contain empty, current, or parent directory segments");
  }

  const filename = segments.at(-1)!;
  const extension = extname(filename);
  if (extension && extension.toLowerCase() !== ".png") {
    throw new Error("Image output path must use the .png extension");
  }
  if (!extension) segments[segments.length - 1] += ".png";

  return segments.join("/");
}

export function parseCodexImageResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Codex image response did not contain an image list");
  }

  const image = value.data.find(
    (item): item is Record<string, unknown> => isRecord(item) && typeof item.b64_json === "string",
  );
  if (!image || typeof image.b64_json !== "string") {
    throw new Error("Codex image response did not contain base64 image data");
  }

  const base64 = image.b64_json;
  if (
    base64.length === 0 ||
    base64.length > MAX_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)
  ) {
    throw new Error("Codex image response contained invalid or oversized base64 data");
  }

  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64").replace(/=+$/u, "") !== base64.replace(/=+$/u, "")
  ) {
    throw new Error("Codex image response contained invalid or oversized image data");
  }

  return base64;
}

export async function generateCodexImage(
  options: GenerateCodexImageOptions,
): Promise<GeneratedCodexImage> {
  const prompt = options.prompt.trim();
  const modelChoice = options.model ?? DEFAULT_CODEX_IMAGE_MODEL;
  const requestBody = buildCodexImageRequest(prompt, modelChoice);
  if (!options.auth.apiKey.trim()) throw new Error("No OpenAI Codex authentication token is available");

  const url = resolveCodexImageGenerationUrl(options.auth.baseUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.auth.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${options.auth.apiKey}`);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("originator", "pi");
  const turnId = (options.createId ?? randomUUID)();
  headers.set("x-codex-image-turn-id", turnId);

  const safeId = turnId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64);
  if (!safeId) throw new Error("Could not create a safe image filename");
  const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, "-");
  const relativePath = resolveImageOutputRelativePath(options.outputPath, timestamp, safeId);
  const cwd = resolve(options.cwd);
  const outputPath = resolve(cwd, relativePath);
  const outputDirectory = dirname(outputPath);
  assertPathWithin(cwd, outputPath);
  await assertSafeWorkspaceOutputDirectory(cwd, outputDirectory);
  await assertOutputFileAvailable(outputPath);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new Error("Codex image generation timed out after 180 seconds");
    }
    throw error;
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error("Codex image response exceeded the maximum allowed size");
  }

  const responseText = await readResponseText(response, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(formatHttpError(response.status, responseText));

  let responseValue: unknown;
  try {
    responseValue = JSON.parse(responseText);
  } catch {
    throw new Error("Codex image generation returned invalid JSON");
  }
  const data = parseCodexImageResponse(responseValue);
  const bytes = Buffer.from(data, "base64");

  const realOutputDirectory = await ensureWorkspaceOutputDirectory(cwd, outputDirectory);
  await writeFile(join(realOutputDirectory, basename(outputPath)), bytes, { flag: "wx", mode: 0o600 });

  return {
    data,
    mimeType: "image/png",
    relativePath,
    model: CODEX_IMAGE_MODELS[modelChoice],
  };
}

export async function generateCodexImageBatch(
  options: GenerateCodexImageBatchOptions,
): Promise<GeneratedCodexImageBatch> {
  const count = options.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CODEX_IMAGE_BATCH_COUNT) {
    throw new Error(`Image count must be an integer from 1 to ${MAX_CODEX_IMAGE_BATCH_COUNT}`);
  }

  const model = options.model ?? DEFAULT_CODEX_IMAGE_MODEL;
  const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, "-");
  const rawBatchId = (options.createId ?? randomUUID)();
  const batchId = rawBatchId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 48);
  if (!batchId) throw new Error("Could not create a safe image batch filename");

  const basePath = resolveImageOutputRelativePath(options.outputPath, timestamp, batchId);
  const outputPaths = Array.from({ length: count }, (_, index) =>
    count === 1 ? basePath : addBatchIndex(basePath, index + 1),
  );
  const cwd = resolve(options.cwd);
  const destinations = outputPaths.map((path) => {
    const absolutePath = resolve(cwd, path);
    assertPathWithin(cwd, absolutePath);
    return { path, absolutePath, directory: dirname(absolutePath) };
  });

  // Fail before spending image quota if any destination is invalid or already occupied.
  for (const destination of destinations) {
    await assertSafeWorkspaceOutputDirectory(cwd, destination.directory);
    await assertOutputFileAvailable(destination.absolutePath);
  }

  const results = await Promise.allSettled(
    destinations.map(({ path }, index) =>
      generateCodexImage({
        prompt: options.prompt,
        model,
        outputPath: path,
        cwd: options.cwd,
        auth: options.auth,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        now: options.now,
        createId: () => `${batchId}-${String(index + 1).padStart(2, "0")}`,
      }),
    ),
  );

  const images: GeneratedCodexImage[] = [];
  const failures: CodexImageBatchFailure[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      images.push(result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ index: index + 1, error: message.slice(0, 800) });
    }
  }

  if (images.length === 0) {
    const reason = failures[0]?.error ?? "Unknown image generation error";
    throw new Error(`Codex image batch failed; 0/${count} images were generated: ${reason}`);
  }

  return { requestedCount: count, images, failures };
}

function addBatchIndex(path: string, index: number): string {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}-${String(index).padStart(2, "0")}${extension}`;
}

async function assertSafeWorkspaceOutputDirectory(cwd: string, outputDirectory: string): Promise<void> {
  const realWorkspace = await realpath(cwd);
  let existingAncestor = outputDirectory;

  while (true) {
    try {
      const info = await stat(existingAncestor);
      if (!info.isDirectory()) {
        throw new Error("Image output path is blocked by a non-directory path segment");
      }
      break;
    } catch (error) {
      const code = fileErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("Could not resolve a safe image output directory");
      }
      existingAncestor = parent;
    }
  }

  assertPathWithin(realWorkspace, await realpath(existingAncestor));
}

async function ensureWorkspaceOutputDirectory(cwd: string, outputDirectory: string): Promise<string> {
  await assertSafeWorkspaceOutputDirectory(cwd, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const realOutputDirectory = await realpath(outputDirectory);
  assertPathWithin(await realpath(cwd), realOutputDirectory);
  return realOutputDirectory;
}

async function assertOutputFileAvailable(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
    throw new Error("Image output file already exists; choose a different path");
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }
}

function assertPathWithin(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Image output path must remain inside the current working directory");
  }
}

function fileErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Codex image response exceeded the maximum allowed size");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released its reader after cancellation.
    }
  }
}

function formatHttpError(status: number, responseText: string): string {
  let detail: string | undefined;
  try {
    const value: unknown = JSON.parse(responseText);
    if (isRecord(value)) {
      const error = isRecord(value.error) ? value.error : value;
      if (typeof error.message === "string") detail = error.message;
    }
  } catch {
    // Ignore non-JSON error bodies; they may be HTML or contain proxy details.
  }
  if (detail && detail.length > MAX_ERROR_DETAIL_LENGTH) {
    detail = `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`;
  }

  const suffix = detail ? `: ${detail}` : "";
  if (status === 401) {
    return `Codex image generation was unauthorized (HTTP 401); re-authenticate with /login openai-codex and retry${suffix}`;
  }
  if (status === 403) {
    return `Codex image generation is unavailable for this account or plan (HTTP 403)${suffix}`;
  }
  if (status === 429) {
    return `Codex image generation was rate-limited or quota-limited (HTTP 429)${suffix}`;
  }
  return `Codex image generation failed (HTTP ${status})${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
