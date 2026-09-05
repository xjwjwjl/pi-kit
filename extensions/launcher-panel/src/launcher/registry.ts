import type { LauncherFeature, PanelOption, PanelOptionContext } from "./types";

/**
 * Registration hub for launcher features.
 *
 * Each feature is registered once during extension setup; the launcher entry
 * (index.ts) resolves whatever is registered every time the panel opens.
 * This keeps the panel generic: adding a new feature never touches panel
 * code.
 */
export class LauncherRegistry {
	private readonly features = new Map<string, LauncherFeature>();

	/** Register (or replace) a feature. Returns the registry for chaining. */
	register(feature: LauncherFeature): this {
		this.features.set(feature.id, feature);
		return this;
	}

	/** Remove a previously registered feature. */
	unregister(id: string): boolean {
		return this.features.delete(id);
	}

	get(id: string): LauncherFeature | undefined {
		return this.features.get(id);
	}

	/** Insertion-ordered snapshot of all registered features. */
	list(): LauncherFeature[] {
		return [...this.features.values()];
	}

	/**
	 * Resolve every option contributed by registered features against the
	 * current context. Evaluated fresh on each call (panel open, shortcut
	 * press), so features may vary their options per workspace or session
	 * state. Features resolve in parallel; feature order is preserved by
	 * mapping before flattening, option order within a feature is kept as
	 * returned.
	 *
	 * A feature whose options() throws is skipped instead of taking the whole
	 * panel down; `onError` (when given) receives the failure so the caller
	 * can surface it — the registry itself stays UI-agnostic.
	 */
	async resolveOptions(
		panelCtx: PanelOptionContext,
		onError?: (feature: LauncherFeature, error: unknown) => void,
	): Promise<PanelOption[]> {
		const perFeature = await Promise.all(
			this.list().map(async (feature): Promise<PanelOption[]> => {
				try {
					return await feature.options(panelCtx);
				} catch (error) {
					onError?.(feature, error);
					return [];
				}
			}),
		);
		return perFeature.flat();
	}
}
