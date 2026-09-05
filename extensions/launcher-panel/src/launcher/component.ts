import type { Component, SelectItem, SelectListLayoutOptions, SelectListTheme } from "@earendil-works/pi-tui";
import { Container, SelectList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { PanelConfig, PanelOption, PanelTheme } from "./types";

/** Preferred panel width; overlay and fallback both clamp against it. */
export const PANEL_PREFERRED_WIDTH = 64;

/** Resolve the effective panel width for a given available width. */
export function cappedWidth(width: number, preferred: number = PANEL_PREFERRED_WIDTH): number {
	return Math.max(20, Math.min(preferred, width));
}

/** Map a launcher option to a SelectList item (shortcut joins description). */
export function toSelectItem(option: PanelOption): SelectItem {
	const description = [option.shortcut, option.description].filter(Boolean).join(" · ");
	return {
		value: option.id,
		label: option.label,
		...(description ? { description } : {}),
	};
}

/**
 * Launcher panel following pi's official selection-dialog conventions
 * (docs: Extensions > Custom UI > "Pattern 1: Selection Dialog"; the same
 * frame shape as the llama extension's dialog helper):
 *
 *   DynamicBorder — accent rules above and below (accent title, no custom
 *                   background: pi's own selectors never paint a panel bg)
 *   Text          — title/subtitle/hints with consistent built-in padding
 *   SelectList    — option rows: adaptive label column + description column,
 *                   selection highlight, wide-char safe truncation and the
 *                   app keybindings for up/down/enter/escape
 *
 * All alignment, wide-character measurement and truncation is delegated to
 * these components instead of manual string concatenation.
 */
export class LauncherPanel extends Container {
	private readonly selectList: SelectList;
	private readonly items: SelectItem[];

	constructor(
		config: PanelConfig,
		theme: PanelTheme,
		items: SelectItem[],
		disabledValues: ReadonlySet<string> = new Set(),
	) {
		super();
		this.items = items;

		// Key rule from the docs: always use the theme passed to the custom()
		// callback — never import a global theme (jiti loads extensions with a
		// separate module cache, so module-level theme state is unreliable).
		// Same shape as the official getSelectListTheme(), but built from the
		// callback theme (the global one is undefined under jiti's module cache).
		const selectTheme: SelectListTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("muted", t),
			noMatch: (t: string) => theme.fg("muted", t),
		};

		// Disabled rows stay navigable but never confirm; dim the label and
		// mark the description so their state is visible in the list.
		const selectItems = items.map((item) =>
			disabledValues.has(item.value)
				? {
						value: item.value,
						label: theme.fg("dim", item.label),
						description: item.description ? `${item.description} · disabled` : "disabled",
				  }
				: item,
		);

		// Official select-list layout: the label column adapts to the widest
		// label within 12..32 columns (same constants as pi's theme-selector),
		// so long descriptions keep as much width as possible instead of being
		// squeezed by a fixed 32-column label column.
		const selectLayout: SelectListLayoutOptions = {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		};

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", theme.bold(config.title)), 1, 0));
		if (config.subtitle) {
			this.addChild(new Text(theme.fg("dim", config.subtitle), 1, 0));
		}
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			selectItems,
			Math.min(Math.max(selectItems.length, 1), 10),
			selectTheme,
			selectLayout,
		);
		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "↑↓ select · 1-9 quick · enter run · esc close"), 1, 0));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	/** Wire confirm/cancel through to the underlying SelectList. */
	setCallbacks(onSelect: (value: string) => void, onCancel: () => void): void {
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
	}

	handleInput(data: string): void {
		// Digit quick-select (1..9) on top of the SelectList keybindings.
		if (/^[1-9]$/.test(data)) {
			const item = this.items[Number(data) - 1];
			if (item) {
				this.selectList.setSelectedIndex(Number(data) - 1);
				this.selectList.onSelect?.(item);
			}
			return;
		}
		this.selectList.handleInput(data);
	}
}

/**
 * Centers a child component and caps its width. Used by the non-overlay
 * fallback so the panel keeps the same compact size as the overlay variant
 * instead of stretching across the whole editor area.
 */
export class Centered implements Component {
	private readonly child: Component;
	private readonly preferredWidth: number;

	constructor(child: Component, preferredWidth: number = PANEL_PREFERRED_WIDTH) {
		this.child = child;
		this.preferredWidth = preferredWidth;
	}

	render(width: number): string[] {
		const w = cappedWidth(width, this.preferredWidth);
		const indent = " ".repeat(Math.max(0, Math.floor((width - w) / 2)));
		return this.child.render(w).map((line) => indent + truncateToWidth(line, w));
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
