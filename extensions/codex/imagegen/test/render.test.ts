import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  Theme,
} from "@earendil-works/pi-coding-agent";

import {
  renderCodexImageCall,
  renderCodexImageResult,
  type CodexImageGenArgs,
  type CodexImageGenDetails,
} from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const context = { expanded: false, isError: false };

const BATCH_ID = "1342a4ae-3aac-4832-b74b-aa4d90064dcd";

function batchDetails(overrides: Partial<CodexImageGenDetails> = {}): CodexImageGenDetails {
  const paths = Array.from(
    { length: 6 },
    (_, index) =>
      `generated-images/image-2026-09-28T02-46-43-187Z-${BATCH_ID}-${String(index + 1).padStart(2, "0")}.png`,
  );
  return {
    requestedCount: 6,
    generatedCount: 6,
    paths,
    dimensions: ["1230x1278", "1223x1286", "1247x1261", "1254x1254", "1261x1247", "1230x1278"],
    referenceImages: [],
    quality: "high",
    size: "auto",
    durationMs: 2_345,
    failures: [],
    model: "gpt-image-2.5-flare",
    ...overrides,
  };
}

function expectedTree(details: CodexImageGenDetails): string[] {
  return details.paths.map((path, index) => {
    const branch = index === details.paths.length - 1 ? "└ " : "├ ";
    const actualSize = details.dimensions?.[index];
    return ` ${branch}${path}${actualSize ? `  [${actualSize}]` : ""}`;
  });
}

function renderResult(details: CodexImageGenDetails, expanded: boolean, isError = false): string[] {
  const result = {
    content: [{ type: "text", text: "Generated 6 image(s). Saved: generated-images/..." }],
    details,
  } as unknown as AgentToolResult<CodexImageGenDetails>;
  return renderCodexImageResult(result, { expanded, isPartial: false }, theme, { ...context, isError })
    .render(120)
    .map((line) => line.trimEnd());
}

test("renders the title and the prompt identically in both states", () => {
  const args = {
    prompt: "a cyberpunk cat",
    count: 6,
    quality: "high",
    reference_images: ["refs/hero.png"],
  } as CodexImageGenArgs;
  const expected = ["codex_image_gen ×6 · 1 ref", "a cyberpunk cat"];
  assert.deepEqual(renderCodexImageCall(args, theme, { expanded: false }).render(120).map((line) => line.trimEnd()), expected);
  assert.deepEqual(renderCodexImageCall(args, theme, { expanded: true }).render(120).map((line) => line.trimEnd()), expected);
});

test("shows elapsed time in the call title after generation completes", () => {
  const call = renderCodexImageCall({ prompt: "a cat", count: 1 }, theme, context, 2_345);
  assert.equal(call.render(120)[0]?.trimEnd(), "codex_image_gen ×1 · 2.3s");
});

test("shows reference count beside elapsed time in the call title", () => {
  const oneReference = renderCodexImageCall(
    { count: 3, reference_images: ["refs/hero.png"] },
    theme,
    context,
    61_000,
  );
  assert.equal(oneReference.render(120)[0]?.trimEnd(), "codex_image_gen ×3 · 1 ref · 1m 01s");

  const multipleReferences = renderCodexImageCall(
    { count: 3, reference_images: ["refs/hero.png", "refs/side.png"] },
    theme,
    context,
    61_000,
  );
  assert.equal(multipleReferences.render(120)[0]?.trimEnd(), "codex_image_gen ×3 · 2 refs · 1m 01s");
});

test("renders elapsed time in muted color without bold styling", () => {
  const foregrounds: string[] = [];
  const boldCalls: string[] = [];
  const styledTheme = {
    fg(color: string, value: string) {
      foregrounds.push(color);
      return value;
    },
    bold(value: string) {
      boldCalls.push(value);
      return value;
    },
  } as unknown as Theme;
  const line = renderCodexImageCall({}, styledTheme, context, 2_345).render(120)[0]?.trimEnd();
  assert.equal(line, "codex_image_gen ×1 · 2.3s");
  assert.deepEqual(foregrounds, ["toolTitle", "muted"]);
  assert.deepEqual(boldCalls, ["codex_image_gen ×1"]);
});

test("truncated prompt lines carry no full SGR reset that would cancel the tool row background", () => {
  const prompt =
    "Create ONE standalone Chinese chat sticker / meme image featuring a cute Shiba Inu. Transparent background, die-cut white sticker outline, bold clean cartoon illustration, expressive face and pose, centered composition.";
  const call = renderCodexImageCall({ prompt, count: 8 }, theme, context);
  const lines = call.render(72);
  assert.ok(lines.some((line) => line.includes("…")));
  assert.equal(lines.join("\n").includes("\x1b[0m"), false);
});

test("collapsed result renders nothing when complete", () => {
  const lines = renderResult(batchDetails(), false);
  assert.deepEqual(lines, []);
  assert.equal(lines.join("\n").includes("generated-images"), false);
  assert.equal(lines.join("\n").includes("1230x1278"), false);
  assert.equal(lines.join("\n").includes("[Image:"), false);
});

test("expanded result shows refs, model, and actual image sizes without a time field", () => {
  const details = batchDetails({ referenceImages: ["refs/hero.png", "refs/side.png"] });
  assert.equal(renderResult(details, false).length, 0);
  const lines = renderResult(details, true);
  assert.deepEqual(lines, [
    "",
    "refs",
    " ├ refs/hero.png",
    " └ refs/side.png",
    "model   gpt-image-2.5-flare · high",
    ...expectedTree(details),
  ]);
  assert.equal(lines.some((line) => line.startsWith("size")), false);
  assert.equal(lines.some((line) => line.startsWith("time")), false);
});

test("does not show requested size, but keeps actual dimensions", () => {
  const details = batchDetails({
    requestedCount: 1,
    generatedCount: 1,
    paths: ["generated-images/landscape.png"],
    dimensions: ["1536x1008"],
    size: "1536x1024",
    durationMs: 3_456,
  });
  const lines = renderResult(details, true);
  assert.equal(lines.some((line) => line.startsWith("size")), false);
  assert.equal(lines.some((line) => line.startsWith("time")), false);
  assert.ok(lines.includes(" └ generated-images/landscape.png  [1536x1008]"));
});

test("expanded result omits the refs field when there are no references", () => {
  const details = batchDetails();
  assert.deepEqual(renderResult(details, true), [
    "",
    "model   gpt-image-2.5-flare · high",
    ...expectedTree(details),
  ]);
});

test("reports partial failures and lists the failed request when expanded", () => {
  const details = batchDetails({
    generatedCount: 5,
    dimensions: ["1230x1278", "1223x1286", "1247x1261", "1254x1254", "1261x1247"],
    failures: [{ index: 3, error: "429 rate limited" }],
  });
  assert.deepEqual(renderResult(details, false), ["⚠ 5/6 images"]);
  assert.deepEqual(renderResult(details, true), [
    "",
    "⚠ 5/6 images",
    "model   gpt-image-2.5-flare · high",
    ...expectedTree(details),
    "  failed  #3  429 rate limited",
  ]);
});

test("hyperlinks expanded output paths to their workspace files when supported", () => {
  const previous = getCapabilities();
  const cwd = resolve("test-workspace");
  const relativePath = "generated-images/one.png";
  const details = batchDetails({
    requestedCount: 1,
    generatedCount: 1,
    paths: [relativePath],
    dimensions: ["1024x1024"],
  });

  try {
    setCapabilities({ ...previous, hyperlinks: true });
    const linkedLine = renderCodexImageResult(
      { content: [{ type: "text", text: "ok" }], details } as unknown as AgentToolResult<CodexImageGenDetails>,
      { expanded: true, isPartial: false },
      theme,
      { ...context, expanded: true, cwd },
    )
      .render(200)
      .find((line) => line.includes(relativePath));
    const fileUrl = pathToFileURL(resolve(cwd, relativePath)).href;
    assert.ok(linkedLine?.includes(`\x1b]8;;${fileUrl}\x1b\\`));
    assert.ok(linkedLine?.includes(`${relativePath}\x1b]8;;\x1b\\`));

    setCapabilities({ ...previous, hyperlinks: false });
    const plainLine = renderCodexImageResult(
      { content: [{ type: "text", text: "ok" }], details } as unknown as AgentToolResult<CodexImageGenDetails>,
      { expanded: true, isPartial: false },
      theme,
      { ...context, expanded: true, cwd },
    )
      .render(200)
      .find((line) => line.includes(relativePath));
    assert.equal(plainLine?.includes("\x1b]8;"), false);
  } finally {
    setCapabilities(previous);
  }
});

test("renders a single image as one full-path tree line", () => {
  const details = batchDetails({
    requestedCount: 1,
    generatedCount: 1,
    paths: [`generated-images/image-2026-09-28T02-46-43-187Z-${BATCH_ID}.png`],
    dimensions: ["1024x1024"],
  });
  assert.deepEqual(renderResult(details, true), [
    "",
    "model   gpt-image-2.5-flare · high",
    ...expectedTree(details),
  ]);
});

test("renders full paths for images in different directories", () => {
  const details = batchDetails({
    requestedCount: 2,
    generatedCount: 2,
    paths: ["a/one.png", "b/two.png"],
    dimensions: ["10x10", "20x20"],
  });
  assert.deepEqual(renderResult(details, true), [
    "",
    "model   gpt-image-2.5-flare · high",
    ...expectedTree(details),
  ]);
});
