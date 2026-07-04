import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export async function showDeleteConfirm(
	ctx: { ui: { custom?: <T>(factory: (...args: any[]) => any) => Promise<T> } },
	sourceName: string,
): Promise<boolean> {
	return ctx.ui.custom!<boolean>((_tui: any, theme: any, _kb: any, done: any) => {
		function fit(text: string, width: number): string {
			return truncateToWidth(text, width, "…").padEnd(width, " ");
		}

		function render(width: number): string[] {
			const panelWidth = Math.min(width, 72);
			const line = (text: string) => truncateToWidth(text, panelWidth, "", false);
			const labelWidth = 8;
			const valueWidth = Math.max(12, panelWidth - labelWidth - 2);
			const row = (label: string, value: string) => line(`${fit(label, labelWidth)}  ${fit(value, valueWidth)}`);
			return [
				line(theme.fg("warning", theme.bold("Delete source"))),
				"",
				row("Name", sourceName),
				line(`${fit("Action", labelWidth)}  ${theme.fg("warning", fit("Remove from SQLKit config", valueWidth))}`),
				"",
				line(theme.fg("borderMuted", "─".repeat(panelWidth))),
				line(`${theme.fg("dim", "Enter ")}${theme.fg("warning", "delete")}${theme.fg("dim", "   Esc cancel")}`),
			];
		}

		function handleInput(data: string) {
			if (matchesKey(data, "escape")) {
				done(false);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(true);
				return;
			}
		}

		return { render, handleInput, invalidate: () => {} };
	});
}
