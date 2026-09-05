import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Centered, LauncherPanel, PANEL_PREFERRED_WIDTH, toSelectItem } from "./component";
import type { LauncherRegistry } from "./registry";
import type { PanelConfig, PanelOption, PanelOptionContext, PanelTheme } from "./types";

/** Human-readable one-line form of an unknown error. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Execute a confirmed option with error isolation.
 *
 * The panel has already closed at this point, so a throwing execute() must
 * not escape into pi's event loop as an unhandled rejection: failures are
 * surfaced through ui.notify instead. Both openLauncher() and the global
 * shortcut handlers run confirmed options through this single path.
 */
export async function runOption(option: PanelOption, panelCtx: PanelOptionContext): Promise<void> {
	try {
		await option.execute(panelCtx);
	} catch (error) {
		panelCtx.ctx.ui.notify(`Launcher option "${option.label}" failed: ${errorMessage(error)}`, "error");
	}
}

/**
 * Remembered overlay capability. Overlay support cannot be probed without
 * actually calling ui.custom, so the first failure (older pi, or any other
 * overlay error) permanently downgrades this process to the editor-replacement
 * fallback — subsequent opens never pay the throw-and-retry cost again.
 */
let overlaySupported = true;

/** Test-only: forget the remembered overlay capability. */
export function resetOverlaySupport(): void {
	overlaySupported = true;
}

/**
 * Show a launcher panel and return the confirmed option (or null on cancel).
 *
 * This is the reusable core: any feature can build its own PanelConfig and
 * present it through the exact same UI. Renders as a floating overlay when
 * the pi version supports it, falling back to editor-replacement mode where
 * the panel is centered and width-capped via the Centered wrapper.
 */
export async function showLauncherPanel(
	ctx: ExtensionContext,
	config: PanelConfig,
): Promise<PanelOption | null> {
	// rpc/json/print have no terminal UI; hasUI false means no dialog-capable
	// UI either. Guarded here once — every panel path (auto-open, /launcher,
	// shortcuts, feature sub-panels) funnels through this function.
	if (ctx.mode !== "tui" || !ctx.hasUI) return null;

	// Duplicate option ids would silently collapse in the byId map (later
	// entries overwriting earlier ones): keep the first occurrence and warn,
	// so a collision between features or extension commands is diagnosable.
	const options: PanelOption[] = [];
	const seenIds = new Set<string>();
	for (const option of config.options) {
		if (seenIds.has(option.id)) {
			ctx.ui.notify(`Duplicate launcher option id "${option.id}" ignored`, "warning");
			continue;
		}
		seenIds.add(option.id);
		options.push(option);
	}

	// An empty panel is uninformative: show one disabled placeholder row
	// instead of a blank SelectList (disabled rows can be navigated but
	// never confirmed, so the panel stays fully interactive).
	if (options.length === 0) {
		options.push({
			id: "__empty__",
			label: "No options available",
			description: "Register features or extension commands to populate the panel",
			disabled: true,
			execute: () => {},
		});
	}
	const byId = new Map(options.map((option) => [option.id, option]));
	const width = config.width ?? PANEL_PREFERRED_WIDTH;

	const factory = (
		tui: TUI,
		theme: Theme,
		_keybindings: KeybindingsManager,
		done: (value: PanelOption | null) => void,
	) => {
		const panel = new LauncherPanel(
			config,
			theme as PanelTheme,
			options.map(toSelectItem),
			new Set(options.filter((option) => option.disabled).map((option) => option.id)),
		);
		panel.setCallbacks(
			(value) => {
				const option = byId.get(value);
				if (!option || option.disabled) return; // stay open, keep navigable
				done(option);
			},
			() => done(null),
		);
		return {
			render: (available: number) => panel.render(available),
			handleInput: (data: string) => {
				panel.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => panel.invalidate(),
		};
	};

	// Editor-replacement variant: temporarily replace the editor area.
	// Centered keeps the panel compact instead of stretching full width.
	const fallbackFactory = (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: PanelOption | null) => void,
	) => {
		const component = factory(tui, theme, keybindings, done);
		const centered = new Centered(component, width);
		return {
			// Vertical centering keeps the fallback visually aligned with the
			// centered overlay; when the area is too small, render as-is.
			render: (available: number) => {
				const inner = centered.render(Math.max(0, available));
				if (available <= inner.length) return inner;
				const top = Math.floor((available - inner.length) / 2);
				const bottom = available - inner.length - top;
				return [
					...new Array<string>(top).fill(""),
					...inner,
					...new Array<string>(bottom).fill(""),
				];
			},
			handleInput: (data: string) => {
				centered.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => centered.invalidate(),
		};
	};

	// Skip the overlay attempt entirely once it is known to fail (see
	// overlaySupported above): no repeated throw-and-fallback churn.
	if (overlaySupported) {
		try {
			// Floating modal (matches the screenshot look), experimental in pi.
			const result = await ctx.ui.custom<PanelOption | null>(factory, {
				overlay: true,
				overlayOptions: { anchor: "center", width, margin: 1 },
			});
			return result ?? null;
		} catch (overlayError) {
			overlaySupported = false;
			// Older pi without overlay support throws on the call above; the
			// fallback below handles it. If the fallback fails too, surface
			// both errors instead of silently hiding the original one.
			try {
				const result = await ctx.ui.custom<PanelOption | null>(fallbackFactory);
				return result ?? null;
			} catch (fallbackError) {
				throw new Error(
					`Launcher panel failed in overlay and fallback mode ` +
						`(overlay: ${errorMessage(overlayError)}; fallback: ${errorMessage(fallbackError)})`,
					{ cause: { overlay: overlayError, fallback: fallbackError } },
				);
			}
		}
	}

	// Editor-replacement mode (older pi, or overlay remembered as broken).
	const result = await ctx.ui.custom<PanelOption | null>(fallbackFactory);
	return result ?? null;
}

/** Optional presentation overrides for the aggregated main panel. */
export interface OpenLauncherOverrides {
	title?: string;
	subtitle?: string;
}

/**
 * Open the main launcher: resolve feature options for the current context
 * (plus any extra option source, e.g. aggregated slash commands), render
 * the panel, then run the selected option via runOption() after it closes.
 *
 * A failing option source (feature or extraOptions) never blocks the panel:
 * it is skipped and reported through ui.notify.
 */
export async function openLauncher(
	ctx: ExtensionContext,
	registry: LauncherRegistry,
	workspaceRoot: string | null,
	extraOptions: (panelCtx: PanelOptionContext) => PanelOption[] | Promise<PanelOption[]> = () => [],
	overrides: OpenLauncherOverrides = {},
): Promise<void> {
	// UI capability gate (matches showLauncherPanel's): resolving options
	// only makes sense when the panel can actually render, so non-TUI modes
	// never even run feature options() providers.
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	const panelCtx: PanelOptionContext = { ctx, workspaceRoot };

	const featureOptions = await registry.resolveOptions(panelCtx, (feature, error) => {
		ctx.ui.notify(`Feature "${feature.id}" failed to provide options: ${errorMessage(error)}`, "error");
	});

	let extraList: PanelOption[] = [];
	try {
		extraList = await extraOptions(panelCtx);
	} catch (error) {
		ctx.ui.notify(`Extra option source failed: ${errorMessage(error)}`, "error");
	}

	const config: PanelConfig = {
		title: overrides.title ?? "pi-kit launcher",
		subtitle: overrides.subtitle ?? (workspaceRoot
			? `Git workspace: ${workspaceRoot}`
			: "Not inside a git workspace"),
		options: [...featureOptions, ...extraList],
	};

	const selected = await showLauncherPanel(ctx, config);
	if (selected) {
		await runOption(selected, panelCtx);
	}
}
