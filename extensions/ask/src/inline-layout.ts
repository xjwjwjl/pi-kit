import type { Component, TUI } from '@earendil-works/pi-tui';

export interface InlineLayout {
	height: number;
	naturalHeight: number;
	key: string;
}

type InlineTui = Pick<TUI, 'mode' | 'terminal' | 'children'>;
const measuring = new WeakMap<InlineTui, { reentered: boolean }>();

function positiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/**
 * Pi 1.4.0's zero-gap stack allocation (unchanged since 1.3.0), restricted to the dock's shrink=1
 * entries and the outer stack's single growing transcript. In particular the
 * remaining amount changes *during* each weighted pass; simultaneous rounding
 * would give different editor heights. No production SDK internals are imported.
 */
function allocate(natural: number[], minima: number[], available: number, growFirst = false): number[] {
	const sizes = natural.map((size, index) => Math.max(size, minima[index]));
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= available) {
		if (growFirst) sizes[0] += available - total;
		return sizes;
	}
	let remaining = total - available;
	while (remaining > 0) {
		const candidates = sizes.map((_, index) => index).filter((index) => sizes[index] > minima[index]);
		if (candidates.length === 0) break;
		const weight = candidates.reduce((sum, index) => sum + Math.max(1, sizes[index]), 0);
		for (const index of candidates) {
			if (remaining <= 0) break;
			const proposed = Math.max(1, Math.floor(remaining * Math.max(1, sizes[index]) / weight));
			const delta = Math.min(remaining, proposed, sizes[index] - minima[index]);
			sizes[index] -= delta;
			remaining -= delta;
		}
	}
	return sizes;
}

/**
 * Read-only adapter for Pi 1.4.0's public seven-root interactive component tree:
 * document, pending, status, above, editor Container, below, footer.
 * Its fullscreen chat-viewport uses transcript(basis=0,grow=1,min=1) and
 * dock(auto,grow=0,min=1), both shrink=1. The dock minima are [0,0,0,3,0,0].
 * This is deliberately version-pinned reconstruction, not a replacement layout.
 * Unknown/unmounted trees and unsafe sibling renders get a small fallback.
 */
export function resolveInlineLayout(
	tui: InlineTui,
	owner: Component,
	width: number,
	requestedHeight: number,
): InlineLayout {
	const rows = positiveInteger(tui.terminal.rows, 1);
	const columns = positiveInteger(width, 1);
	const requested = Math.min(14, positiveInteger(requestedHeight, 1));
	const prefix = `inline:1.4.0:${tui.mode}:${rows}:${columns}:${requested}`;
	const fallback = (reason: string, standalone = false): InlineLayout => {
		const height = Math.min(requested, rows, standalone ? requested : 3);
		return { height, naturalHeight: height, key: `${prefix}:fallback:${reason}:${height}` };
	};

	const active = measuring.get(tui);
	if (active) {
		active.reentered = true;
		return fallback('reentrant');
	}

	const state = { reentered: false };
	measuring.set(tui, state);
	const heights: number[] = [];
	try {
		const roots = tui.children;
		const editor = roots[4] as (Component & { children?: Component[] }) | undefined;
		// Only the public tree shape is inspectable here. The pinned host mounts an
		// ordinary Container at slot 4; wrappers or extra editor children are not
		// supported. Avoid instanceof: host and extension may load separate SDKs.
		if (roots.length !== 7 || new Set(roots).size !== 7
			|| roots.some((root) => !root || root === owner || typeof root.render !== 'function')
			|| !Array.isArray(editor?.children)
			|| editor.children.length !== 1 || editor.children[0] !== owner) {
			return fallback('unknown-tree', tui.mode !== 'fullscreen' && roots.length === 0);
		}

		const indices = tui.mode === 'fullscreen' ? [1, 2, 3, 5, 6] : [5, 6];
		for (const index of indices) {
			// Never render the transcript or editor: either can recurse into owner.
			const lines = roots[index].render(columns);
			if (!Array.isArray(lines)) return fallback(`invalid-sibling:${index}:${heights}`);
			heights.push(lines.length);
			// A sibling may have indirectly rendered owner. Its measurement is not
			// trustworthy, even if it caught the nested fallback and returned lines.
			if (state.reentered) return fallback(`sibling-cycle:${index}:${heights}`);
		}

		if (tui.mode !== 'fullscreen') {
			const remaining = rows - heights[0] - heights[1];
			// With no row left there is no physical visibility guarantee. Do not hide
			// or reorder other widgets; report the smallest usable inline content.
			const height = Math.min(requested, Math.max(1, remaining));
			return {
				height,
				naturalHeight: height,
				key: `${prefix}:regular:${heights}:${remaining <= 0 ? 'fallback:obstructed' : 'available'}:${height}`,
			};
		}

		const natural = [heights[0], heights[1], heights[2], requested, heights[3], heights[4]];
		const minima = [0, 0, 0, 3, 0, 0];
		const dockNatural = natural.reduce((sum, size, index) => sum + Math.max(size, minima[index]), 0);
		const outer = allocate([0, dockNatural], [1, 1], rows, true);
		const dock = allocate(natural, minima, outer[1]);
		const editorTop = outer[0] + dock[0] + dock[1] + dock[2];
		const dockBottom = Math.min(rows, outer[0] + outer[1]);
		const clipped = Math.max(0, Math.min(dock[3], dockBottom - editorTop));
		// The min=3 allocation may exceed both screen space and natural content.
		// Only report visible content rows; a completely clipped editor gets zero.
		const height = Math.min(requested, clipped);
		return {
			height,
			// Caller MUST pad to requested so subsequent host measurements stay
			// natural rather than feeding the shrunken allocation back into layout.
			naturalHeight: requested,
			key: `${prefix}:fullscreen:${heights}:${outer}:${dock}:${clipped}:${height}`,
		};
	} catch {
		return fallback(`measurement-error:${heights}`);
	} finally {
		measuring.delete(tui);
	}
}
