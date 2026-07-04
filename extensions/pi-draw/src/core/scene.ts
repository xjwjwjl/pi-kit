import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fitTextContainers } from "./layout.js";
import { lintSceneElements, type SceneLintResult } from "./lint.js";
import { optimizeArrowBindings } from "./optimize-arrows.js";
import { type ExcalidrawSkeletonElement, normalizeSceneElements, parseElementsInput } from "./json.js";

export type PiDrawSceneDocument = {
	type: "pi-draw.scene";
	version: 1;
	source: "pi-draw";
	kind?: "elements" | "mermaid";
	title?: string;
	elements: ExcalidrawSkeletonElement[];
	mermaid?: PiDrawMermaidSource;
	lint?: SceneLintResult;
	createdAt: string;
	updatedAt: string;
};

export type PiDrawMermaidSource = {
	definition: string;
	config?: Record<string, unknown>;
};

export type SaveSceneOptions = {
	cwd: string;
	elements: unknown;
	title?: string;
	file?: string;
	optimize?: boolean;
};

export type SaveMermaidSceneOptions = {
	cwd: string;
	definition: string;
	config?: Record<string, unknown>;
	title?: string;
	file?: string;
};

export type SavedScene = {
	path: string;
	relativePath: string;
	document: PiDrawSceneDocument;
	lint: SceneLintResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMermaidSource(value: unknown): PiDrawMermaidSource | undefined {
	if (!isRecord(value) || typeof value.definition !== "string" || value.definition.trim().length === 0) {
		return undefined;
	}

	return {
		definition: value.definition.trim(),
		config: isRecord(value.config) ? value.config : undefined,
	};
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function sanitizeFileName(value: string): string {
	const cleaned = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5._-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);

	return cleaned || "diagram";
}

export function resolveScenePath(cwd: string, file?: string, title?: string): string {
	const root = resolve(cwd);
	const fallbackName = `${sanitizeFileName(title || "diagram")}.pi-draw.json`;
	const relativeFile = file?.trim() || join(".pi", "draw", fallbackName);

	if (isAbsolute(relativeFile)) {
		throw new Error("Scene file must be a relative path inside the project.");
	}

	const resolved = resolve(root, relativeFile);
	if (!isInside(root, resolved)) {
		throw new Error("Scene file must stay inside the current project.");
	}

	return resolved;
}

export function saveScene(options: SaveSceneOptions): SavedScene {
	const now = new Date().toISOString();
	const elements = fitTextContainers(parseElementsInput(options.elements));
	const optimizedElements = options.optimize === false ? elements : optimizeArrowBindings(elements);
	const lint = lintSceneElements(optimizedElements);
	const path = resolveScenePath(options.cwd, options.file, options.title);
	const document: PiDrawSceneDocument = {
		type: "pi-draw.scene",
		version: 1,
		source: "pi-draw",
		kind: "elements",
		title: options.title,
		elements: optimizedElements,
		createdAt: now,
		updatedAt: now,
	};

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");

	return {
		path,
		relativePath: relative(options.cwd, path).split(sep).join("/"),
		document,
		lint,
	};
}

export function saveMermaidScene(options: SaveMermaidSceneOptions): SavedScene {
	const definition = options.definition.trim();
	if (!definition) {
		throw new Error("Mermaid definition must not be empty.");
	}

	const now = new Date().toISOString();
	const lint = lintSceneElements([]);
	const path = resolveScenePath(options.cwd, options.file, options.title || "mermaid-diagram");
	const document: PiDrawSceneDocument = {
		type: "pi-draw.scene",
		version: 1,
		source: "pi-draw",
		kind: "mermaid",
		title: options.title,
		elements: [],
		mermaid: {
			definition,
			config: options.config,
		},
		createdAt: now,
		updatedAt: now,
	};

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");

	return {
		path,
		relativePath: relative(options.cwd, path).split(sep).join("/"),
		document,
		lint,
	};
}

export type SceneListItem = {
	path: string;
	title: string;
	updatedAt?: string;
	elementCount: number;
	kind?: "elements" | "mermaid";
};

function walkJsonFiles(dir: string, root: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkJsonFiles(fullPath, root, out);
			continue;
		}
		if (entry.isFile() && /\.(?:pi-draw\.json|excalidraw|json)$/i.test(entry.name)) {
			out.push(relative(root, fullPath).split(sep).join("/"));
		}
	}
}

export function listSceneFiles(cwd: string): SceneListItem[] {
	const root = resolve(cwd);
	const sceneRoot = join(root, ".pi", "draw");
	try {
		if (!statSync(sceneRoot).isDirectory()) return [];
	} catch {
		return [];
	}

	const files: string[] = [];
	walkJsonFiles(sceneRoot, root, files);

	return files
		.map((file) => {
			try {
				const raw = readFileSync(resolve(root, file), "utf8");
				const data = JSON.parse(raw) as Partial<PiDrawSceneDocument>;
				const kind: SceneListItem["kind"] = data.kind === "mermaid" || normalizeMermaidSource(data.mermaid) ? "mermaid" : "elements";
				return {
					path: file,
					title: typeof data.title === "string" && data.title ? data.title : file,
					updatedAt: data.updatedAt,
					elementCount: Array.isArray(data.elements) ? data.elements.length : 0,
					kind,
				};
			} catch {
				return {
					path: file,
					title: file,
					elementCount: 0,
				};
			}
		})
		.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function readSceneFile(cwd: string, file: string): PiDrawSceneDocument {
	const root = resolve(cwd);
	const resolved = resolve(root, file);
	if (!isInside(root, resolved)) {
		throw new Error("Scene file must stay inside the current project.");
	}
	const raw = readFileSync(resolved, "utf8");
	const data = JSON.parse(raw) as Partial<PiDrawSceneDocument>;
	const mermaid = normalizeMermaidSource(data.mermaid);
	if (!Array.isArray(data.elements) && !mermaid) {
		throw new Error("Scene file does not contain an elements array.");
	}
	const elements = data.elements
		? optimizeArrowBindings(fitTextContainers(normalizeSceneElements(data.elements as ExcalidrawSkeletonElement[])))
		: [];
	return {
		type: "pi-draw.scene",
		version: 1,
		source: "pi-draw",
		kind: mermaid ? "mermaid" : "elements",
		title: data.title,
		elements,
		mermaid,
		lint: lintSceneElements(elements),
		createdAt: data.createdAt || new Date(0).toISOString(),
		updatedAt: data.updatedAt || data.createdAt || new Date(0).toISOString(),
	};
}
