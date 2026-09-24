import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CODEX_IMAGE_GENERATION_TOOL,
  CODEX_IMAGE_MODELS,
  DEFAULT_CODEX_IMAGE_MODEL,
  generateCodexImageBatch,
  isCodexModel,
  MAX_CODEX_IMAGE_BATCH_COUNT,
  type CodexImageModelChoice,
} from "./src/imagegen-api.ts";

const IMAGE_MODEL_COMMAND = "codex-image-model";
const IMAGE_MODEL_CHOICES: CodexImageModelChoice[] = ["flare", "sunburst"];

const IMAGE_TOOL_PARAMETERS = Type.Object(
  {
    prompt: Type.String({
      description: "A detailed prompt for a new image. This tool does not edit existing images.",
      minLength: 1,
      maxLength: 20_000,
    }),
    count: Type.Optional(
      Type.Integer({
        description: "Number of images to generate concurrently (1-4, default 1)",
        minimum: 1,
        maximum: MAX_CODEX_IMAGE_BATCH_COUNT,
      }),
    ),
    output_path: Type.Optional(
      Type.String({
        description:
          "Optional PNG file path relative to the current working directory. For multiple images, a numbered suffix is added. Omit to save under generated-images/.",
        maxLength: 1_000,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface CodexImageGenExtensionOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createId?: () => string;
}

function notify(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function syncImageToolAvailability(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  model: ExtensionContext["model"],
): void {
  const activeTools = pi.getActiveTools();
  const isActive = activeTools.includes(CODEX_IMAGE_GENERATION_TOOL);
  const shouldBeActive = isCodexModel(model);

  if (shouldBeActive && !isActive) {
    pi.setActiveTools([...activeTools, CODEX_IMAGE_GENERATION_TOOL]);
  } else if (!shouldBeActive && isActive) {
    pi.setActiveTools(activeTools.filter((name) => name !== CODEX_IMAGE_GENERATION_TOOL));
  }
}

export function createCodexImageGenExtension(
  options: CodexImageGenExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let selectedImageModel = DEFAULT_CODEX_IMAGE_MODEL;

    pi.registerCommand(IMAGE_MODEL_COMMAND, {
      description: "Choose the GPT Image model used by codex_image_gen (Flare by default)",
      getArgumentCompletions: (prefix: string) => {
        const normalized = prefix.trim().toLowerCase();
        return [...IMAGE_MODEL_CHOICES, "status"]
          .filter((choice) => choice.startsWith(normalized))
          .map((choice) => ({ value: choice, label: choice }));
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const requested = args.trim().toLowerCase();
        if (!requested || requested === "status") {
          notify(
            ctx,
            `Codex image model: ${selectedImageModel} (${CODEX_IMAGE_MODELS[selectedImageModel]}).`,
            "info",
          );
          return;
        }

        if (requested === "flare" || requested === "sunburst") {
          selectedImageModel = requested;
          notify(
            ctx,
            `Codex image model set to ${selectedImageModel} (${CODEX_IMAGE_MODELS[selectedImageModel]}).`,
            "info",
          );
          return;
        }

        notify(ctx, "Usage: /codex-image-model [flare|sunburst|status]", "warning");
      },
    });

    pi.registerTool({
      name: CODEX_IMAGE_GENERATION_TOOL,
      label: "Codex Image Gen",
      description:
        "Generate one or more images with the selected GPT Image model through the signed-in OpenAI Codex account. Use /codex-image-model to switch between Flare and Sunburst. Count defaults to 1 and is limited to 4; requests run concurrently. Saves to generated-images/ by default, or to an explicitly requested workspace-relative PNG path. Does not edit or use reference images.",
      promptSnippet: "Create a new image only when the user explicitly asks for image generation.",
      promptGuidelines: [
        "Only call codex_image_gen when the user explicitly requests creating a new image; each generated image consumes Codex image-generation quota.",
        "Use count when the user requests multiple options: use their exact count, up to 4; if they ask for multiple without a number, use 4. Otherwise omit count (default 1).",
        "Describe the requested image faithfully in the prompt. This MVP generates new images only and cannot edit existing images.",
        "Use output_path only when the user explicitly requests a destination; keep it relative to the working directory and use a .png filename. For multiple images, the plugin adds numbered suffixes. Otherwise omit it.",
      ],
      parameters: IMAGE_TOOL_PARAMETERS,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const model = ctx.model;
        if (!model || !isCodexModel(model)) {
          throw new Error("codex_image_gen is available only with the openai-codex Responses model");
        }

        const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!resolvedAuth.ok) {
          throw new Error(`Could not resolve OpenAI Codex authentication: ${resolvedAuth.error}`);
        }
        if (!resolvedAuth.apiKey) {
          throw new Error("No OpenAI Codex authentication token is available; run /login openai-codex");
        }

        const batch = await generateCodexImageBatch({
          prompt: params.prompt,
          count: params.count,
          model: selectedImageModel,
          outputPath: params.output_path,
          cwd: ctx.cwd,
          auth: {
            apiKey: resolvedAuth.apiKey,
            baseUrl: resolvedAuth.baseUrl ?? model.baseUrl,
            headers: resolvedAuth.headers,
          },
          signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.createId ? { createId: options.createId } : {}),
        });
        const paths = batch.images.map((image) => image.relativePath);
        const summary = batch.failures.length
          ? `Generated ${batch.images.length}/${batch.requestedCount} images. Saved: ${paths.join(", ")}. Failed: ${batch.failures.map((failure) => `#${failure.index} ${failure.error}`).join("; ")}.`
          : `Generated ${batch.images.length} image(s). Saved: ${paths.join(", ")}.`;

        return {
          content: [
            { type: "text", text: summary },
            ...batch.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ],
          details: {
            requestedCount: batch.requestedCount,
            generatedCount: batch.images.length,
            paths,
            failures: batch.failures,
            model: CODEX_IMAGE_MODELS[selectedImageModel],
          },
        };
      },
    });

    pi.on("session_start", (_event, ctx) => syncImageToolAvailability(pi, ctx.model));
    pi.on("model_select", (event) => syncImageToolAvailability(pi, event.model));
  };
}

export default createCodexImageGenExtension();
