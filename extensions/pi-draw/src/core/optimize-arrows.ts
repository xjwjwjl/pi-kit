import type { ExcalidrawSkeletonElement } from "./json.js";

type Edge = "left" | "right" | "top" | "bottom";
type Point = { x: number; y: number };
type LocalPoint = [number, number];

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function numberValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function determineEdges(startElement: ExcalidrawSkeletonElement, endElement: ExcalidrawSkeletonElement): { startEdge: Edge; endEdge: Edge } {
	const startX = numberValue(startElement.x, 0);
	const startY = numberValue(startElement.y, 0);
	const startWidth = numberValue(startElement.width, 100);
	const startHeight = numberValue(startElement.height, 100);

	const endX = numberValue(endElement.x, 0);
	const endY = numberValue(endElement.y, 0);
	const endWidth = numberValue(endElement.width, 100);
	const endHeight = numberValue(endElement.height, 100);

	const startCenterX = startX + startWidth / 2;
	const startCenterY = startY + startHeight / 2;
	const endCenterX = endX + endWidth / 2;
	const endCenterY = endY + endHeight / 2;
	const dx = startCenterX - endCenterX;
	const dy = startCenterY - endCenterY;

	const leftToRightDistance = startX - (endX + endWidth);
	const rightToLeftDistance = -((startX + startWidth) - endX);
	const topToBottomDistance = startY - (endY + endHeight);
	const bottomToTopDistance = -((startY + startHeight) - endY);

	if (dx > 0 && dy > 0) {
		return leftToRightDistance > topToBottomDistance ? { startEdge: "left", endEdge: "right" } : { startEdge: "top", endEdge: "bottom" };
	}
	if (dx < 0 && dy > 0) {
		return rightToLeftDistance > topToBottomDistance ? { startEdge: "right", endEdge: "left" } : { startEdge: "top", endEdge: "bottom" };
	}
	if (dx > 0 && dy < 0) {
		return leftToRightDistance > bottomToTopDistance ? { startEdge: "left", endEdge: "right" } : { startEdge: "bottom", endEdge: "top" };
	}
	if (dx < 0 && dy < 0) {
		return rightToLeftDistance > bottomToTopDistance ? { startEdge: "right", endEdge: "left" } : { startEdge: "bottom", endEdge: "top" };
	}
	if (dx === 0 && dy > 0) return { startEdge: "top", endEdge: "bottom" };
	if (dx === 0 && dy < 0) return { startEdge: "bottom", endEdge: "top" };
	if (dx > 0 && dy === 0) return { startEdge: "left", endEdge: "right" };
	if (dx < 0 && dy === 0) return { startEdge: "right", endEdge: "left" };

	return { startEdge: "right", endEdge: "left" };
}

function getEdgeCenter(element: ExcalidrawSkeletonElement, edge: Edge): Point {
	const x = numberValue(element.x, 0);
	const y = numberValue(element.y, 0);
	const width = numberValue(element.width, 100);
	const height = numberValue(element.height, 100);

	if (edge === "left") return { x, y: y + height / 2 };
	if (edge === "right") return { x: x + width, y: y + height / 2 };
	if (edge === "top") return { x: x + width / 2, y };
	return { x: x + width / 2, y: y + height };
}

function getBoundId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isMeaningfulOffset(value: number): boolean {
	return Math.abs(value) >= 8;
}

function pointsEqual(a: Point, b: Point): boolean {
	return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function compactPoints(points: Point[]): Point[] {
	const compacted: Point[] = [];
	for (const point of points) {
		if (compacted.length === 0 || !pointsEqual(compacted[compacted.length - 1], point)) {
			compacted.push(point);
		}
	}
	return compacted;
}

function toLocalPoints(points: Point[]): LocalPoint[] {
	const [origin] = points;
	return points.map((point) => [point.x - origin.x, point.y - origin.y]);
}

function buildOrthogonalRoute(start: Point, end: Point, primaryEdge: Edge): Point[] | undefined {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (!isMeaningfulOffset(dx) || !isMeaningfulOffset(dy)) return undefined;

	if (primaryEdge === "left" || primaryEdge === "right") {
		const midX = start.x + dx / 2;
		return compactPoints([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]);
	}

	const midY = start.y + dy / 2;
	return compactPoints([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]);
}

function buildStandaloneRoute(element: ExcalidrawSkeletonElement): Point[] | undefined {
	const x = numberValue(element.x, Number.NaN);
	const y = numberValue(element.y, Number.NaN);
	const width = numberValue(element.width, Number.NaN);
	const height = numberValue(element.height, Number.NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
	if (!isMeaningfulOffset(width) || !isMeaningfulOffset(height)) return undefined;

	const start = { x, y };
	const end = { x: x + width, y: y + height };
	return compactPoints([start, { x, y: y + height }, end]);
}

function applyRoute(element: ExcalidrawSkeletonElement, route: Point[] | undefined): boolean {
	if (!route || route.length < 3) return false;
	element.points = toLocalPoints(route);
	if (element.type === "arrow") element.elbowed = true;
	return true;
}

function buildFrameMembership(elements: ExcalidrawSkeletonElement[]): Map<string, string> {
	const frameByElementId = new Map<string, string>();
	for (const element of elements) {
		if ((element.type !== "frame" && element.type !== "magicframe") || typeof element.id !== "string") continue;
		for (const childId of stringArray(element.children)) {
			frameByElementId.set(childId, element.id);
		}
	}
	return frameByElementId;
}

export function optimizeArrowBindings(elements: ExcalidrawSkeletonElement[]): ExcalidrawSkeletonElement[] {
	const byId = new Map<string, ExcalidrawSkeletonElement>();
	const frameByElementId = buildFrameMembership(elements);
	for (const element of elements) {
		if (typeof element.id === "string" && element.id.length > 0) {
			byId.set(element.id, element);
		}
	}

	const crossFrameLinearIds = new Set<string>();
	for (const element of elements) {
		if ((element.type !== "arrow" && element.type !== "line") || typeof element.id !== "string") continue;
		const startId = getBoundId(element.start);
		const endId = getBoundId(element.end);
		const startFrame = startId ? frameByElementId.get(startId) : undefined;
		const endFrame = endId ? frameByElementId.get(endId) : undefined;
		if (startId && endId && startFrame !== endFrame) {
			crossFrameLinearIds.add(element.id);
		}
	}

	return elements.map((element) => {
		if ((element.type === "frame" || element.type === "magicframe") && Array.isArray(element.children) && crossFrameLinearIds.size > 0) {
			const children = stringArray(element.children).filter((childId) => !crossFrameLinearIds.has(childId));
			return children.length === element.children.length ? element : { ...element, children };
		}

		if (element.type !== "arrow" && element.type !== "line") return element;

		const startId = getBoundId(element.start);
		const endId = getBoundId(element.end);
		const startElement = startId ? byId.get(startId) : undefined;
		const endElement = endId ? byId.get(endId) : undefined;
		const optimized: ExcalidrawSkeletonElement = { ...element };
		const startFrame = startId ? frameByElementId.get(startId) : undefined;
		const endFrame = endId ? frameByElementId.get(endId) : undefined;
		const crossesFrameBoundary = Boolean(startId && endId && startFrame !== endFrame);
		let changed = false;

		if (startElement && endElement) {
			const { startEdge, endEdge } = determineEdges(startElement, endElement);
			const start = getEdgeCenter(startElement, startEdge);
			const end = getEdgeCenter(endElement, endEdge);
			optimized.x = start.x;
			optimized.y = start.y;
			optimized.width = end.x - start.x;
			optimized.height = end.y - start.y;
			applyRoute(optimized, buildOrthogonalRoute(start, end, startEdge));
			changed = true;

			if (crossesFrameBoundary) {
				delete optimized.start;
				delete optimized.end;
			}
		} else if (!startId && !endId && applyRoute(optimized, buildStandaloneRoute(optimized))) {
			changed = true;
		}

		if ((optimized.type === "arrow" || optimized.type === "line") && optimized.width === 0) {
			optimized.width = 1;
			changed = true;
		}

		return changed ? optimized : element;
	});
}
