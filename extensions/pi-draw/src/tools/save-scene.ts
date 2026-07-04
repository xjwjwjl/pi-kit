import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSceneLintSummary } from "../core/lint.js";
import { saveScene } from "../core/scene.js";
import { consumePreviewOpenDecision, ensurePreviewServer, markPreviewBrowserOpened, publishSceneSaved } from "../server/preview-server.js";
import { openUrl } from "../server/open-url.js";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

type SaveSceneParams = {
	elements?: unknown;
	title?: string;
	file?: string;
	optimize?: boolean;
	openPreview?: boolean;
};

const PARAMETERS = {
	type: "object",
	properties: {
		elements: {
			description: "ExcalidrawElementSkeleton JSON array, or a JSON string containing the array.",
			oneOf: [
				{ type: "array", items: { type: "object" } },
				{ type: "string" },
			],
		},
		title: {
			type: "string",
			description: "Short human-readable diagram title.",
		},
		file: {
			type: "string",
			description: "Optional relative output path. Defaults to .pi/draw/<title>.pi-draw.json.",
		},
		optimize: {
			type: "boolean",
			description: "Whether to optimize arrow coordinates for bound elements. Defaults to true.",
		},
		openPreview: {
			type: "boolean",
			description: "Open the local preview after saving. Use when the user asks to preview/open/see the diagram.",
		},
	},
	required: ["elements"],
	additionalProperties: false,
} as const;

export function createSaveSceneTool(): ToolDefinition {
	return {
		name: "pi_draw_save_scene",
		label: "Save Excalidraw Scene",
		description: "Save, repair, and optimize a pi-draw ExcalidrawElementSkeleton scene file for preview/editing.",
		promptSnippet: "Save generated ExcalidrawElementSkeleton JSON as a pi-draw scene",
		promptGuidelines: [
			"Use pi_draw_save_scene when you generate an Excalidraw diagram for the user.",
			"Call pi_draw_save_scene only after the complete scene is ready; do not save partial drafts.",
			"Pass elements as a JSON array of ExcalidrawElementSkeleton objects, not prose.",
			"Prefer stable element ids and bound arrow start/end ids.",
			"Size labeled rectangle/ellipse/diamond nodes generously enough for their text; pi-draw will auto-fit undersized labels, so leave room for the expanded node.",
			"Keep at least 32px of visual gap between independent nodes, and avoid standalone text overlapping unrelated shapes.",
			"Prefer rectangle background containers for visual lanes/zones; use frame only when true Excalidraw frame grouping is useful.",
			"When using frames, set frame.children to child element ids instead of using groupIds for frame membership.",
			"Do not add cross-frame connector arrows to frame.children; pi-draw detaches their bindings after coordinate optimization so they render across frames cleanly.",
			"Set openPreview=true when the user asks to preview, open, or see the diagram.",
			"After saving, summarize the diagram and mention the returned file path.",
		],
		parameters: PARAMETERS,

		async execute(_toolCallId, params: SaveSceneParams, _signal, _onUpdate, ctx) {
			if (!params || params.elements === undefined) {
				throw new Error("Missing required parameter: elements.");
			}

			const cwd = ctx?.cwd || process.cwd();
			const saved = saveScene({
				cwd,
				elements: params.elements,
				title: params.title,
				file: params.file,
				optimize: params.optimize,
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
				`Saved pi-draw scene: ${saved.relativePath}`,
				`Elements: ${saved.document.elements.length}`,
				...formatSceneLintSummary(saved.lint, 6),
				previewUrl ? `Preview: ${previewUrl}` : undefined,
			].filter((line): line is string => Boolean(line));

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					path: saved.path,
					relativePath: saved.relativePath,
					elementCount: saved.document.elements.length,
					lint: saved.lint,
					previewUrl,
				},
			};
		},
	};
}
