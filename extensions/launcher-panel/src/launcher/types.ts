import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Context handed to an option's execute() callback after the panel closes.
 */
export interface PanelOptionContext {
	/** Full pi extension context (ui, cwd, session access, ...). */
	ctx: ExtensionContext;
	/** Toplevel of the detected git workspace, or null when not in one. */
	workspaceRoot: string | null;
}

/**
 * A single selectable entry in a launcher panel.
 *
 * Options are decoupled from the panel itself: any feature can construct its
 * own option list and reuse the panel UI via showLauncherPanel().
 */
export interface PanelOption {
	/** Stable unique id, e.g. "my.action". */
	id: string;
	/** Display label. */
	label: string;
	/** Optional muted description rendered in the second column. */
	description?: string;
	/**
	 * Shortcut key id (e.g. "ctrl+w"). Displayed in the description column;
	 * when the option comes from a registered feature, the launcher also
	 * binds it globally via pi.registerShortcut to execute the option
	 * directly.
	 */
	shortcut?: string;
	/** Disabled entries can be navigated but not confirmed. */
	disabled?: boolean;
	/**
	 * Invoked after the panel has closed and this option was confirmed.
	 * May open further UI (the panel is reusable) or just notify. Errors are
	 * caught by runOption() and surfaced through ui.notify, never thrown
	 * back into pi's event loop.
	 */
	execute: (panelCtx: PanelOptionContext) => void | Promise<void>;
}

/**
 * Declarative feature contract — the single extension point of the launcher.
 *
 * A feature is pure data plus an options() provider evaluated every time the
 * panel opens, so the contributed options can depend on runtime context
 * (git workspace, session state, OS, ...). Adding a feature never touches
 * panel code: declare it in src/features/ and list it in index.ts.
 */
export interface LauncherFeature {
	/** Stable unique id, e.g. "my". */
	id: string;
	/** Short human-readable purpose; used for shortcut descriptions. */
	description?: string;
	/**
	 * Global shortcut keys (e.g. "ctrl+w") bound by the launcher entry via
	 * pi.registerShortcut. Pressing one resolves the feature options for the
	 * current context and executes the option whose shortcut matches; when
	 * nothing matches, the launcher panel opens instead. A key declared by
	 * several features is bound once (first registration wins, with a
	 * warning).
	 */
	shortcuts?: string[];
	/**
	 * Contribute panel options for the given context (dynamic per open).
	 * Throwing providers are isolated: the launcher skips the feature and
	 * reports the failure instead of failing the whole panel.
	 */
	options(panelCtx: PanelOptionContext): PanelOption[] | Promise<PanelOption[]>;
}

/**
 * Everything needed to render one launcher panel instance.
 */
export interface PanelConfig {
	/** Panel title shown inside the top border. */
	title: string;
	/** Optional dim subtitle below the title. */
	subtitle?: string;
	/** Panel width in terminal columns (default 64, clamped to the terminal). */
	width?: number;
	options: PanelOption[];
}

/**
 * Structural subset of pi's Theme used by the panel. Kept structural so the
 * panel component does not depend on a specific exported Theme type.
 */
export interface PanelTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}
