import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { findGitWorkspace } from "./src/git";
import { extensionCommandOptions } from "./src/launcher/commands";
import { LauncherRegistry } from "./src/launcher/registry";
import { errorMessage, openLauncher, runOption, showLauncherPanel } from "./src/launcher/show";
import type { LauncherFeature, PanelOption, PanelOptionContext } from "./src/launcher/types";

/** Declarative feature list — the single place where new features plug in. */
const features: LauncherFeature[] = [
	// nextFeature, ...
];

/**
 * Slash commands this extension registers. The exclusion set fed to
 * extensionCommandOptions() is derived from this list, so adding a command
 * here never requires syncing a second place.
 */
const OWN_COMMANDS: Array<{ name: string; description: string }> = [
	{ name: "launcher", description: "Open the launcher panel" },
];
const OWN_COMMAND_NAMES = new Set(OWN_COMMANDS.map((command) => command.name));

/**
 * launcher-panel — universal startup launcher panel for pi.
 *
 * Behavior:
 *  - On pi startup inside a git workspace: auto-open the launcher panel.
 *  - Outside a git workspace: stay silent.
 *  - `/launcher` reopens the panel at any time.
 *  - Feature-declared shortcuts execute the matching option directly,
 *    without opening the panel.
 *
 * Option sources: registered LauncherFeatures (dynamic, resolved per open)
 * plus slash commands contributed by other extensions (pi.getCommands()),
 * collapsed into a single "Extension commands" sub-panel so the main panel
 * stays focused on features. The panel itself is generic and reusable
 * (see src/launcher/show.ts).
 */
export default function launcherPanel(pi: ExtensionAPI): void {
	const registry = new LauncherRegistry();
	for (const feature of features) {
		registry.register(feature);
	}

	// Second option source: slash commands registered by other extensions —
	// pi.getCommands() is the official cross-extension discovery point.
	// They are collapsed into a single sub-panel entry so the main panel
	// stays short no matter how many sibling extensions contribute commands.
	const extraOptions = async (): Promise<PanelOption[]> => {
		const commands = extensionCommandOptions(pi.getCommands(), OWN_COMMAND_NAMES);
		if (commands.length === 0) return [];
		return [
			{
				id: "launcher.commands",
				label: "Extension commands",
				description: `${commands.length} slash command${commands.length === 1 ? "" : "s"} from other extensions`,
				execute: async (panelCtx) => {
					const selected = await showLauncherPanel(panelCtx.ctx, {
						title: "Extension commands",
						subtitle: "Selecting a command prefills the editor (confirm with enter)",
						options: commands,
					});
					if (selected) {
						await runOption(selected, panelCtx);
					}
				},
			},
		];
	};

	/** Build the per-invocation panel context (fresh git detection each time). */
	const panelContext = (ctx: ExtensionContext): PanelOptionContext => ({
		ctx,
		workspaceRoot: findGitWorkspace(ctx.cwd)?.root ?? null,
	});

	const open = async (ctx: ExtensionContext): Promise<void> => {
		const { workspaceRoot } = panelContext(ctx);
		await openLauncher(ctx, registry, workspaceRoot, extraOptions);
	};

	// Manual entry point, works anywhere (git detection only gates auto-open).
	for (const command of OWN_COMMANDS) {
		pi.registerCommand(command.name, {
			description: command.description,
			handler: async (_args, ctx) => {
				await open(ctx);
			},
		});
	}

	// Real global shortcuts: keys are declared statically per feature and
	// registered via pi.registerShortcut; on press the matching option is
	// resolved live for the current context and executed directly through
	// runOption(). A key declared by several features is bound once — first
	// registration wins, later declarations are warned about instead of
	// silently overwriting each other in pi.
	const shortcutOwners = new Map<string, string>();
	for (const feature of registry.list()) {
		for (const key of feature.shortcuts ?? []) {
			const owner = shortcutOwners.get(key);
			if (owner) {
				console.warn(
					`[launcher-panel] shortcut "${key}" is declared by both "${owner}" and "${feature.id}"; only "${owner}" is bound`,
				);
				continue;
			}
			shortcutOwners.set(key, feature.id);
			pi.registerShortcut(key as KeyId, {
				description: feature.description ?? `Launcher feature: ${feature.id}`,
				handler: async (ctx) => {
					const panelCtx = panelContext(ctx);
					const resolved = await registry.resolveOptions(panelCtx, (failed, error) => {
						ctx.ui.notify(`Feature "${failed.id}" failed to provide options: ${errorMessage(error)}`, "error");
					});
					const match = resolved.find((option) => option.shortcut === key && !option.disabled);
					if (match) {
						await runOption(match, panelCtx);
					} else {
						await open(ctx);
					}
				},
			});
		}
	}

	// Auto-open on startup. Product gates live here (first startup, git
	// project); the TUI capability gate (mode/hasUI) is owned by show.ts so
	// it is enforced identically for every panel path.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return; // don't re-pop on resume/fork/new

		const workspace = findGitWorkspace(ctx.cwd);
		if (!workspace) return; // not a git project: panel must not trigger

		await open(ctx);
	});
}
