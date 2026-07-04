import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { saveMermaidScene } from "../core/scene.js";
import { consumePreviewOpenDecision, ensurePreviewServer, markPreviewBrowserOpened, publishSceneSaved } from "../server/preview-server.js";
import { openUrl } from "../server/open-url.js";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

type SaveMermaidSceneParams = {
	definition?: string;
	config?: Record<string, unknown>;
	title?: string;
	file?: string;
	openPreview?: boolean;
};

const PARAMETERS = {
	type: "object",
	properties: {
		definition: {
			type: "string",
			description: "Mermaid diagram definition, for example flowchart TD, sequenceDiagram, classDiagram, erDiagram, or stateDiagram.",
		},
		config: {
			type: "object",
			description: "Optional Mermaid config. Keep this minimal; pi-draw supports fontSize and linear flowchart curves best.",
			additionalProperties: true,
		},
		title: {
			type: "string",
			description: "Short human-readable diagram title.",
		},
		file: {
			type: "string",
			description: "Optional relative output path. Defaults to .pi/draw/<title>.pi-draw.json.",
		},
		openPreview: {
			type: "boolean",
			description: "Open the local preview after saving. Use when the user asks to preview/open/see the diagram.",
		},
	},
	required: ["definition"],
	additionalProperties: false,
} as const;

export function createSaveMermaidSceneTool(): ToolDefinition {
	return {
		name: "pi_draw_save_mermaid_scene",
		label: "Save Mermaid Scene",
		description: "Save a native Mermaid diagram definition as a pi-draw scene. The render-only preview renders it as Mermaid SVG, separate from Excalidraw.",
		promptSnippet: "Save native Mermaid diagram definition as a pi-draw scene",
		promptGuidelines: [
			"Use pi_draw_save_mermaid_scene when the user provides Mermaid DSL or explicitly asks for a Mermaid diagram.",
			"Do not convert Mermaid diagrams into ExcalidrawElementSkeleton elements.",
			"For ordinary natural-language Excalidraw-style diagram generation, use pi_draw_save_scene with ExcalidrawElementSkeleton elements.",
			"Keep Mermaid definitions concise and valid; supported diagram families render best for flowchart, sequenceDiagram, classDiagram, erDiagram, and stateDiagram.",
			"Set openPreview=true when the user asks to preview, open, or see the diagram.",
			"After saving, summarize the diagram and mention the returned file path.",
		],
		parameters: PARAMETERS,

		async execute(_toolCallId, params: SaveMermaidSceneParams, _signal, _onUpdate, ctx) {
			if (!params || typeof params.definition !== "string") {
				throw new Error("Missing required parameter: definition.");
			}

			const cwd = ctx?.cwd || process.cwd();
			const saved = saveMermaidScene({
				cwd,
				definition: params.definition,
				config: params.config,
				title: params.title,
				file: params.file,
			});
			publishSceneSaved(saved);

			let previewUrl: string | undefined;
			const previewOpen = consumePreviewOpenDecision(Boolean(params.openPreview));
			if (previewOpen.requested) {
				const server = await ensurePreviewServer(cwd);
				previewUrl = `${server.url}/?file=${encodeURIComponent(saved.relativePath)}`;
				if (previewOpen.shouldOpen) {
					await openUrl(previewUrl);
					markPreviewBrowserOpened();
				}
			}

			const lines = [
				`Saved pi-draw Mermaid scene: ${saved.relativePath}`,
				`Definition length: ${saved.document.mermaid?.definition.length ?? 0}`,
				previewUrl ? `Preview: ${previewUrl}` : undefined,
			].filter((line): line is string => Boolean(line));

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					path: saved.path,
					relativePath: saved.relativePath,
					kind: saved.document.kind,
					definitionLength: saved.document.mermaid?.definition.length ?? 0,
					previewUrl,
				},
			};
		},
	};
}
