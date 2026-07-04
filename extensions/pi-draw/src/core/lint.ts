import type { ExcalidrawSkeletonElement } from "./json.js";
import { LABEL_CONTAINER_TYPES, minimumLabelContainerSize, minimumStandaloneTextSize } from "./layout.js";

export type SceneLintSeverity = "error" | "warning" | "info";

export type SceneLintIssue = {
	code: string;
	severity: SceneLintSeverity;
	message: string;
	elementId?: string;
};

export type SceneLintResult = {
	issues: SceneLintIssue[];
	errorCount: number;
	warningCount: number;
	infoCount: number;
};

const SUPPORTED_TYPES = new Set(["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "frame", "magicframe", "image"]);
const SIZED_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "frame", "magicframe"]);
const LINEAR_TYPES = new Set(["arrow", "line"]);
const OVERLAP_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "text"]);
const MIN_OVERLAP_SIZE = 12;
const MIN_OVERLAP_RATIO = 0.18;

type Bounds = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
	area: number;
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elementId(element: ExcalidrawSkeletonElement, index: number): string {
	return typeof element.id === "string" && element.id.length > 0 ? element.id : `#${index}`;
}

function getBoundId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function getLabelText(element: ExcalidrawSkeletonElement): string | undefined {
	const label = element.label;
	if (!label || typeof label !== "object") return undefined;
	const text = (label as { text?: unknown }).text;
	return typeof text === "string" && text.trim().length > 0 ? text : undefined;
}

function getLabelFontSize(element: ExcalidrawSkeletonElement, fallback = 16): number {
	const label = element.label;
	if (!label || typeof label !== "object") return fallback;
	return finiteNumber((label as { fontSize?: unknown }).fontSize) ?? fallback;
}

function pushIssue(issues: SceneLintIssue[], issue: SceneLintIssue): void {
	issues.push(issue);
}

function elementBounds(element: ExcalidrawSkeletonElement): Bounds | undefined {
	const x = finiteNumber(element.x);
	const y = finiteNumber(element.y);
	const width = finiteNumber(element.width);
	const height = finiteNumber(element.height);
	if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;

	const left = Math.min(x, x + width);
	const top = Math.min(y, y + height);
	const right = Math.max(x, x + width);
	const bottom = Math.max(y, y + height);
	const normalizedWidth = right - left;
	const normalizedHeight = bottom - top;
	if (normalizedWidth <= 0 || normalizedHeight <= 0) return undefined;

	return {
		left,
		top,
		right,
		bottom,
		width: normalizedWidth,
		height: normalizedHeight,
		area: normalizedWidth * normalizedHeight,
	};
}

function overlaps(a: Bounds, b: Bounds): Bounds | undefined {
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.right, b.right);
	const bottom = Math.min(a.bottom, b.bottom);
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0) return undefined;
	return { left, top, right, bottom, width, height, area: width * height };
}

function containsBounds(outer: Bounds, inner: Bounds, margin = 1): boolean {
	return (
		inner.left >= outer.left - margin &&
		inner.top >= outer.top - margin &&
		inner.right <= outer.right + margin &&
		inner.bottom <= outer.bottom + margin
	);
}

function centerInside(outer: Bounds, inner: Bounds): boolean {
	const centerX = inner.left + inner.width / 2;
	const centerY = inner.top + inner.height / 2;
	return centerX >= outer.left && centerX <= outer.right && centerY >= outer.top && centerY <= outer.bottom;
}

function hasSharedGroupId(a: ExcalidrawSkeletonElement, b: ExcalidrawSkeletonElement): boolean {
	const aGroups = stringArray(a.groupIds);
	if (aGroups.length === 0) return false;
	const bGroups = new Set(stringArray(b.groupIds));
	return aGroups.some((groupId) => bGroups.has(groupId));
}

function isLargeVisualContainer(container: ExcalidrawSkeletonElement, containerBounds: Bounds, childBounds: Bounds): boolean {
	if (container.type !== "rectangle") return false;
	return containerBounds.area >= childBounds.area * 4 && centerInside(containerBounds, childBounds);
}

function shouldIgnoreOverlap(a: ExcalidrawSkeletonElement, aBounds: Bounds, b: ExcalidrawSkeletonElement, bBounds: Bounds): boolean {
	if (hasSharedGroupId(a, b)) return true;
	if (containsBounds(aBounds, bBounds) || containsBounds(bBounds, aBounds)) return true;
	if (isLargeVisualContainer(a, aBounds, bBounds) || isLargeVisualContainer(b, bBounds, aBounds)) return true;
	return false;
}

function lintIndependentOverlaps(elements: ExcalidrawSkeletonElement[], issues: SceneLintIssue[]): void {
	const candidates = elements
		.map((element, index) => ({ element, index, bounds: elementBounds(element) }))
		.filter((entry): entry is { element: ExcalidrawSkeletonElement; index: number; bounds: Bounds } => {
			return typeof entry.element.type === "string" && OVERLAP_TYPES.has(entry.element.type) && entry.bounds !== undefined;
		});

	for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
		const first = candidates[firstIndex];
		for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
			const second = candidates[secondIndex];
			if (shouldIgnoreOverlap(first.element, first.bounds, second.element, second.bounds)) continue;

			const overlap = overlaps(first.bounds, second.bounds);
			if (!overlap || overlap.width < MIN_OVERLAP_SIZE || overlap.height < MIN_OVERLAP_SIZE) continue;

			const ratio = overlap.area / Math.min(first.bounds.area, second.bounds.area);
			if (ratio < MIN_OVERLAP_RATIO) continue;

			pushIssue(issues, {
				code: "independent_overlap",
				severity: "warning",
				elementId: elementId(second.element, second.index),
				message: `Element overlaps with ${elementId(first.element, first.index)}; add spacing or resize the layout.`,
			});
		}
	}
}

export function lintSceneElements(elements: ExcalidrawSkeletonElement[]): SceneLintResult {
	const issues: SceneLintIssue[] = [];
	const idCounts = new Map<string, number>();
	const ids = new Set<string>();

	for (const [index, element] of elements.entries()) {
		if (typeof element.id === "string" && element.id.length > 0) {
			idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
			ids.add(element.id);
		} else {
			pushIssue(issues, {
				code: "missing_id",
				severity: "warning",
				elementId: `#${index}`,
				message: "Element is missing a stable id; future updates and bindings may be less predictable.",
			});
		}
	}

	for (const [id, count] of idCounts.entries()) {
		if (count > 1) {
			pushIssue(issues, {
				code: "duplicate_id",
				severity: "error",
				elementId: id,
				message: `Element id is used ${count} times; bindings and updates may target the wrong element.`,
			});
		}
	}

	for (const [index, element] of elements.entries()) {
		const id = elementId(element, index);
		const type = typeof element.type === "string" ? element.type : "";
		if (!SUPPORTED_TYPES.has(type)) {
			pushIssue(issues, {
				code: "unsupported_type",
				severity: "error",
				elementId: id,
				message: `Unsupported element type "${type || "<missing>"}".`,
			});
		}

		for (const prop of ["x", "y", "width", "height"] as const) {
			if (element[prop] !== undefined && finiteNumber(element[prop]) === undefined) {
				pushIssue(issues, {
					code: "invalid_geometry",
					severity: "error",
					elementId: id,
					message: `Geometry property "${prop}" must be a finite number.`,
				});
			}
		}

		const width = finiteNumber(element.width);
		const height = finiteNumber(element.height);
		if (SIZED_TYPES.has(type) && ((width !== undefined && width <= 0) || (height !== undefined && height <= 0))) {
			pushIssue(issues, {
				code: "non_positive_size",
				severity: "warning",
				elementId: id,
				message: "Container-like element has non-positive width or height.",
			});
		}

		if (LINEAR_TYPES.has(type)) {
			const startId = getBoundId(element.start);
			const endId = getBoundId(element.end);
			const hasGeometry = finiteNumber(element.x) !== undefined && finiteNumber(element.y) !== undefined;
			const hasSize = finiteNumber(element.width) !== undefined && finiteNumber(element.height) !== undefined;

			if ((startId && !ids.has(startId)) || (endId && !ids.has(endId))) {
				pushIssue(issues, {
					code: "unknown_binding",
					severity: "warning",
					elementId: id,
					message: "Linear element binds to an id that does not exist in the scene.",
				});
			}
			if ((startId && !endId) || (!startId && endId)) {
				pushIssue(issues, {
					code: "partial_binding",
					severity: "info",
					elementId: id,
					message: "Linear element has only one bound endpoint; this may be intentional but is less stable.",
				});
			}
			if (!hasGeometry || !hasSize) {
				pushIssue(issues, {
					code: "missing_linear_geometry",
					severity: "warning",
					elementId: id,
					message: "Linear element should have x/y/width/height after normalization.",
				});
			}
			if (
				hasSize &&
				Math.abs(finiteNumber(element.width) ?? 0) > 12 &&
				Math.abs(finiteNumber(element.height) ?? 0) > 12 &&
				!Array.isArray(element.points)
			) {
				pushIssue(issues, {
					code: "diagonal_linear",
					severity: "info",
					elementId: id,
					message: "Diagonal connector has no routed points; it may cross nearby elements.",
				});
			}
		}

		if (type === "frame" || type === "magicframe") {
			const children = stringArray(element.children);
			if (children.length === 0) {
				pushIssue(issues, {
					code: "empty_frame",
					severity: "warning",
					elementId: id,
					message: "Frame has no children; prefer a rectangle container for visual grouping.",
				});
			}
			const seenChildren = new Set<string>();
			for (const childId of children) {
				if (!ids.has(childId)) {
					pushIssue(issues, {
						code: "unknown_frame_child",
						severity: "warning",
						elementId: id,
						message: `Frame references missing child id "${childId}".`,
					});
				}
				if (seenChildren.has(childId)) {
					pushIssue(issues, {
						code: "duplicate_frame_child",
						severity: "info",
						elementId: id,
						message: `Frame lists child id "${childId}" more than once.`,
					});
				}
				seenChildren.add(childId);
			}
		}

		if (type === "text" && typeof element.text === "string") {
			const textWidth = finiteNumber(element.width);
			const textHeight = finiteNumber(element.height);
			const fontSize = finiteNumber(element.fontSize) ?? 16;
			const minimum = minimumStandaloneTextSize(element.text, fontSize);
			if (
				(textWidth !== undefined && Math.abs(textWidth) < minimum.width * 0.92) ||
				(textHeight !== undefined && Math.abs(textHeight) < minimum.height * 0.92)
			) {
				pushIssue(issues, {
					code: "text_may_overflow",
					severity: "info",
					elementId: id,
					message: "Text may overflow its declared width or height.",
				});
			}
		}

		const labelText = getLabelText(element);
		if (labelText && LABEL_CONTAINER_TYPES.has(type)) {
			const minimum = minimumLabelContainerSize(type, labelText, getLabelFontSize(element));
			const height = finiteNumber(element.height);
			if (
				(width !== undefined && Math.abs(width) < minimum.width * 0.92) ||
				(height !== undefined && Math.abs(height) < minimum.height * 0.92)
			) {
				pushIssue(issues, {
					code: "label_may_overflow",
					severity: "info",
					elementId: id,
					message: "Element label may overflow its container width or height.",
				});
			}
		}
	}

	lintIndependentOverlaps(elements, issues);

	return {
		issues,
		errorCount: issues.filter((issue) => issue.severity === "error").length,
		warningCount: issues.filter((issue) => issue.severity === "warning").length,
		infoCount: issues.filter((issue) => issue.severity === "info").length,
	};
}

export function formatSceneLintSummary(result: SceneLintResult, maxIssues = 5): string[] {
	if (result.issues.length === 0) return ["Lint: clean"];

	const summary = `Lint: ${result.errorCount} errors, ${result.warningCount} warnings, ${result.infoCount} info`;
	const issues = result.issues.slice(0, maxIssues).map((issue) => {
		const target = issue.elementId ? ` ${issue.elementId}` : "";
		return `- ${issue.severity.toUpperCase()} ${issue.code}${target}: ${issue.message}`;
	});
	if (result.issues.length > maxIssues) {
		issues.push(`- ... ${result.issues.length - maxIssues} more issue(s)`);
	}
	return [summary, ...issues];
}
