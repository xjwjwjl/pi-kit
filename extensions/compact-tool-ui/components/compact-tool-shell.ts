import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolRenderShell } from "../settings/options.js";

type Slot = "call" | "result";
type Layout = { call: string[]; result: string[] };
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type ShellContext = Pick<RenderContext, "isPartial" | "isError" | "outputPad">;

class ShellPart implements Component {
	private readonly shell: CompactToolShell;
	private readonly slot: Slot;

	constructor(shell: CompactToolShell, slot: Slot) {
		this.shell = shell;
		this.slot = slot;
	}

	get component(): Component | undefined {
		return this.shell.getComponent(this.slot);
	}

	invalidate() {
		this.shell.invalidate();
	}

	render(width: number): string[] {
		return this.shell.renderParts(width)[this.slot];
	}
}

/** Unwrap only our framing; native and compact renderers keep their own lastComponent contract. */
export function unwrapToolShellComponent(component: Component | undefined): Component | undefined {
	return component instanceof ShellPart ? component.component : component;
}

/**
 * Keep Pi's mounted shell stable while sharing one optional Box across both renderer slots.
 * The two parts partition the same layout, so expanded details never get a second box/padding.
 */
export class CompactToolShell {
	readonly callPart = new ShellPart(this, "call");
	readonly resultPart = new ShellPart(this, "result");
	private call?: Component;
	private result?: Component;
	private theme?: Theme;
	private paddingX = 1;
	private background: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" = "toolPendingBg";
	private hasResult = false;
	private cache?: { width: number; mode: ToolRenderShell; colors: Theme["colors"]; pad: number; layout: Layout };

	private readonly mode: () => ToolRenderShell;

	constructor(mode: () => ToolRenderShell) {
		this.mode = mode;
	}

	getComponent(slot: Slot): Component | undefined {
		return slot === "call" ? this.call : this.result;
	}

	setCall(component: Component, theme: Theme, context: ShellContext) {
		this.call = component;
		this.update(theme, context);
	}

	setResult(component: Component, theme: Theme, context: ShellContext) {
		this.result = component;
		this.hasResult = true;
		this.update(theme, context);
	}

	private update(theme: Theme, context: ShellContext) {
		this.theme = theme;
		// Undefined means "no host inset", matching subagent and linear-todo; the TUI always passes a number.
		this.paddingX = Math.max(0, context.outputPad ?? 0);
		this.background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
		this.cache = undefined;
	}

	invalidate() {
		this.cache = undefined;
		this.call?.invalidate?.();
		this.result?.invalidate?.();
	}

	renderParts(width: number): Layout {
		if (width <= 0 || !this.theme) return { call: [], result: [] };
		const mode = this.mode();
		const colors = this.theme.colors;
		const pad = this.paddingX;
		if (this.cache?.width === width && this.cache.mode === mode && this.cache.colors === colors && this.cache.pad === pad) return this.cache.layout;

		let layout: Layout;
		if (mode === "self") {
			// Self mode has no host Box, so it must honour outputPad itself: the same horizontal
			// inset the default Box applies, without adding a background or vertical margins.
			const innerWidth = Math.max(1, width - pad * 2);
			const inset = " ".repeat(pad);
			const frame = (lines: string[] | undefined) =>
				(lines ?? []).map((line) => `${inset}${truncateToWidth(line, innerWidth, "…")}${inset}`);
			layout = { call: frame(this.call?.render(innerWidth)), result: frame(this.result?.render(innerWidth)) };
		} else {
			const theme = this.theme;
			const box = new Box(this.paddingX, 1, (line) => theme.bg(this.background, line));
			let callHeight = 0;
			box.addChild({
				invalidate() {},
				render: (contentWidth) => {
					const lines = this.call?.render(contentWidth) ?? [];
					callHeight = lines.length;
					return lines;
				},
			});
			if (this.result) box.addChild(this.result);
			const lines = box.render(width);
			// Before the first result there is no mounted result slot to own the bottom padding.
			const boundary = this.hasResult ? 1 + callHeight : lines.length;
			layout = { call: lines.slice(0, boundary), result: lines.slice(boundary) };
		}
		this.cache = { width, mode, colors, pad, layout };
		return layout;
	}
}
