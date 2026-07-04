import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MermaidConfig } from "mermaid";

export type PiDrawMermaidScene = {
	definition: string;
	config?: Record<string, unknown>;
};

type MermaidPreviewProps = {
	scene: PiDrawMermaidScene;
	title?: string;
	onStatus?: (status: string) => void;
	onError?: (message: string | null) => void;
};

type Direction = "TD" | "LR" | "BT" | "RL";
type ThemeName = "notion" | "neutral" | "forest";

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 6;
const MAX_FIT_ZOOM = 2.2;
const ZOOM_STEP = 0.08;
const FIT_PADDING_X = 72;
const FIT_PADDING_Y = 48;

const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
	{ value: "neutral", label: "Neutral" },
	{ value: "notion", label: "Notion 风格" },
	{ value: "forest", label: "Forest" },
];

const DIRECTION_OPTIONS: Array<{ value: Direction; label: string }> = [
	{ value: "TD", label: "从上到下" },
	{ value: "LR", label: "从左到右" },
	{ value: "BT", label: "从下到上" },
	{ value: "RL", label: "从右到左" },
];

function renderConfig(theme: ThemeName, baseConfig: Record<string, unknown> | undefined): MermaidConfig {
	const themeVariables =
		theme === "forest"
			? {
					primaryColor: "#e7f5ec",
					primaryBorderColor: "#2f9e44",
					primaryTextColor: "#1f2937",
					lineColor: "#94a3b8",
					fontFamily: "Inter, ui-sans-serif, system-ui",
					fontSize: "15px",
				}
			: theme === "neutral"
				? {
						primaryColor: "#f8fafc",
						primaryBorderColor: "#94a3b8",
						primaryTextColor: "#334155",
						lineColor: "#94a3b8",
						fontFamily: "Inter, ui-sans-serif, system-ui",
						fontSize: "15px",
					}
				: {
						primaryColor: "#ffffff",
						primaryBorderColor: "#d8e0ea",
						primaryTextColor: "#435166",
						lineColor: "#9caec8",
						fontFamily: "Inter, ui-sans-serif, system-ui",
						fontSize: "15px",
						tertiaryColor: "#1f2937",
					};

	return {
		startOnLoad: false,
		securityLevel: "strict",
		theme: "base",
		flowchart: {
			curve: "basis",
			htmlLabels: true,
		},
		...(baseConfig as MermaidConfig | undefined),
		themeVariables: {
			...((baseConfig?.themeVariables as Record<string, unknown> | undefined) ?? {}),
			...themeVariables,
		},
	};
}

function directionFromDefinition(definition: string): Direction {
	const match = definition.match(/^\s*(?:flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/im);
	if (!match) return "TD";
	return match[1] === "TB" ? "TD" : (match[1] as Direction);
}

function applyDirection(definition: string, direction: Direction): string {
	const replacement = direction === "TD" ? "TD" : direction;
	if (/^\s*flowchart\s+(TD|TB|BT|RL|LR)\b/im.test(definition)) {
		return definition.replace(/^(\s*flowchart\s+)(TD|TB|BT|RL|LR)\b/im, `$1${replacement}`);
	}
	if (/^\s*graph\s+(TD|TB|BT|RL|LR)\b/im.test(definition)) {
		return definition.replace(/^(\s*graph\s+)(TD|TB|BT|RL|LR)\b/im, `$1${replacement}`);
	}
	return definition;
}

function clampZoom(value: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function readSvgSize(svgElement: SVGSVGElement | null): { width: number; height: number } | null {
	if (!svgElement) return null;

	if (svgElement.clientWidth > 0 && svgElement.clientHeight > 0) {
		return { width: svgElement.clientWidth, height: svgElement.clientHeight };
	}

	const viewBox = svgElement.viewBox?.baseVal;
	if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
		return { width: viewBox.width, height: viewBox.height };
	}

	try {
		const box = svgElement.getBBox();
		if (box.width > 0 && box.height > 0) {
			return { width: box.width, height: box.height };
		}
	} catch {
		// Some SVGs may not expose a bbox until all children are ready.
	}

	const rect = svgElement.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
}

function downloadText(filename: string, text: string): void {
	const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

export default function MermaidPreview({ scene, title, onStatus, onError }: MermaidPreviewProps) {
	const [theme, setTheme] = useState<ThemeName>("neutral");
	const [direction, setDirection] = useState<Direction>(() => directionFromDefinition(scene.definition));
	const [svg, setSvg] = useState("");
	const [zoom, setZoom] = useState(1);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const stageRef = useRef<HTMLDivElement | null>(null);
	const diagramRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
	const userAdjustedRef = useRef(false);

	const fitToStage = useCallback(() => {
		const stageElement = stageRef.current;
		const svgElement = diagramRef.current?.querySelector("svg") as SVGSVGElement | null;
		const svgSize = readSvgSize(svgElement);
		if (!stageElement || !svgSize) return;

		const availableWidth = Math.max(160, stageElement.clientWidth - FIT_PADDING_X * 2);
		const availableHeight = Math.max(120, stageElement.clientHeight - FIT_PADDING_Y * 2);
		const fitZoom = Math.min(availableWidth / svgSize.width, availableHeight / svgSize.height, MAX_FIT_ZOOM);
		setZoom(clampZoom(Number(fitZoom.toFixed(2))));
		setOffset({ x: 0, y: 0 });
	}, []);

	useEffect(() => {
		userAdjustedRef.current = false;
		setDirection(directionFromDefinition(scene.definition));
		setOffset({ x: 0, y: 0 });
	}, [scene.definition]);

	const renderedDefinition = useMemo(() => applyDirection(scene.definition, direction), [direction, scene.definition]);

	useEffect(() => {
		let cancelled = false;

		onStatus?.("Rendering Mermaid");
		onError?.(null);
		void import("mermaid")
			.then(async ({ default: mermaid }) => {
				mermaid.initialize(renderConfig(theme, scene.config));
				const id = `pi-draw-mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				const result = await mermaid.render(id, renderedDefinition);
				if (cancelled) return;
				setSvg(result.svg);
				onStatus?.("Rendered Mermaid");
			})
			.catch((error) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : "Failed to render Mermaid diagram.";
				setSvg("");
				onStatus?.("Mermaid render failed");
				onError?.(message);
			});

		return () => {
			cancelled = true;
		};
	}, [onError, onStatus, renderedDefinition, scene.config, theme]);

	useLayoutEffect(() => {
		if (!svg || userAdjustedRef.current) return undefined;
		const frame = window.requestAnimationFrame(fitToStage);
		return () => window.cancelAnimationFrame(frame);
	}, [fitToStage, svg]);

	useEffect(() => {
		const stageElement = stageRef.current;
		if (!stageElement || typeof ResizeObserver === "undefined") return undefined;

		const observer = new ResizeObserver(() => {
			if (!userAdjustedRef.current) fitToStage();
		});
		observer.observe(stageElement);
		return () => observer.disconnect();
	}, [fitToStage]);

	const zoomBy = useCallback((delta: number) => {
		userAdjustedRef.current = true;
		setZoom((value) => clampZoom(Number((value + delta).toFixed(2))));
	}, []);

	useEffect(() => {
		const stageElement = stageRef.current;
		if (!stageElement) return undefined;

		const handleNativeWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			if (event.target instanceof Node && !stageElement.contains(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
		};

		window.addEventListener("wheel", handleNativeWheel, { capture: true, passive: false });
		return () => window.removeEventListener("wheel", handleNativeWheel, { capture: true });
	}, [zoomBy]);

	const resetView = useCallback(() => {
		userAdjustedRef.current = false;
		fitToStage();
	}, [fitToStage]);

	const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		userAdjustedRef.current = true;
		dragRef.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			offsetX: offset.x,
			offsetY: offset.y,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	}, [offset.x, offset.y]);

	const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		setOffset({
			x: drag.offsetX + event.clientX - drag.x,
			y: drag.offsetY + event.clientY - drag.y,
		});
	}, []);

	const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
	}, []);

	return (
		<div className="mermaid-shell">
			<div className="mermaid-toolbar">
				<select
					value={theme}
					onChange={(event) => {
						userAdjustedRef.current = false;
						setTheme(event.target.value as ThemeName);
					}}
					aria-label="Mermaid theme"
				>
					{THEME_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<span className="mermaid-toolbar-label">Dagre</span>
				<select
					value={direction}
					onChange={(event) => {
						userAdjustedRef.current = false;
						setDirection(event.target.value as Direction);
					}}
					aria-label="Mermaid direction"
				>
					{DIRECTION_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<button type="button" onClick={() => zoomBy(-ZOOM_STEP)} aria-label="Zoom out">
					-
				</button>
				<span className="mermaid-zoom">{Math.round(zoom * 100)}%</span>
				<button type="button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">
					+
				</button>
				<button type="button" onClick={resetView} aria-label="Reset view">
					Reset
				</button>
				<button type="button" onClick={() => svg && downloadText(`${title || "mermaid"}.svg`, svg)} disabled={!svg}>
					Download SVG
				</button>
			</div>
			<div
				ref={stageRef}
				className="mermaid-stage"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
			>
				<div
					ref={diagramRef}
					className="mermaid-diagram"
					style={{
						transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
					}}
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
				<div className="mermaid-hint">滚轮滚动 | Ctrl+滚轮缩放 | 拖拽平移</div>
			</div>
		</div>
	);
}
