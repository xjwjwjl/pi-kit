export type ExcalidrawSkeletonElement = Record<string, unknown> & {
	type?: string;
	id?: string;
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFrameLikeElement(element: ExcalidrawSkeletonElement): boolean {
	return element.type === "frame" || element.type === "magicframe";
}

function elementBounds(element: ExcalidrawSkeletonElement): { left: number; top: number; right: number; bottom: number } | undefined {
	const x = finiteNumber(element.x);
	const y = finiteNumber(element.y);
	const width = finiteNumber(element.width) ?? 0;
	const height = finiteNumber(element.height) ?? 0;

	if (x === undefined || y === undefined) return undefined;

	return {
		left: Math.min(x, x + width),
		top: Math.min(y, y + height),
		right: Math.max(x, x + width),
		bottom: Math.max(y, y + height),
	};
}

function isInsideFrame(child: ExcalidrawSkeletonElement, frame: ExcalidrawSkeletonElement): boolean {
	const frameBounds = elementBounds(frame);
	const childBounds = elementBounds(child);

	if (!frameBounds || !childBounds) return false;

	return (
		childBounds.left >= frameBounds.left &&
		childBounds.top >= frameBounds.top &&
		childBounds.right <= frameBounds.right &&
		childBounds.bottom <= frameBounds.bottom
	);
}

function pushUnique(target: string[], value: string): void {
	if (!target.includes(value)) target.push(value);
}

function getBoundId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function hasLinearGeometry(element: ExcalidrawSkeletonElement): boolean {
	return finiteNumber(element.x) !== undefined && finiteNumber(element.y) !== undefined && finiteNumber(element.width) !== undefined && finiteNumber(element.height) !== undefined;
}

function detachCrossFrameBindings(elements: ExcalidrawSkeletonElement[]): ExcalidrawSkeletonElement[] {
	const frameByElementId = new Map<string, string>();
	for (const element of elements) {
		if (!isFrameLikeElement(element) || typeof element.id !== "string") continue;
		for (const childId of stringArray(element.children)) {
			frameByElementId.set(childId, element.id);
		}
	}

	const crossFrameLinearIds = new Set<string>();
	for (const element of elements) {
		if ((element.type !== "arrow" && element.type !== "line") || typeof element.id !== "string") continue;
		const startId = getBoundId(element.start);
		const endId = getBoundId(element.end);
		if (!startId || !endId || !hasLinearGeometry(element)) continue;

		const startFrame = frameByElementId.get(startId);
		const endFrame = frameByElementId.get(endId);
		if (startFrame !== endFrame) crossFrameLinearIds.add(element.id);
	}

	return elements.map((element) => {
		if (isFrameLikeElement(element) && Array.isArray(element.children) && crossFrameLinearIds.size > 0) {
			const children = stringArray(element.children).filter((childId) => !crossFrameLinearIds.has(childId));
			return children.length === element.children.length ? element : { ...element, children };
		}

		if (element.type !== "arrow" && element.type !== "line") return element;
		const startId = getBoundId(element.start);
		const endId = getBoundId(element.end);
		if (!startId || !endId || !hasLinearGeometry(element)) return element;

		const startFrame = frameByElementId.get(startId);
		const endFrame = frameByElementId.get(endId);
		if (startFrame === endFrame) return element;

		const { start: _start, end: _end, ...rest } = element;
		return rest;
	});
}

export function normalizeSceneElements(elements: ExcalidrawSkeletonElement[]): ExcalidrawSkeletonElement[] {
	const frameIds = new Set(
		elements
			.filter((element) => isFrameLikeElement(element) && typeof element.id === "string" && element.id.length > 0)
			.map((element) => element.id as string),
	);
	const elementIds = new Set(elements.map((element) => element.id).filter((id): id is string => typeof id === "string" && id.length > 0));
	const framesWithExplicitChildren = new Set(
		elements
			.filter((element) => isFrameLikeElement(element) && typeof element.id === "string" && Array.isArray(element.children))
			.map((element) => element.id as string),
	);
	const inferredChildren = new Map<string, string[]>();

	if (frameIds.size > 0) {
		for (const element of elements) {
			if (!element.id || isFrameLikeElement(element)) continue;
			for (const groupId of stringArray(element.groupIds)) {
				if (framesWithExplicitChildren.has(groupId)) continue;
				if (frameIds.has(groupId)) {
					const children = inferredChildren.get(groupId) ?? [];
					pushUnique(children, element.id);
					inferredChildren.set(groupId, children);
				}
			}
		}

		for (const frame of elements) {
			if (
				!isFrameLikeElement(frame) ||
				!frame.id ||
				framesWithExplicitChildren.has(frame.id) ||
				(inferredChildren.get(frame.id)?.length ?? 0) > 0
			) {
				continue;
			}
			const children = inferredChildren.get(frame.id) ?? [];
			for (const element of elements) {
				if (!element.id || isFrameLikeElement(element)) continue;
				if (isInsideFrame(element, frame)) pushUnique(children, element.id);
			}
			if (children.length > 0) inferredChildren.set(frame.id, children);
		}
	}

	const normalizedElements = elements.map((element) => {
		if (isFrameLikeElement(element)) {
			const children = [...stringArray(element.children).filter((id) => elementIds.has(id))];
			for (const childId of inferredChildren.get(element.id ?? "") ?? []) {
				if (elementIds.has(childId)) pushUnique(children, childId);
			}
			return { ...element, children };
		}

		const groupIds = stringArray(element.groupIds).filter((id) => !frameIds.has(id));
		if (!Array.isArray(element.groupIds)) return element;
		if (groupIds.length === 0) {
			const { groupIds: _groupIds, ...rest } = element;
			return rest;
		}
		return { ...element, groupIds };
	});

	return detachCrossFrameBindings(normalizedElements);
}

export function stripCodeFences(text: string): string {
	let value = text.trim();
	value = value.replace(/^```(?:json|javascript|js)?\s*\n?/i, "");
	value = value.replace(/\n?```\s*$/i, "");
	return value.trim();
}

function trimTrailingComma(text: string): string {
	let index = text.length - 1;
	while (index >= 0 && /\s/.test(text[index])) index--;
	if (index >= 0 && text[index] === ",") {
		return text.slice(0, index) + text.slice(index + 1);
	}
	return text;
}

function findNextNonWhitespaceIndex(text: string, from: number): number {
	for (let index = from; index < text.length; index++) {
		if (!/\s/.test(text[index])) return index;
	}
	return -1;
}

function hasColonBeforeCommaOrBracket(text: string, from: number): boolean {
	let inString = false;
	let escape = false;

	for (let index = from; index < text.length; index++) {
		const char = text[index];
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
		if (char === ":") return true;
		if (char === "," || char === "]") return false;
	}

	return false;
}

function looksLikeMissingObjectAfterArray(text: string, from: number): boolean {
	let inString = false;
	let escape = false;

	for (let index = from; index < text.length; index++) {
		const char = text[index];
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

		if (/\s/.test(char)) continue;
		if (char === "]" || char === "{" || char === ",") return false;
		if (char === "\"") return hasColonBeforeCommaOrBracket(text, index + 1);
		if (/[_A-Za-z]/.test(char)) return true;
		return false;
	}

	return false;
}

export function repairJsonClosure(input: string): string {
	const source = stripCodeFences(input);
	let start = -1;
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "{" || source[index] === "[") {
			start = index;
			break;
		}
	}
	if (start === -1) return source;

	let inString = false;
	let escape = false;
	let insertedObjectAfterArrayStart = false;
	const stack: string[] = [];
	let output = "";

	for (let index = start; index < source.length; index++) {
		const char = source[index];
		output += char;

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
			stack.push("}");
			continue;
		}
		if (char === "[") {
			stack.push("]");
			if (!insertedObjectAfterArrayStart) {
				const nextIndex = findNextNonWhitespaceIndex(source, index + 1);
				if (nextIndex !== -1 && looksLikeMissingObjectAfterArray(source, nextIndex)) {
					output += "{";
					stack.push("}");
					insertedObjectAfterArrayStart = true;
				}
			}
			continue;
		}
		if (char === "}" || char === "]") {
			if (stack.length && stack[stack.length - 1] === char) stack.pop();
			if (stack.length === 0) break;
		}
	}

	if (inString) output += "\"";
	output = trimTrailingComma(output);
	while (stack.length) output += stack.pop();
	return output;
}

function fixUnescapedQuotes(input: string): string {
	let output = "";
	let inString = false;
	let escapeNext = false;

	for (let index = 0; index < input.length; index++) {
		const char = input[index];

		if (escapeNext) {
			output += char;
			escapeNext = false;
			continue;
		}

		if (char === "\\") {
			output += char;
			escapeNext = true;
			continue;
		}

		if (char === "\"") {
			if (!inString) {
				inString = true;
				output += char;
				continue;
			}

			const nextNonWhitespace = input.slice(index + 1).match(/^\s*(.)/);
			const nextChar = nextNonWhitespace?.[1] ?? "";
			if (nextChar === ":" || nextChar === "," || nextChar === "}" || nextChar === "]" || nextChar === "") {
				inString = false;
				output += char;
			} else {
				output += "\\\"";
			}
			continue;
		}

		output += char;
	}

	return output;
}

export function postProcessExcalidrawJson(input: string): string {
	let processed = repairJsonClosure(input);
	try {
		JSON.parse(processed);
		return processed;
	} catch {
		processed = fixUnescapedQuotes(processed);
		return repairJsonClosure(processed);
	}
}

export function parseElementsInput(input: unknown): ExcalidrawSkeletonElement[] {
	let value = input;

	if (typeof value === "string") {
		value = JSON.parse(postProcessExcalidrawJson(value));
	}

	if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { elements?: unknown }).elements)) {
		value = (value as { elements: unknown }).elements;
	}

	if (!Array.isArray(value)) {
		throw new Error("Expected elements to be a JSON array or a JSON string containing an array.");
	}

	for (const [index, element] of value.entries()) {
		if (!element || typeof element !== "object" || Array.isArray(element)) {
			throw new Error(`Element at index ${index} must be an object.`);
		}
		if (typeof (element as { type?: unknown }).type !== "string") {
			throw new Error(`Element at index ${index} is missing string property "type".`);
		}
	}

	return normalizeSceneElements(value as ExcalidrawSkeletonElement[]);
}
