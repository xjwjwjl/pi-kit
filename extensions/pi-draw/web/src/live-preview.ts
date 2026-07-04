import { normalizeSceneElements, postProcessExcalidrawJson, stripCodeFences, type ExcalidrawSkeletonElement } from "../../src/core/json.js";
import { fitTextContainers } from "../../src/core/layout.js";
import { optimizeArrowBindings } from "../../src/core/optimize-arrows.js";

const SUPPORTED_ELEMENT_TYPES = new Set(["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "frame"]);

function parseJsonLike(input: string): unknown {
	return JSON.parse(postProcessExcalidrawJson(input));
}

function parseJsonStrict(input: string): unknown {
	return JSON.parse(stripCodeFences(input));
}

function coerceElements(value: unknown): unknown {
	if (typeof value === "string") {
		return coerceElements(parseJsonLike(value));
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const elements = (value as { elements?: unknown }).elements;
		if (elements !== undefined) return coerceElements(elements);
	}
	return value;
}

function isPreviewElement(value: unknown): value is ExcalidrawSkeletonElement {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && SUPPORTED_ELEMENT_TYPES.has(type);
}

function nextNonWhitespaceIndex(text: string, from: number): number {
	for (let index = from; index < text.length; index++) {
		if (!/\s/.test(text[index])) return index;
	}
	return -1;
}

function readJsonString(text: string, start: number): { value: string; end: number } | null {
	if (text[start] !== "\"") return null;
	let value = "";
	let escape = false;

	for (let index = start + 1; index < text.length; index++) {
		const char = text[index];
		if (escape) {
			value += char;
			escape = false;
			continue;
		}
		if (char === "\\") {
			escape = true;
			continue;
		}
		if (char === "\"") {
			return { value, end: index };
		}
		value += char;
	}

	return null;
}

function findElementsArrayStart(input: string): { source: string; start: number } | null {
	const source = stripCodeFences(input);
	const firstJsonStart = source.search(/[\[{]/);
	if (firstJsonStart === -1) return null;
	if (source[firstJsonStart] === "[") return { source, start: firstJsonStart };

	let inString = false;
	let escape = false;
	for (let index = firstJsonStart; index < source.length; index++) {
		const char = source[index];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (char === "\\") {
				escape = true;
				continue;
			}
			if (char === "\"") inString = false;
			continue;
		}

		if (char !== "\"") continue;
		const key = readJsonString(source, index);
		if (!key) return null;
		index = key.end;
		if (key.value !== "elements") continue;

		const colonIndex = nextNonWhitespaceIndex(source, index + 1);
		if (colonIndex === -1 || source[colonIndex] !== ":") continue;
		const arrayIndex = nextNonWhitespaceIndex(source, colonIndex + 1);
		if (arrayIndex !== -1 && source[arrayIndex] === "[") {
			return { source, start: arrayIndex };
		}
	}

	return null;
}

function collectClosedObjectStrings(source: string, arrayStart: number): string[] {
	const objects: string[] = [];
	let inString = false;
	let escape = false;
	let objectStart = -1;
	let objectDepth = 0;

	for (let index = arrayStart + 1; index < source.length; index++) {
		const char = source[index];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (char === "\\") {
				escape = true;
				continue;
			}
			if (char === "\"") inString = false;
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (objectDepth === 0) objectStart = index;
			objectDepth++;
			continue;
		}
		if (char === "}") {
			if (objectDepth === 0) continue;
			objectDepth--;
			if (objectDepth === 0 && objectStart !== -1) {
				objects.push(source.slice(objectStart, index + 1));
				objectStart = -1;
			}
			continue;
		}
		if (char === "]" && objectDepth === 0) break;
	}

	return objects;
}

function extractClosedPreviewElements(input: string): ExcalidrawSkeletonElement[] | null {
	const array = findElementsArrayStart(input);
	if (!array) return null;

	const elements: ExcalidrawSkeletonElement[] = [];
	for (const objectText of collectClosedObjectStrings(array.source, array.start)) {
		try {
			const value = parseJsonStrict(objectText);
			if (isPreviewElement(value)) elements.push(value);
		} catch {
			// Ignore the current object until it is fully valid JSON.
		}
	}

	return elements.length > 0 ? optimizeArrowBindings(fitTextContainers(normalizeSceneElements(elements))) : null;
}

function extractCompletePreviewElements(input: string): ExcalidrawSkeletonElement[] | null {
	try {
		const value = coerceElements(parseJsonStrict(input));
		if (!Array.isArray(value)) return null;

		const elements = value.filter(isPreviewElement);
		if (elements.length === 0) return null;

		return optimizeArrowBindings(fitTextContainers(normalizeSceneElements(elements)));
	} catch {
		return null;
	}
}

function extractRepairedPreviewElements(input: string): ExcalidrawSkeletonElement[] | null {
	try {
		const value = coerceElements(parseJsonLike(input));
		if (!Array.isArray(value)) return null;

		const elements = value.filter(isPreviewElement);
		if (elements.length === 0) return null;

		return optimizeArrowBindings(fitTextContainers(normalizeSceneElements(elements)));
	} catch {
		return null;
	}
}

export function extractLivePreviewElements(toolArgumentsJson: string): ExcalidrawSkeletonElement[] | null {
	if (!toolArgumentsJson.trim()) return null;

	const completeElements = extractCompletePreviewElements(toolArgumentsJson);
	if (completeElements) return completeElements;

	const hasElementsArray = findElementsArrayStart(toolArgumentsJson) !== null;
	const closedElements = extractClosedPreviewElements(toolArgumentsJson);
	if (closedElements || hasElementsArray) return closedElements;

	return extractRepairedPreviewElements(toolArgumentsJson);
}
