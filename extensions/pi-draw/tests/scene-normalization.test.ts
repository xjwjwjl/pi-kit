import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSceneElements, type ExcalidrawSkeletonElement } from "../src/core/json.js";
import { fitTextContainers } from "../src/core/layout.js";
import { lintSceneElements } from "../src/core/lint.js";
import { optimizeArrowBindings } from "../src/core/optimize-arrows.js";
import { preparePreviewElements, previewElementsSignature } from "../src/core/preview.js";
import { readSceneFile, saveMermaidScene, saveScene } from "../src/core/scene.js";

function byId(elements: ExcalidrawSkeletonElement[]): Map<string, ExcalidrawSkeletonElement> {
	return new Map(elements.filter((element) => typeof element.id === "string").map((element) => [element.id as string, element]));
}

test("keeps explicit frame children from being polluted by geometric inference", () => {
	const normalized = normalizeSceneElements([
		{ type: "frame", id: "main", x: 0, y: 0, width: 500, height: 220, children: ["step"] },
		{ type: "frame", id: "exception", x: 120, y: 280, width: 260, height: 120, children: ["retry"] },
		{ type: "rectangle", id: "step", x: 40, y: 80, width: 100, height: 60 },
		{ type: "rectangle", id: "retry", x: 180, y: 320, width: 100, height: 50 },
		{ type: "arrow", id: "retry-line", x: 230, y: 320, width: -120, height: -180 },
	]);
	const elements = byId(normalized);

	assert.deepEqual(elements.get("main")?.children, ["step"]);
	assert.deepEqual(elements.get("exception")?.children, ["retry"]);
});

test("detaches cross-frame bound connectors and removes them from frame children", () => {
	const normalized = normalizeSceneElements([
		{ type: "frame", id: "left-frame", x: 0, y: 0, width: 160, height: 160, children: ["left", "cross"] },
		{ type: "frame", id: "right-frame", x: 240, y: 0, width: 160, height: 160, children: ["right"] },
		{ type: "rectangle", id: "left", x: 30, y: 50, width: 80, height: 40 },
		{ type: "rectangle", id: "right", x: 270, y: 50, width: 80, height: 40 },
		{ type: "arrow", id: "cross", x: 110, y: 70, width: 160, height: 0, start: { id: "left" }, end: { id: "right" } },
	]);
	const elements = byId(normalized);
	const cross = elements.get("cross");

	assert.deepEqual(elements.get("left-frame")?.children, ["left"]);
	assert.equal(cross?.start, undefined);
	assert.equal(cross?.end, undefined);
});

test("legacy frame inference uses normalized bounds for negative-size connectors", () => {
	const normalized = normalizeSceneElements([
		{ type: "frame", id: "legacy-frame", x: 0, y: 0, width: 100, height: 100 },
		{ type: "rectangle", id: "inside", x: 10, y: 10, width: 30, height: 30 },
		{ type: "arrow", id: "loop-back", x: 80, y: 80, width: -120, height: -120 },
	]);
	const elements = byId(normalized);

	assert.deepEqual(elements.get("legacy-frame")?.children, ["inside"]);
});

test("preview rendering downgrades frames to plain rectangles", () => {
	const preview = preparePreviewElements([
		{ type: "frame", id: "lane", x: 20, y: 60, width: 300, height: 180, name: "主流程", children: ["step"] },
		{ type: "rectangle", id: "step", x: 60, y: 100, width: 120, height: 60 },
	]);
	const elements = byId(preview);
	const lane = elements.get("lane");
	const label = elements.get("lane__preview_label");

	assert.equal(preview.some((element) => element.type === "frame" || element.type === "magicframe"), false);
	assert.equal(lane?.type, "rectangle");
	assert.equal(lane?.children, undefined);
	assert.equal(lane?.backgroundColor, "transparent");
	assert.equal(label?.type, "text");
	assert.equal(label?.text, "主流程");
});

test("routes diagonal bound arrows as orthogonal polylines", () => {
	const optimized = optimizeArrowBindings([
		{ type: "rectangle", id: "start", x: 0, y: 0, width: 100, height: 60 },
		{ type: "rectangle", id: "end", x: 260, y: 160, width: 120, height: 60 },
		{ type: "arrow", id: "flow", start: { id: "start" }, end: { id: "end" } },
	]);
	const flow = byId(optimized).get("flow");

	assert.equal(flow?.x, 100);
	assert.equal(flow?.y, 30);
	assert.equal(flow?.width, 160);
	assert.equal(flow?.height, 160);
	assert.deepEqual(flow?.points, [
		[0, 0],
		[80, 0],
		[80, 160],
		[160, 160],
	]);
	assert.equal(flow?.elbowed, true);
});

test("routes standalone return arrows as vertical-first polylines", () => {
	const optimized = optimizeArrowBindings([{ type: "arrow", id: "retry", x: 480, y: 515, width: -160, height: -235 }]);
	const retry = byId(optimized).get("retry");

	assert.deepEqual(retry?.points, [
		[0, 0],
		[0, -235],
		[-160, -235],
	]);
	assert.equal(retry?.elbowed, true);
});

test("preview signatures are stable for unchanged elements and change on growth", () => {
	const first = previewElementsSignature([{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 }]);
	const same = previewElementsSignature([{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 }]);
	const grown = previewElementsSignature([
		{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 },
		{ type: "arrow", id: "b", x: 10, y: 5, width: 30, height: 0 },
	]);

	assert.equal(first, same);
	assert.notEqual(first, grown);
});

test("expands narrow rectangle labels without mutating the source element", () => {
	const source: ExcalidrawSkeletonElement[] = [
		{ type: "rectangle", id: "box", x: 100, y: 80, width: 42, height: 24, label: { text: "这是一个非常长的节点标签", fontSize: 16 } },
	];
	const fitted = fitTextContainers(source);
	const box = fitted[0];

	assert.equal(source[0].width, 42);
	assert.equal(source[0].height, 24);
	assert.equal((box.width as number) > 42, true);
	assert.equal((box.height as number) > 24, true);
	assert.equal((box.x as number) < 100, true);
	assert.equal((box.y as number) < 80, true);
});

test("expands standalone text dimensions", () => {
	const [text] = fitTextContainers([{ type: "text", id: "note", x: 0, y: 0, width: 20, height: 10, text: "Standalone text block", fontSize: 18 }]);

	assert.equal((text.width as number) > 20, true);
	assert.equal((text.height as number) > 10, true);
	assert.equal(text.x, 0);
	assert.equal(text.y, 0);
});

test("gives diamond labels extra room for their shape", () => {
	const label = { text: "需要更宽的判断条件", fontSize: 16 };
	const [rect] = fitTextContainers([{ type: "rectangle", id: "rect", x: 0, y: 0, width: 20, height: 20, label }]);
	const [diamond] = fitTextContainers([{ type: "diamond", id: "diamond", x: 0, y: 0, width: 20, height: 20, label }]);

	assert.equal((diamond.width as number) > (rect.width as number), true);
	assert.equal((diamond.height as number) > (rect.height as number), true);
});

test("scene lint reports structural problems", () => {
	const result = lintSceneElements([
		{ type: "rectangle", id: "dup", x: 0, y: 0, width: 100, height: 60 },
		{ type: "ellipse", id: "dup", x: 160, y: 0, width: 100, height: 60 },
		{ type: "frame", id: "lane", x: 0, y: 0, width: 300, height: 160, children: ["dup", "missing", "dup"] },
		{ type: "arrow", id: "a", x: 0, y: 0, width: 100, height: 20, start: { id: "missing" }, end: { id: "dup" } },
		{ type: "rectangle", id: "label-box", x: 0, y: 220, width: 40, height: 40, label: { text: "这是一个非常长的标签", fontSize: 16 } },
	]);
	const codes = new Set(result.issues.map((issue) => issue.code));

	assert.equal(result.errorCount, 1);
	assert.equal(result.warningCount >= 1, true);
	assert.equal(codes.has("duplicate_id"), true);
	assert.equal(codes.has("unknown_frame_child"), true);
	assert.equal(codes.has("duplicate_frame_child"), true);
	assert.equal(codes.has("unknown_binding"), true);
	assert.equal(codes.has("label_may_overflow"), true);
});

test("scene lint reports independent visual overlap", () => {
	const result = lintSceneElements([
		{ type: "rectangle", id: "a", x: 0, y: 0, width: 120, height: 80 },
		{ type: "rectangle", id: "b", x: 60, y: 30, width: 120, height: 80 },
	]);

	assert.equal(result.warningCount >= 1, true);
	assert.equal(result.issues.some((issue) => issue.code === "independent_overlap" && issue.elementId === "b"), true);
});

test("scene lint ignores intentional text inside a visual container", () => {
	const result = lintSceneElements([
		{ type: "rectangle", id: "container", x: 0, y: 0, width: 420, height: 240, backgroundColor: "#f8fafc" },
		{ type: "text", id: "title", x: 24, y: 24, width: 160, height: 28, text: "Container title", fontSize: 18 },
	]);

	assert.equal(result.issues.some((issue) => issue.code === "independent_overlap"), false);
});

test("saveScene returns lint diagnostics", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-draw-lint-"));
	try {
		const saved = saveScene({
			cwd,
			title: "Lint Example",
			elements: [
				{ type: "rectangle", id: "same", x: 0, y: 0, width: 100, height: 60 },
				{ type: "rectangle", id: "same", x: 160, y: 0, width: 100, height: 60 },
			],
		});

		assert.equal(saved.lint.errorCount, 1);
		assert.equal(saved.lint.issues.some((issue) => issue.code === "duplicate_id"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveScene fits labels before storing and linting", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-draw-fit-"));
	try {
		const saved = saveScene({
			cwd,
			title: "Fit Example",
			elements: [{ type: "rectangle", id: "box", x: 0, y: 0, width: 30, height: 20, label: { text: "非常长的保存节点标签", fontSize: 16 } }],
		});
		const box = byId(saved.document.elements).get("box");

		assert.equal((box?.width as number) > 30, true);
		assert.equal(saved.lint.issues.some((issue) => issue.code === "label_may_overflow"), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveMermaidScene stores Mermaid source for native Mermaid preview", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-draw-mermaid-"));
	try {
		const saved = saveMermaidScene({
			cwd,
			title: "Mermaid Example",
			definition: "flowchart TD\n  A[Start] --> B[Done]",
		});
		const readBack = readSceneFile(cwd, saved.relativePath);

		assert.equal(saved.document.kind, "mermaid");
		assert.equal(readBack.kind, "mermaid");
		assert.equal(readBack.elements.length, 0);
		assert.equal(readBack.mermaid?.definition, "flowchart TD\n  A[Start] --> B[Done]");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
