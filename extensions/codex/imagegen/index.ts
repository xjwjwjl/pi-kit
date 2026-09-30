import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
      description: "A detailed prompt for image generation or reference-based editing. Always creates a new image file and cannot modify the source in place. For edits, state the requested changes and what must remain unchanged.",
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
        description: "Number of candidate images generated concurrently from the same prompt (1-25, default 1). Different styles, compositions, or design directions require separate calls with distinct prompts.",
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
          'Target output dimensions: "auto" (default) or WIDTHxHEIGHT, such as 1536x1024. Both edges must be multiples of 16, at most 3840px; total pixels 655360-8294400; aspect ratio no wider/taller than 3:1. Actual output dimensions may differ.',
      }),
    ),
    reference_images: Type.Optional(
      Type.Array(Type.String({ maxLength: 1_000 }), {
        maxItems: MAX_REFERENCE_IMAGES,
        description:
          "Optional paths to existing local PNG/JPG/JPEG/WebP files (relative to the current working directory, including ./, or absolute; 1-8 images). Use only references the user provided or explicitly identified, or outputs generated for the current request when making a permitted correction. Omit for text-only generation.",
      }),
    ),
    output_path: Type.Optional(
      Type.String({
        description:
          "Optional PNG file path relative to the current working directory. For multiple images, a numbered suffix is added. Existing files are never overwritten; use a fresh path for corrections. Omit to save under generated-images/.",
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
        "Generate or edit images into new files with a selectable GPT Image model through the signed-in OpenAI Codex account; source files are never modified in place. The optional model parameter accepts flare or sunburst; it defaults to Sunburst unless changed with /codex-image-model. Count defaults to 1 and is limited to 25; candidates use the same prompt and requests run concurrently. Each generated image is limited to 20 MiB. Quality defaults to high and accepts low, medium, or high. Size defaults to auto; optionally pass a valid WIDTHxHEIGHT to request target dimensions, which the actual output may not match. Pass reference_images (relative or absolute paths to existing PNG/JPG/WebP files on the local filesystem) to use references the user provided or explicitly identified, or outputs generated for the current request when making a permitted correction; otherwise generation is text-only. Saves to generated-images/ by default, or to an explicitly requested workspace-relative PNG path.",
      promptSnippet: "Generate or edit images into new files only when explicitly requested by the user.",
      promptGuidelines: [
        "Only call codex_image_gen when the user explicitly requests image generation or editing; each generated image consumes Codex image-generation quota. Always save a new file instead of modifying the source in place.",
        "Use count only for multiple candidates from the same prompt: use the user's exact count, up to 25, or 4 if they request multiple without a number. Otherwise omit count (default 1). For different styles, compositions, or design directions, use separate calls with distinct prompts; keep the combined image count at the requested total.",
        "Use model only when the user explicitly requests Flare or Sunburst; otherwise omit it (default Sunburst, or the choice made with /codex-image-model).",
        "Write a clear, structured prompt that preserves the user's request: specify the subject/action, scene, composition, visual style, lighting/palette, and requested aspect ratio when relevant. Do not invent unrequested text, logos, props, or story details.",
        "When the user provides or refers to a local reference image, pass its path through reference_images. In the prompt, identify each input by its 1-based order and purpose (e.g. Image 1: edit target, Image 2: style reference), describe how to combine them, and state the requested changes and details that must remain unchanged. Preserve subject identity when relevant. For a new scene, pose and expression may follow the requested action. For a local edit, change only requested elements and preserve all unrelated details, including pose and expression.",
        "Use reference_images only with existing files the user provided or explicitly identified, or outputs generated for the current request when making a permitted correction; do not invent paths or select unrelated local images.",
        "Use quality only when the user explicitly requests a fidelity level: 'low', 'medium', or 'high'. Otherwise omit it (default high).",
        "Use size only when the user requests a specific resolution or orientation; otherwise omit it (default auto). For explicit dimensions, use a valid WIDTHxHEIGHT with both sides multiples of 16, each side at most 3840, total pixels 655360-8294400, and aspect ratio at most 3:1. Align the prompt's composition with the requested orientation. The standard 1920x1080 is invalid under these constraints; do not claim exact 1080p. Size requests target dimensions, not guaranteed output dimensions; do not report the requested size as the actual size without verifying the saved file.",
        "After generating, inspect the results against the user's requirements. For clear visual mismatches, allow at most one automatic correction round per user request; correct only nonconforming images and keep acceptable results. Use each affected output as a reference for local corrections and repeat the change/preserve constraints. Do not automatically retry authentication, access, rate-limit, or quota errors. If the result still misses or the correction is ambiguous, show it and ask before further calls; do not retry for subjective minor differences.",
        "Use output_path only when the user explicitly requests a destination; keep it relative to the working directory and use a .png filename. For multiple images, the plugin adds numbered suffixes. For corrections, choose a fresh PNG filename in the same directory as the requested destination; never reuse an existing output path. Otherwise omit output_path to use generated-images/.",
        "When linking generated images in the final response, use the exact absolute file:// URL provided in the tool result as the Markdown link target. Use the relative path only as link text or for display; do not link to a relative path.",
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
        const paths = batch.images.map((image) => `./${image.relativePath}`);
        const fileUrls = batch.images.map((image) =>
          pathToFileURL(resolve(ctx.cwd, image.relativePath)).href,
        );
        const dimensions = batch.images.map((image) =>
          image.dimensions ? `${image.dimensions.width}x${image.dimensions.height}` : null,
        );
        const outputSummary = batch.images
          .map((image, index) => `Saved: ./${image.relativePath}\nOpen: ${fileUrls[index]}`)
          .join("\n");
        const summary = batch.failures.length
          ? `Generated ${batch.images.length}/${batch.requestedCount} images.\n${outputSummary}\nFailed: ${batch.failures.map((failure) => `#${failure.index} ${failure.error}`).join("; ")}.`
          : `Generated ${batch.images.length} image(s).\n${outputSummary}`;

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
