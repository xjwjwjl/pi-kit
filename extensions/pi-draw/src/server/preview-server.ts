import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { listSceneFiles, readSceneFile } from "../core/scene.js";
import type { SavedScene } from "../core/scene.js";

type PreviewServer = {
	url: string;
	port: number;
	server: Server;
};

let currentServer: PreviewServer | undefined;
let currentCwd = process.cwd();
let agentStreaming = false;
let previewBrowserOpened = false;
let openPreviewOnNextSceneSave = false;

type PreviewEvent =
	| { type: "ready"; streaming: boolean }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "draw_generation_start" }
	| { type: "draw_generation_delta"; delta: string }
	| { type: "draw_generation_end" }
	| { type: "tool_start"; toolCallId?: string; toolName: string }
	| { type: "tool_end"; toolCallId?: string; toolName: string; isError?: boolean }
	| { type: "scene_saved"; path: string; title?: string; elementCount: number; updatedAt?: string; kind?: "elements" | "mermaid" }
	| { type: "error"; message: string };

type EventClient = {
	send(event: PreviewEvent): void;
	sendRaw(chunk: string): void;
	close(): void;
};

const eventClients = new Set<EventClient>();

export function markPreviewBrowserOpened(): void {
	previewBrowserOpened = true;
}

export function requestPreviewOpenOnNextSceneSave(): void {
	openPreviewOnNextSceneSave = true;
}

export function clearPreviewOpenOnNextSceneSave(): void {
	openPreviewOnNextSceneSave = false;
}

export function consumePreviewOpenDecision(openPreviewRequested: boolean): { requested: boolean; shouldOpen: boolean } {
	const requested = openPreviewRequested || openPreviewOnNextSceneSave;
	openPreviewOnNextSceneSave = false;
	return {
		requested,
		shouldOpen: requested && !previewBrowserOpened,
	};
}

function broadcastPreviewEvent(event: PreviewEvent): void {
	for (const client of [...eventClients]) {
		client.send(event);
	}
}

export function publishAgentStart(): void {
	agentStreaming = true;
	broadcastPreviewEvent({ type: "agent_start" });
}

export function publishAgentEnd(): void {
	agentStreaming = false;
	broadcastPreviewEvent({ type: "agent_end" });
}

export function publishDrawGenerationStart(): void {
	broadcastPreviewEvent({ type: "draw_generation_start" });
}

export function publishDrawGenerationDelta(delta: string): void {
	if (!delta) return;
	broadcastPreviewEvent({ type: "draw_generation_delta", delta });
}

export function publishDrawGenerationEnd(): void {
	broadcastPreviewEvent({ type: "draw_generation_end" });
}

export function publishToolStart(toolName: string, toolCallId?: string): void {
	broadcastPreviewEvent({ type: "tool_start", toolName, toolCallId });
}

export function publishToolEnd(toolName: string, toolCallId?: string, isError?: boolean): void {
	broadcastPreviewEvent({ type: "tool_end", toolName, toolCallId, isError });
}

export function publishSceneSaved(saved: SavedScene): void {
	broadcastPreviewEvent({
		type: "scene_saved",
		path: saved.relativePath,
		title: saved.document.title,
		elementCount: saved.document.elements.length,
		updatedAt: saved.document.updatedAt,
		kind: saved.document.kind,
	});
}

function extensionRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function contentTypeFor(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".html") return "text/html; charset=utf-8";
	if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
	if (ext === ".css") return "text/css; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	return "application/octet-stream";
}

function clientDistRoot(): string {
	return join(extensionRoot(), "web", "dist");
}

function fallbackHtml(): string {
	return [
		"<!doctype html>",
		"<html><head><meta charset=\"utf-8\"><title>pi-draw</title></head>",
		"<body style=\"font-family: sans-serif; padding: 24px\">",
		"<h1>pi-draw preview assets are not built</h1>",
		"<p>Run <code>npm run build:web</code> in the pi-draw extension directory, then reopen preview.</p>",
		"</body></html>",
	].join("");
}

function createPreviewApp(): Hono {
	const app = new Hono();

	app.get("/api/scenes", (c) => c.json({ cwd: currentCwd, scenes: listSceneFiles(currentCwd) }));

	app.get("/api/scene", (c) => {
		const requested = c.req.query("file");
		const scenes = listSceneFiles(currentCwd);
		const file = requested || scenes[0]?.path;
		if (!file) return c.json({ error: "No pi-draw scenes found." }, 404);

		try {
			return c.json({ path: file, scene: readSceneFile(currentCwd, file) });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to read scene.";
			return c.json({ error: message }, 400);
		}
	});

	app.get("/api/events", () => {
		const encoder = new TextEncoder();
		let closed = false;
		let keepAlive: ReturnType<typeof setInterval> | undefined;
		let activeClient: EventClient | undefined;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const client: EventClient = {
					send(event) {
						if (closed) return;
						try {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						} catch {
							client.close();
						}
					},
					sendRaw(chunk) {
						if (closed) return;
						try {
							controller.enqueue(encoder.encode(chunk));
						} catch {
							client.close();
						}
					},
					close() {
						if (closed) return;
						closed = true;
						eventClients.delete(client);
						if (keepAlive) clearInterval(keepAlive);
						try {
							controller.close();
						} catch {
							// The browser may have already closed the stream.
						}
					},
				};

				eventClients.add(client);
				activeClient = client;
				client.send({ type: "ready", streaming: agentStreaming });
				keepAlive = setInterval(() => client.sendRaw(": keep-alive\n\n"), 15000);
			},
			cancel() {
				closed = true;
				if (activeClient) eventClients.delete(activeClient);
				if (keepAlive) clearInterval(keepAlive);
			},
		});

		return new Response(stream, {
			headers: {
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Content-Type": "text/event-stream; charset=utf-8",
			},
		});
	});

	app.get("/*", (c) => {
		const distRoot = clientDistRoot();
		if (!existsSync(join(distRoot, "index.html"))) {
			return c.html(fallbackHtml());
		}

		const requestPath = new URL(c.req.url).pathname;
		const candidate = requestPath === "/" ? join(distRoot, "index.html") : resolve(distRoot, `.${requestPath}`);
		const resolved = existsSync(candidate) ? candidate : join(distRoot, "index.html");

		if (!resolved.startsWith(distRoot)) {
			return c.text("Not found", 404);
		}

		const body = readFileSync(resolved);
		return new Response(new Uint8Array(body), {
			headers: { "Content-Type": contentTypeFor(resolved) },
		});
	});

	return app;
}

function preferredPort(): number {
	const parsed = Number.parseInt(process.env.PI_DRAW_PORT || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 3717;
}

export async function ensurePreviewServer(cwd: string): Promise<PreviewServer> {
	currentCwd = cwd;
	if (currentServer) return currentServer;

	const app = createPreviewApp();
	const startPort = preferredPort();
	let lastError: unknown;

	for (let port = startPort; port < startPort + 20; port++) {
		try {
			const server = await new Promise<Server>((resolveServer, reject) => {
				const started = serve({
					fetch: app.fetch,
					port,
					createServer,
				}) as Server;
				started.once("error", reject);
				started.once("listening", () => resolveServer(started));
			});
			currentServer = {
				server,
				port,
				url: `http://127.0.0.1:${port}`,
			};
			return currentServer;
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError instanceof Error ? lastError : new Error("Failed to start pi-draw preview server.");
}
