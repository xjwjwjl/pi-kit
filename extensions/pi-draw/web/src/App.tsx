import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { extractLivePreviewElements } from "./live-preview.js";
import MermaidPreview, { type PiDrawMermaidScene } from "./MermaidPreview.js";
import { normalizeSceneElements, type ExcalidrawSkeletonElement } from "../../src/core/json.js";
import { preparePreviewElements, previewElementsSignature } from "../../src/core/preview.js";

const LIVE_PREVIEW_FLUSH_MS = 140;
const LIVE_PREVIEW_FIT_MIN_ELEMENTS = 6;

type SceneListItem = {
	path: string;
	title: string;
	updatedAt?: string;
	elementCount: number;
	kind?: "elements" | "mermaid";
};

type PiDrawScene = {
	kind?: "elements" | "mermaid";
	title?: string;
	elements: Record<string, unknown>[];
	mermaid?: PiDrawMermaidScene;
	updatedAt?: string;
};

type ApiSceneResponse = {
	path: string;
	scene: PiDrawScene;
	error?: string;
};

type PreviewEvent =
	| { type: "ready"; streaming: boolean }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "draw_generation_start" }
	| { type: "draw_generation_delta"; delta: string }
	| { type: "draw_generation_end" }
	| { type: "tool_start"; toolCallId?: string; toolName: string }
	| { type: "tool_end"; toolCallId?: string; toolName: string; isError?: boolean }
	| { type: "scene_saved"; path: string; title?: string; elementCount: number; updatedAt?: string; kind?: "elements" | "mermaid" }
	| { type: "error"; message: string };

function currentQueryFile(): string | null {
	const params = new URLSearchParams(window.location.search);
	return params.get("file");
}

function pluralizeScene(count: number): string {
	return `${count} scene${count === 1 ? "" : "s"}`;
}

function includesFrame(elements: Record<string, unknown>[]): boolean {
	return elements.some((element) => element.type === "frame");
}

export default function App() {
	const [scenes, setScenes] = useState<SceneListItem[]>([]);
	const [activePath, setActivePath] = useState<string | null>(currentQueryFile());
	const [scene, setScene] = useState<PiDrawScene | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const [livePreviewElements, setLivePreviewElements] = useState<Record<string, unknown>[] | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [connectionStatus, setConnectionStatus] = useState("Connecting");
	const [activityStatus, setActivityStatus] = useState("Waiting for Pi");
	const activePathRef = useRef(activePath);
	const livePreviewBufferRef = useRef("");
	const livePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastAutoFitKeyRef = useRef<string | null>(null);
	const livePreviewFitDoneRef = useRef(false);
	const lastLivePreviewSignatureRef = useRef("");
	const lastLivePreviewCountRef = useRef(0);
	const lastRenderedSignatureRef = useRef("");

	useEffect(() => {
		activePathRef.current = activePath;
	}, [activePath]);

	const loadScenes = useCallback(async () => {
		const response = await fetch("/api/scenes");
		const data = await response.json();
		setScenes(data.scenes || []);
		if (!activePathRef.current && data.scenes?.[0]?.path) {
			setActivePath(data.scenes[0].path);
		}
	}, []);

	const loadScene = useCallback(async (path: string | null) => {
		const suffix = path ? `?file=${encodeURIComponent(path)}` : "";
		const response = await fetch(`/api/scene${suffix}`);
		const data = (await response.json()) as ApiSceneResponse;
		if (!response.ok) {
			setError(data.error || "Failed to load scene.");
			setScene(null);
			return;
		}
		setError(null);
		setActivePath(data.path);
		setScene(data.scene);
		const url = new URL(window.location.href);
		url.searchParams.set("file", data.path);
		window.history.replaceState(null, "", url);
	}, []);

	useEffect(() => {
		void loadScenes();
	}, [loadScenes]);

	useEffect(() => {
		if (activePath || scenes.length > 0) {
			void loadScene(activePath || scenes[0].path);
		}
	}, [activePath, loadScene, scenes]);

	const mermaidScene = scene?.kind === "mermaid" && scene.mermaid && livePreviewElements === null ? scene.mermaid : null;
	const isMermaidScene = mermaidScene !== null;
	const displayedElements = livePreviewElements ?? (isMermaidScene ? [] : scene?.elements ?? []);
	const normalizedDisplayedElements = useMemo(
		() => normalizeSceneElements(displayedElements as ExcalidrawSkeletonElement[]) as Record<string, unknown>[],
		[displayedElements],
	);
	const previewElements = useMemo(
		() => preparePreviewElements(normalizedDisplayedElements as ExcalidrawSkeletonElement[]) as Record<string, unknown>[],
		[normalizedDisplayedElements],
	);
	const previewSignature = useMemo(() => previewElementsSignature(previewElements as ExcalidrawSkeletonElement[]), [previewElements]);
	const convertedElements = useMemo(() => {
		if (previewElements.length === 0) return [];
		try {
			return convertToExcalidrawElements(previewElements as any, { regenerateIds: false });
		} catch (conversionError) {
			console.warn("Failed to convert pi-draw scene elements.", conversionError);
			return [];
		}
	}, [previewElements]);

	useEffect(() => {
		if (isMermaidScene) setApi(null);
	}, [isMermaidScene]);

	useEffect(() => {
		if (isMermaidScene) return;
		if (!api) return;
		if (lastRenderedSignatureRef.current === previewSignature) return;
		const isLivePreview = livePreviewElements !== null;
		const autoFitKey = isLivePreview ? "live-preview" : scene?.kind === "mermaid" ? `mermaid:${activePath || "scene"}` : activePath || "scene";
		lastRenderedSignatureRef.current = previewSignature;
		api.updateScene({
			elements: convertedElements,
			appState: {
				viewBackgroundColor: "#ffffff",
			},
		});
		if (convertedElements.length === 0) return;

		const shouldFitLivePreview =
			isLivePreview &&
			!livePreviewFitDoneRef.current &&
			(livePreviewElements.length >= LIVE_PREVIEW_FIT_MIN_ELEMENTS || includesFrame(normalizedDisplayedElements));
		const shouldFitSavedScene = !isLivePreview && lastAutoFitKeyRef.current !== autoFitKey;
		if (!shouldFitLivePreview && !shouldFitSavedScene) return;

		lastAutoFitKeyRef.current = autoFitKey;
		if (isLivePreview) livePreviewFitDoneRef.current = true;
		setTimeout(() => {
			api.scrollToContent(convertedElements, {
				fitToContent: true,
				animate: !isLivePreview,
				duration: isLivePreview ? 0 : 250,
			});
		}, 80);
	}, [activePath, api, convertedElements, isMermaidScene, livePreviewElements, normalizedDisplayedElements, previewSignature, scene?.kind]);

	const flushLivePreview = useCallback((force = false) => {
		livePreviewTimerRef.current = null;
		const elements = extractLivePreviewElements(livePreviewBufferRef.current);
		if (elements) {
			const signature = previewElementsSignature(elements);
			if (!force && lastLivePreviewCountRef.current > 0 && elements.length < lastLivePreviewCountRef.current) {
				return;
			}
			if (signature === lastLivePreviewSignatureRef.current) {
				return;
			}
			lastLivePreviewSignatureRef.current = signature;
			lastLivePreviewCountRef.current = elements.length;
			setLivePreviewElements(elements);
		}
	}, []);

	const scheduleLivePreview = useCallback(
		(immediate = false) => {
			if (immediate) {
				if (livePreviewTimerRef.current) {
					clearTimeout(livePreviewTimerRef.current);
					livePreviewTimerRef.current = null;
				}
				flushLivePreview(true);
				return;
			}
			if (livePreviewTimerRef.current) return;
			livePreviewTimerRef.current = setTimeout(flushLivePreview, LIVE_PREVIEW_FLUSH_MS);
		},
		[flushLivePreview],
	);

	const resetLivePreview = useCallback(() => {
		livePreviewBufferRef.current = "";
		lastAutoFitKeyRef.current = null;
		livePreviewFitDoneRef.current = false;
		lastLivePreviewSignatureRef.current = "";
		lastLivePreviewCountRef.current = 0;
		lastRenderedSignatureRef.current = "";
		if (livePreviewTimerRef.current) {
			clearTimeout(livePreviewTimerRef.current);
			livePreviewTimerRef.current = null;
		}
		setLivePreviewElements(null);
	}, []);

	useEffect(() => {
		return () => {
			if (livePreviewTimerRef.current) clearTimeout(livePreviewTimerRef.current);
		};
	}, []);

	useEffect(() => {
		const source = new EventSource("/api/events");
		setConnectionStatus("Connecting");

		source.onopen = () => setConnectionStatus("Connected");
		source.onerror = () => setConnectionStatus("Reconnecting");
		source.onmessage = (message) => {
			let event: PreviewEvent;
			try {
				event = JSON.parse(message.data) as PreviewEvent;
			} catch {
				return;
			}

			if (event.type === "ready") {
				setStreaming(event.streaming);
				setConnectionStatus("Connected");
				return;
			}
			if (event.type === "agent_start") {
				setStreaming(true);
				setActivityStatus("Pi is active");
				return;
			}
			if (event.type === "draw_generation_start") {
				resetLivePreview();
				setActivityStatus("Receiving scene");
				return;
			}
			if (event.type === "draw_generation_delta") {
				livePreviewBufferRef.current += event.delta;
				scheduleLivePreview();
				return;
			}
			if (event.type === "draw_generation_end") {
				scheduleLivePreview(true);
				setActivityStatus("Scene generated");
				return;
			}
			if (event.type === "tool_start") {
				if (event.toolName === "pi_draw_save_scene" || event.toolName === "pi_draw_save_mermaid_scene") {
					setActivityStatus("Saving scene");
				}
				return;
			}
			if (event.type === "tool_end") {
				if ((event.toolName === "pi_draw_save_scene" || event.toolName === "pi_draw_save_mermaid_scene") && event.isError) {
					resetLivePreview();
					setActivityStatus("Save failed");
					setError("Scene save failed.");
				}
				return;
			}
			if (event.type === "scene_saved") {
				resetLivePreview();
				setError(null);
				setActivityStatus(event.kind === "mermaid" ? "Saved Mermaid scene" : `Saved ${event.elementCount} elements`);
				void loadScenes();
				void loadScene(event.path);
				return;
			}
			if (event.type === "agent_end") {
				setStreaming(false);
				setActivityStatus("Waiting for Pi");
				return;
			}
			if (event.type === "error") {
				setError(event.message);
			}
		};

		return () => source.close();
	}, [loadScene, loadScenes, resetLivePreview, scheduleLivePreview]);

	const title = livePreviewElements ? "Live preview" : scene?.title || activePath || "pi-draw";
	const subtitle = livePreviewElements
		? `${livePreviewElements.length} streamed elements`
		: scene?.kind === "mermaid"
			? `Mermaid scene · ${activePath || ""}`
			: activePath || (scenes.length > 0 ? pluralizeScene(scenes.length) : "No scene selected");

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="topbar-title">
					<strong>{title}</strong>
					<span>{subtitle}</span>
				</div>
				<div className="topbar-actions">
					<span className="status-pill">{connectionStatus}</span>
					<span className={streaming ? "status-pill active" : "status-pill"}>{activityStatus}</span>
					<span className="status-pill muted">{pluralizeScene(scenes.length)}</span>
					<button type="button" onClick={() => void loadScene(activePath)}>
						Reload
					</button>
				</div>
			</header>

			<main className="canvas-panel">
				{error ? (
					<div className="error">{error}</div>
				) : mermaidScene ? (
					<MermaidPreview scene={mermaidScene as PiDrawMermaidScene} title={scene?.title} onStatus={setActivityStatus} onError={setError} />
				) : (
					<div className="canvas">
						<Excalidraw
							excalidrawAPI={(nextApi: ExcalidrawImperativeAPI) => setApi(nextApi)}
							initialData={{
								elements: convertedElements,
								appState: {
									viewBackgroundColor: "#ffffff",
									currentItemFontFamily: 1,
								},
							}}
						/>
					</div>
				)}
			</main>
		</div>
	);
}
