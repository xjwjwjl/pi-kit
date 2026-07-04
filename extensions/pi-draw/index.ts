import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { chartTypeGuidance } from "./src/core/chart-types.js";
import { isPiDrawRequest, PI_DRAW_SYSTEM_PROMPT } from "./src/core/prompts.js";
import { buildDrawRequestPrompt, type DrawRequestMode } from "./src/core/request.js";
import { createSaveMermaidSceneTool } from "./src/tools/save-mermaid-scene.js";
import { createSaveSceneTool } from "./src/tools/save-scene.js";
import {
	clearPreviewOpenOnNextSceneSave,
	ensurePreviewServer,
	markPreviewBrowserOpened,
	publishAgentEnd,
	publishAgentStart,
	publishDrawGenerationDelta,
	publishDrawGenerationEnd,
	publishDrawGenerationStart,
	publishToolEnd,
	publishToolStart,
	requestPreviewOpenOnNextSceneSave,
} from "./src/server/preview-server.js";
import { openUrl } from "./src/server/open-url.js";

function getContextCwd(ctx: { cwd?: string } | undefined): string {
	return ctx?.cwd || process.cwd();
}

const DRAW_SAVE_TOOL_NAMES = new Set(["pi_draw_save_scene", "pi_draw_save_mermaid_scene"]);
const drawToolContentIndexes = new Set<number>();
const startedDrawToolContentIndexes = new Set<number>();

const DRAW_USAGE = [
	"Usage:",
	"/draw-excalidraw <request>     create an Excalidraw canvas scene",
	"/draw-mermaid <request>        create a native Mermaid SVG scene",
	"/draw-preview [file]      open render-only preview",
	"/draw-status              show preview server address",
].join("\n");

type StreamingToolCall = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
};

type StreamingAssistantEvent = {
	type?: string;
	contentIndex?: unknown;
	delta?: unknown;
	toolCall?: StreamingToolCall;
	partial?: {
		content?: StreamingToolCall[];
	};
};

function getToolCallName(event: StreamingAssistantEvent): string | undefined {
	const directName = event.toolCall?.name;
	if (typeof directName === "string") return directName;
	const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : undefined;
	if (contentIndex === undefined) return undefined;
	const block = event.partial?.content?.[contentIndex];
	return block?.type === "toolCall" && typeof block.name === "string" ? block.name : undefined;
}

function getToolCallIndex(event: StreamingAssistantEvent): number | undefined {
	return typeof event.contentIndex === "number" ? event.contentIndex : undefined;
}

function isDrawSaveToolEvent(event: StreamingAssistantEvent): boolean {
	const contentIndex = getToolCallIndex(event);
	const toolName = getToolCallName(event);
	return (toolName !== undefined && DRAW_SAVE_TOOL_NAMES.has(toolName)) || (contentIndex !== undefined && drawToolContentIndexes.has(contentIndex));
}

function markDrawSaveToolEvent(event: StreamingAssistantEvent): boolean {
	if (!isDrawSaveToolEvent(event)) return false;
	const contentIndex = getToolCallIndex(event);
	if (contentIndex !== undefined) {
		drawToolContentIndexes.add(contentIndex);
	}
	return true;
}

function publishDrawGenerationStartOnce(event: StreamingAssistantEvent): void {
	const contentIndex = getToolCallIndex(event);
	if (contentIndex !== undefined) {
		if (startedDrawToolContentIndexes.has(contentIndex)) return;
		startedDrawToolContentIndexes.add(contentIndex);
	}
	publishDrawGenerationStart();
}

function drawModeLabel(mode: DrawRequestMode): string {
	if (mode === "mermaid") return "Mermaid";
	if (mode === "excalidraw") return "Excalidraw";
	return "auto";
}

async function openPreview(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const cwd = getContextCwd(ctx);
	const server = await ensurePreviewServer(cwd);
	const file = args.trim();
	const url = file ? `${server.url}/?file=${encodeURIComponent(file)}` : server.url;
	await openUrl(url);
	markPreviewBrowserOpened();
	ctx.ui?.setStatus?.("pi-draw", "draw preview");
	ctx.ui?.notify?.(`Opened pi-draw preview: ${url}`, "info");
}

async function showPreviewStatus(ctx: ExtensionCommandContext): Promise<void> {
	const server = await ensurePreviewServer(getContextCwd(ctx));
	ctx.ui?.setStatus?.("pi-draw", "draw ready");
	ctx.ui?.notify?.(`pi-draw preview server: ${server.url}`, "info");
}

function createPreviewCommandHandler() {
	return async function handlePreviewCommand(args: string, ctx: ExtensionCommandContext) {
		const trimmed = args.trim();
		if (trimmed === "help") {
			ctx.ui?.notify?.(DRAW_USAGE, "info");
			return;
		}
		await openPreview(trimmed, ctx);
	};
}

function createStatusCommandHandler() {
	return async function handleStatusCommand(_args: string, ctx: ExtensionCommandContext) {
		await showPreviewStatus(ctx);
	};
}

function createDiagramCommandHandler(pi: ExtensionAPI, mode: DrawRequestMode) {
	return async function handleDiagramCommand(args: string, ctx: ExtensionCommandContext) {
		const trimmed = args.trim();

		if (!trimmed || trimmed === "help") {
			ctx.ui?.notify?.(DRAW_USAGE, "info");
			return;
		}

		requestPreviewOpenOnNextSceneSave();
		const queued = !ctx.isIdle();
		pi.sendUserMessage(buildDrawRequestPrompt(trimmed, { mode, openPreview: true }), queued ? { deliverAs: "followUp" } : undefined);
		ctx.ui?.setStatus?.("pi-draw", queued ? `draw ${mode} queued` : `draw ${mode} running`);
		const modeLabel = drawModeLabel(mode);
		ctx.ui?.notify?.(
			queued
				? `Queued pi-draw ${modeLabel} request. The preview will open after the scene is saved.`
				: `Sent pi-draw ${modeLabel} request. The preview will open after the scene is saved.`,
			"info",
		);
	};
}

export default function piDrawExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSaveSceneTool());
	pi.registerTool(createSaveMermaidSceneTool());

	pi.registerCommand("draw-excalidraw", {
		description: "Create an Excalidraw canvas scene and open the render-only preview after saving",
		handler: createDiagramCommandHandler(pi, "excalidraw"),
	});

	pi.registerCommand("draw-mermaid", {
		description: "Create a native Mermaid SVG scene and open the render-only preview after saving",
		handler: createDiagramCommandHandler(pi, "mermaid"),
	});

	pi.registerCommand("draw-preview", {
		description: "Open the pi-draw render-only preview",
		handler: createPreviewCommandHandler(),
	});

	pi.registerCommand("draw-status", {
		description: "Show the pi-draw preview server address",
		handler: createStatusCommandHandler(),
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui?.setStatus?.("pi-draw", "draw");
	});

	pi.on("agent_start", () => {
		drawToolContentIndexes.clear();
		startedDrawToolContentIndexes.clear();
		publishAgentStart();
	});

	pi.on("message_update", (event) => {
		const assistantEvent = (event as unknown as { assistantMessageEvent?: StreamingAssistantEvent }).assistantMessageEvent;
		if (!assistantEvent) return;
		if (assistantEvent.type === "toolcall_start") {
			if (markDrawSaveToolEvent(assistantEvent)) {
				publishDrawGenerationStartOnce(assistantEvent);
			}
			return;
		}

		if (assistantEvent.type === "toolcall_delta") {
			if (!markDrawSaveToolEvent(assistantEvent)) return;
			publishDrawGenerationStartOnce(assistantEvent);
			if (typeof assistantEvent.delta === "string") {
				publishDrawGenerationDelta(assistantEvent.delta);
			}
			return;
		}

		if (assistantEvent.type === "toolcall_end") {
			if (!markDrawSaveToolEvent(assistantEvent)) return;
			publishDrawGenerationEnd();
			const contentIndex = getToolCallIndex(assistantEvent);
			if (contentIndex !== undefined) {
				drawToolContentIndexes.delete(contentIndex);
				startedDrawToolContentIndexes.delete(contentIndex);
			}
		}
	});

	pi.on("tool_execution_start", (event) => {
		const toolEvent = event as unknown as { toolName?: unknown; toolCallId?: unknown };
		if (typeof toolEvent.toolName !== "string") return;
		publishToolStart(toolEvent.toolName, typeof toolEvent.toolCallId === "string" ? toolEvent.toolCallId : undefined);
	});

	pi.on("tool_execution_end", (event) => {
		const toolEvent = event as unknown as { toolName?: unknown; toolCallId?: unknown; isError?: unknown };
		if (typeof toolEvent.toolName !== "string") return;
		publishToolEnd(
			toolEvent.toolName,
			typeof toolEvent.toolCallId === "string" ? toolEvent.toolCallId : undefined,
			typeof toolEvent.isError === "boolean" ? toolEvent.isError : undefined,
		);
	});

	pi.on("agent_end", () => {
		drawToolContentIndexes.clear();
		startedDrawToolContentIndexes.clear();
		clearPreviewOpenOnNextSceneSave();
		publishAgentEnd();
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt ?? "";
		if (!isPiDrawRequest(prompt)) return undefined;
		const skipChartGuidance = prompt.includes("## 图表类型") || prompt.includes("渲染模式：Mermaid");
		const guidance = skipChartGuidance ? "" : `\n\n${chartTypeGuidance(prompt)}`;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${PI_DRAW_SYSTEM_PROMPT}${guidance}`,
		};
	});
}
