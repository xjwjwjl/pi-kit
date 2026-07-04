import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type DialectChoice = "mysql" | "clickhouse";

export async function showDialectPicker(
	ctx: { ui: { custom?: <T>(factory: (...args: any[]) => any) => Promise<T> } },
	dialects: DialectChoice[],
): Promise<DialectChoice | undefined> {
	return ctx.ui.custom!<DialectChoice | undefined>((tui: any, theme: any, _kb: any, done: any) => {
		let selectedIndex = 0;

		function refresh() {
			tui.requestRender();
		}

		function move(delta: number) {
			selectedIndex = (selectedIndex + delta + dialects.length) % dialects.length;
			refresh();
		}

		function render(width: number): string[] {
			const panelWidth = Math.min(width, 64);
			const line = (text: string) => truncateToWidth(text, panelWidth, "", false);
			const options = dialects.map((dialect, index) => {
				const label = ` ${dialect} `;
				return index === selectedIndex
					? theme.bg("selectedBg", theme.fg("accent", label))
					: theme.fg("muted", label);
			});
			return [
				line(theme.bold("Select datasource dialect")),
				"",
				line(options.join("  ")),
				"",
				line(theme.fg("dim", "Tab select  Enter confirm  Esc cancel")),
			];
		}

		function handleInput(data: string) {
			if (matchesKey(data, "escape")) {
				done(undefined);
				return;
			}
			if (matchesKey(data, "shift+tab") || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
				move(-1);
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
				move(1);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(dialects[selectedIndex]);
				return;
			}
		}

		return { render, handleInput, invalidate: () => {} };
	});
}
