import { performance } from "node:perf_hooks";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CODEX_IMAGE_GENERATION_TOOL,
  CODEX_IMAGE_MODELS,
  DEFAULT_CODEX_IMAGE_MODEL,
  DEFAULT_CODEX_IMAGE_QUALITY,
  DEFAULT_CODEX_IMAGE_SIZE,
  generateCodexImageBatch,
  isCodexModel,
  MAX_CODEX_IMAGE_BATCH_COUNT,
  MAX_REFERENCE_IMAGES,
  type CodexImageModelChoice,
} from "./src/imagegen-api.ts";
import {
  renderCodexImageCall,
  renderCodexImageResult,
  type CodexImageGenArgs,
  type CodexImageGenDetails,
} from "./src/render.ts";

const IMAGE_MODEL_COMMAND = "codex-image-model";
const IMAGE_MODEL_CHOICES: CodexImageModelChoice[] = ["flare", "sunburst"];

const IMAGE_TOOL_PARAMETERS = Type.Object(
  {
    prompt: Type.String({
      description: "A detailed prompt for a new image. This tool does not edit existing images.",
      minLength: 1,
      maxLength: 20_000,
    }),
    model: Type.Optional(
      Type.Union([Type.Literal("flare"), Type.Literal("sunburst")], {
        description: "Image model: flare or sunburst. Omit for the default Sunburst model or the model selected with /codex-image-model.",
      }),
    ),
    count: Type.Optional(
      Type.Integer({
        description: "Number of images to generate concurrently (1-25, default 1)",
        minimum: 1,
        maximum: MAX_CODEX_IMAGE_BATCH_COUNT,
      }),
    ),
    quality: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
        description:
          "Rendering fidelity: low is fastest and cheapest, high is the most detailed and the default. Omit unless the user asks for a specific level.",
      }),
    ),
    size: Type.Optional(
      Type.String({
        pattern: "^(auto|[0-9]{3,4}x[0-9]{3,4})$",
        maxLength: 9,
        description:
          'Requested output dimensions: "auto" (default) or WIDTHxHEIGHT, such as 1536x1024. Both edges must be multiples of 16, at most 3840px; total pixels 655360-8294400; aspect ratio no wider/taller than 3:1.',
      }),
    ),
    reference_images: Type.Optional(
      Type.Array(Type.String({ maxLength: 1_000 }), {
        maxItems: MAX_REFERENCE_IMAGES,
        description:
          "Optional workspace-relative paths (PNG/JPG/JPEG/WebP) to reference images that condition the generation, such as a character sheet or three-view. Pass the user's own reference files when they provide them (1-8 images). Omit for text-only generation.",
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
    const durationByCallId = new Map<string, number>();

    pi.registerCommand(IMAGE_MODEL_COMMAND, {
      description: "Choose the GPT Image model used by codex_image_gen (Sunburst by default)",
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
        "Generate one or more images with a selectable GPT Image model through the signed-in OpenAI Codex account. The optional model parameter accepts flare or sunburst; it defaults to Sunburst unless changed with /codex-image-model. Count defaults to 1 and is limited to 25; requests run concurrently. Each generated image is limited to 20 MiB. Quality defaults to high and accepts low, medium, or high. Size defaults to auto; optionally pass a valid WIDTHxHEIGHT to request exact dimensions. Pass reference_images (workspace-relative PNG/JPG/WebP paths) to condition generation on the user's own reference files, such as a character three-view; otherwise generation is text-only. Saves to generated-images/ by default, or to an explicitly requested workspace-relative PNG path.",
      promptSnippet: "Create a new image only when the user explicitly asks for image generation.",
      promptGuidelines: [
        "Only call codex_image_gen when the user explicitly requests creating a new image; each generated image consumes Codex image-generation quota.",
        "Use count when the user requests multiple options: use their exact count, up to 25; if they ask for multiple without a number, use 4. Otherwise omit count (default 1).",
        "Use model only when the user explicitly requests Flare or Sunburst; otherwise omit it (default Sunburst, or the choice made with /codex-image-model).",
        "Write a clear, structured prompt that preserves the user's request: specify the subject/action, scene, composition, visual style, lighting/palette, and requested aspect ratio when relevant. Do not invent unrequested text, logos, props, or story details.",
        "When the user provides or refers to a workspace reference image (such as a character three-view), pass its path through reference_images. Preserve identity-defining features by default; only change clothing, hairstyle, colors, pose, or other design details when explicitly requested. Describe the requested scene, background, and changes in the prompt.",
        "Use reference_images only with files that already exist in the workspace; do not invent paths.",
        "Use quality only when the user explicitly requests a fidelity level: 'low', 'medium', or 'high'. Otherwise omit it (default high).",
        "Use size only when the user requests a specific resolution or orientation; otherwise omit it (default auto). For explicit dimensions, use a valid WIDTHxHEIGHT with both sides multiples of 16, each side at most 3840, total pixels 655360-8294400, and aspect ratio at most 3:1. Align the prompt's composition with the requested orientation. The standard 1920x1080 is invalid under these constraints; do not claim exact 1080p.",
        "After generating, inspect the returned image(s) against the user's requirements. If there is a clear mismatch, make at most one automatic retry with a targeted prompt correction. If it still misses or the requested change is ambiguous, show the result and ask the user before further retries; do not retry for merely subjective minor differences.",
        "Use output_path only when the user explicitly requests a destination; keep it relative to the working directory and use a .png filename. For multiple images, the plugin adds numbered suffixes. Otherwise omit it.",
      ],
      parameters: IMAGE_TOOL_PARAMETERS,
      renderCall(args, theme, context) {
        return renderCodexImageCall(
          args as CodexImageGenArgs,
          theme,
          context,
          durationByCallId.get(context.toolCallId),
        );
      },
      renderResult(result, options, theme, context) {
        const typedResult = result as AgentToolResult<CodexImageGenDetails>;
        if (typeof typedResult.details?.durationMs === "number") {
          durationByCallId.set(context.toolCallId, typedResult.details.durationMs);
        }
        return renderCodexImageResult(typedResult, options, theme, context);
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const startedAt = performance.now();
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
          quality: params.quality,
          size: params.size,
          referenceImagePaths: params.reference_images,
          model: params.model ?? selectedImageModel,
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
        const durationMs = Math.max(0, performance.now() - startedAt);
        durationByCallId.set(_toolCallId, durationMs);
        const paths = batch.images.map((image) => image.relativePath);
        const dimensions = batch.images.map((image) =>
          image.dimensions ? `${image.dimensions.width}x${image.dimensions.height}` : null,
        );
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
            dimensions,
            referenceImages: params.reference_images ?? [],
            quality: params.quality ?? DEFAULT_CODEX_IMAGE_QUALITY,
            size: params.size ?? DEFAULT_CODEX_IMAGE_SIZE,
            durationMs,
            failures: batch.failures,
            model: CODEX_IMAGE_MODELS[params.model ?? selectedImageModel],
          },
        };
      },
    });

    pi.on("session_start", (_event, ctx) => syncImageToolAvailability(pi, ctx.model));
    pi.on("model_select", (event) => syncImageToolAvailability(pi, event.model));
  };
}

export default createCodexImageGenExtension();
