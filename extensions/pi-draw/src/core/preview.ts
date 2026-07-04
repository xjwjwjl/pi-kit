import type { ExcalidrawSkeletonElement } from "./json.js";

const DEFAULT_FRAME_STROKE = "#adb5bd";
const DEFAULT_FRAME_LABEL = "#64748b";

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFrameLikeElement(element: ExcalidrawSkeletonElement): boolean {
	return element.type === "frame" || element.type === "magicframe";
}

function uniqueId(base: string, usedIds: Set<string>): string {
	let id = base;
	let suffix = 2;
	while (usedIds.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(id);
	return id;
}

export function preparePreviewElements(elements: ExcalidrawSkeletonElement[]): ExcalidrawSkeletonElement[] {
	const usedIds = new Set(elements.map((element) => element.id).filter((id): id is string => typeof id === "string" && id.length > 0));
	const previewElements: ExcalidrawSkeletonElement[] = [];

	for (const element of elements) {
		if (!isFrameLikeElement(element)) {
			previewElements.push(element);
			continue;
		}

		const { children: _children, name, ...rest } = element;
		const previewFrame: ExcalidrawSkeletonElement = {
			...rest,
			type: "rectangle",
			strokeColor: typeof element.strokeColor === "string" ? element.strokeColor : DEFAULT_FRAME_STROKE,
			backgroundColor: "transparent",
			fillStyle: "solid",
			strokeWidth: finiteNumber(element.strokeWidth) ?? 1,
		};
		previewElements.push(previewFrame);

		if (typeof name !== "string" || !name.trim()) continue;
		const x = finiteNumber(element.x);
		const y = finiteNumber(element.y);
		if (x === undefined || y === undefined) continue;

		previewElements.push({
			type: "text",
			id: uniqueId(`${element.id || "frame"}__preview_label`, usedIds),
			x,
			y: y - 24,
			text: name.trim(),
			fontSize: 14,
			strokeColor: DEFAULT_FRAME_LABEL,
		});
	}

	return previewElements;
}

export function previewElementsSignature(elements: ExcalidrawSkeletonElement[]): string {
	return elements
		.map((element) => {
			const startId = element.start && typeof element.start === "object" ? (element.start as { id?: unknown }).id : undefined;
			const endId = element.end && typeof element.end === "object" ? (element.end as { id?: unknown }).id : undefined;
			const points = Array.isArray(element.points) ? JSON.stringify(element.points) : "";
			return [
				element.id,
				element.type,
				element.x,
				element.y,
				element.width,
				element.height,
				startId,
				endId,
				points,
				element.text,
				typeof element.label === "object" && element.label ? (element.label as { text?: unknown }).text : undefined,
				Array.isArray(element.children) ? element.children.join(",") : "",
			].join("|");
		})
		.join("\n");
}
