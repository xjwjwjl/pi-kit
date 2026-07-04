import type { ExcalidrawSkeletonElement } from "./json.js";

export const LABEL_CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

type TextSize = {
	width: number;
	height: number;
	lineCount: number;
};

type MinimumSize = {
	width: number;
	height: number;
};

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function charWidthUnits(char: string): number {
	if (/\s/.test(char)) return 0.33;
	if (char.charCodeAt(0) > 255) return 1;
	if (/[il.,:;|!]/.test(char)) return 0.32;
	if (/[mwMW@#%&]/.test(char)) return 0.82;
	if (/[A-Z0-9]/.test(char)) return 0.62;
	return 0.56;
}

export function estimateTextSize(text: string, fontSize = 16): TextSize {
	const lines = text.split(/\r?\n/);
	const lineCount = Math.max(lines.length, 1);
	let maxUnits = 0;

	for (const line of lines) {
		let units = 0;
		for (const char of line) units += charWidthUnits(char);
		maxUnits = Math.max(maxUnits, units);
	}

	return {
		width: Math.ceil(maxUnits * fontSize),
		height: Math.ceil(lineCount * fontSize * 1.25),
		lineCount,
	};
}

export function minimumStandaloneTextSize(text: string, fontSize = 16): MinimumSize {
	const measured = estimateTextSize(text, fontSize);
	return {
		width: Math.max(1, measured.width),
		height: Math.max(Math.ceil(fontSize * 1.25), measured.height),
	};
}

export function minimumLabelContainerSize(type: string | undefined, text: string, fontSize = 16): MinimumSize {
	const measured = estimateTextSize(text, fontSize);
	let width = measured.width + 32;
	let height = measured.height + 22;

	if (type === "ellipse") {
		width *= 1.18;
		height *= 1.12;
	}

	if (type === "diamond") {
		width *= 1.45;
		height *= 1.24;
	}

	return {
		width: Math.ceil(Math.max(type === "diamond" ? 104 : 72, width)),
		height: Math.ceil(Math.max(type === "diamond" ? 64 : 44, height)),
	};
}

function expandElementSize(
	element: ExcalidrawSkeletonElement,
	minimum: MinimumSize,
	options: { preserveCenter: boolean },
): ExcalidrawSkeletonElement {
	const currentWidth = finiteNumber(element.width);
	const currentHeight = finiteNumber(element.height);
	const currentWidthAbs = Math.abs(currentWidth ?? 0);
	const currentHeightAbs = Math.abs(currentHeight ?? 0);
	const nextWidthAbs = Math.max(currentWidthAbs, minimum.width);
	const nextHeightAbs = Math.max(currentHeightAbs, minimum.height);

	if (nextWidthAbs === currentWidthAbs && nextHeightAbs === currentHeightAbs) {
		return element;
	}

	const next: ExcalidrawSkeletonElement = { ...element };
	const widthSign = currentWidth !== undefined && currentWidth < 0 ? -1 : 1;
	const heightSign = currentHeight !== undefined && currentHeight < 0 ? -1 : 1;
	next.width = widthSign * nextWidthAbs;
	next.height = heightSign * nextHeightAbs;

	const x = finiteNumber(element.x);
	const y = finiteNumber(element.y);
	if (options.preserveCenter && x !== undefined && y !== undefined && currentWidth !== undefined && currentHeight !== undefined) {
		if (currentWidth >= 0) next.x = x - (nextWidthAbs - currentWidthAbs) / 2;
		if (currentHeight >= 0) next.y = y - (nextHeightAbs - currentHeightAbs) / 2;
	}

	return next;
}

export function fitTextContainers(elements: ExcalidrawSkeletonElement[]): ExcalidrawSkeletonElement[] {
	return elements.map((element) => {
		if (element.type === "text" && typeof element.text === "string") {
			const fontSize = finiteNumber(element.fontSize) ?? 16;
			return expandElementSize(element, minimumStandaloneTextSize(element.text, fontSize), { preserveCenter: false });
		}

		if (typeof element.type === "string" && LABEL_CONTAINER_TYPES.has(element.type)) {
			const labelText = getLabelText(element);
			if (!labelText) return element;
			return expandElementSize(element, minimumLabelContainerSize(element.type, labelText, getLabelFontSize(element)), {
				preserveCenter: true,
			});
		}

		return element;
	});
}
