import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type SourceListItem = {
	name: string;
	dialect: string;
	database: string;
	endpoint: string;
};

export type SourceListAction =
	| { type: "add" }
	| { type: "edit"; index: number }
	| { type: "delete"; index: number }
	| { type: "toggle-tools" }
	| null;

export async function showSourceList(
	ctx: { ui: { custom?: <T>(factory: (...args: any[]) => any) => Promise<T> } },
	title: string,
	items: SourceListItem[],
	options: { toolsEnabled?: boolean; onTestConnection?: (index: number) => Promise<string> } = {},
): Promise<SourceListAction> {
	return ctx.ui.custom!<SourceListAction>((tui: any, theme: any, _kb: any, done: any) => {
		let selectedIndex = 0;
		let testing = false;
		let testStatus: string | undefined;

		function refresh() {
			tui.requestRender();
		}

		function clampSelection() {
			if (items.length === 0) {
				selectedIndex = 0;
				return;
			}
			selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
		}

		function moveSelection(delta: number) {
			if (items.length === 0) return;
			selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta));
			refresh();
		}

		function selectedAction(type: "edit" | "delete") {
			if (items.length === 0) return;
			clampSelection();
			done({ type, index: selectedIndex });
		}

		function testSelectedSource() {
			if (items.length === 0 || testing || !options.onTestConnection) return;
			clampSelection();
			const index = selectedIndex;
			testing = true;
			testStatus = `Testing ${items[index]?.name ?? "source"}...`;
			refresh();
			options.onTestConnection(index).then((result) => {
				testStatus = result;
			}).catch((error) => {
				testStatus = error instanceof Error ? error.message : String(error);
			}).finally(() => {
				testing = false;
				refresh();
			});
		}

		function fit(text: string, fieldWidth: number): string {
			return truncateToWidth(text, fieldWidth, "…").padEnd(fieldWidth, " ");
		}

		function render(width: number): string[] {
			clampSelection();
			const panelWidth = Math.min(width, 96);
			const line = (text: string) => truncateToWidth(text, panelWidth, "", false);
			const GAP = 2;

			const nameWidth = Math.min(22, Math.max(14, ...items.map((item) => item.name.length), 4));
			const databaseWidth = Math.min(14, Math.max(8, ...items.map((item) => item.database.length), 8));
			const dialectWidth = 10;
			const maxEndpointWidth = Math.max(12, panelWidth - nameWidth - databaseWidth - dialectWidth - GAP * 3);
			const naturalEndpointWidth = Math.max(12, ...items.map((item) => item.endpoint.length), "Host".length);
			const endpointWidth = Math.min(34, maxEndpointWidth, naturalEndpointWidth);
			const separatorWidth = nameWidth + endpointWidth + databaseWidth + dialectWidth + GAP * 3;

			const headerRow = [
				fit("Dialect", dialectWidth),
				fit("Name", nameWidth),
				fit("Host", endpointWidth),
				fit("Database", databaseWidth),
			].join(" ".repeat(GAP));

			const lines: string[] = [];
			const toolsLabel = options.toolsEnabled ? theme.fg("success", "tools: on") : theme.fg("dim", "tools: off");
			lines.push(line(`${theme.bold("SQL Sources")}  ${theme.fg("dim", title)}  ${toolsLabel}`));
			lines.push("");
			lines.push(line(theme.fg("accent", headerRow)));
			lines.push(line(theme.fg("borderMuted", "─".repeat(separatorWidth))));

			if (items.length === 0) {
				lines.push(line(theme.fg("dim", "No SQL sources configured.")));
				lines.push("");
				lines.push(line(theme.fg("dim", "Ctrl+A add  Ctrl+O toggle  Esc close")));
				return lines;
			}

			for (const [index, item] of items.entries()) {
				const selected = index === selectedIndex;
				const row = [
					fit(item.dialect, dialectWidth),
					fit(item.name, nameWidth),
					fit(item.endpoint, endpointWidth),
					fit(item.database, databaseWidth),
				].join(" ".repeat(GAP));
				const trimmed = line(row);
				lines.push(selected ? theme.bg("selectedBg", trimmed) : trimmed);
			}

			if (testStatus) {
				const ok = testStatus.startsWith("Connection successful");
				lines.push(line(ok ? theme.fg("success", testStatus) : theme.fg("warning", testStatus)));
			} else {
				lines.push("");
			}
			lines.push(line(theme.fg("dim", "↑↓/Tab select  Enter edit  Ctrl+A add  Ctrl+D delete  Ctrl+T test  Ctrl+O toggle  Esc close")));
			return lines;
		}

		function handleInput(data: string) {
			if (matchesKey(data, "escape")) {
				done(null);
				return;
			}
			if (matchesKey(data, Key.ctrl("a"))) {
				done({ type: "add" });
				return;
			}
			if (matchesKey(data, Key.ctrl("o"))) {
				done({ type: "toggle-tools" });
				return;
			}
			if (matchesKey(data, "shift+tab") || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
				moveSelection(-1);
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
				moveSelection(1);
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("e"))) {
				selectedAction("edit");
				return;
			}
			if (matchesKey(data, Key.ctrl("d"))) {
				selectedAction("delete");
				return;
			}
			if (matchesKey(data, Key.ctrl("t"))) {
				testSelectedSource();
				return;
			}
		}

		return { render, handleInput, invalidate: () => {} };
	});
}
