import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { PanelOption, PanelOptionContext } from "./types";

/**
 * Cross-extension option source.
 *
 * pi has no service registry between extensions (jiti loads each extension
 * with its own module cache), but `pi.getCommands()` is the official
 * discovery point: any extension that registers a slash command becomes
 * visible here. The launcher surfaces extension-contributed commands as
 * additional options, so sibling pi-kit extensions plug into the panel
 * without importing anything from it.
 */

/** Map extension-contributed slash commands into launcher options. */
export function extensionCommandOptions(
	commands: SlashCommandInfo[],
	exclude: ReadonlySet<string> = new Set(),
): PanelOption[] {
	return commands
		.filter((command) => command.source === "extension" && !exclude.has(command.name))
		.map((command) => ({
			id: `command.${command.name}`,
			label: `/${command.name}`,
			// pi offers no programmatic slash-command dispatch from extensions:
			// selecting one prefills the editor and the user confirms with
			// enter. The description says so explicitly to set expectations.
			description: command.description
				? `${command.description} \u00b7 prefills the editor`
				: "Prefills the editor (confirm with enter)",
			execute: ({ ctx }: PanelOptionContext) => {
				ctx.ui.setEditorText(`/${command.name} `);
			},
		}));
}
