import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SessionTreeNode, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	buildTurnForest,
	entryRows,
	filterTurnForest,
	flattenTurnForest,
	formatSessionRollup,
	formatTurnInsight,
	matchesTurnFilter,
	matchesTurnQuery,
	navigateTargetId,
	messageText,
	type EntryRow,
	type OutlineFilterMode,
	rowPrefix,
	sessionRollup,
	type TurnRow,
	turnStatusGlyphs,
	userText,
} from "./outline-model.ts";

export type OutlineState = {
	selectedId?: string;
	query?: string;
	collapsedIds?: string[];
	filterMode?: OutlineFilterMode;
};

export type OutlineAction =
	| { type: "navigate"; targetId: string; state: OutlineState }
	| { type: "label"; targetId: string; state: OutlineState };

function compactText(value: string, max = 110): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "(no content)";
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function keyLabel(keybindings: KeybindingsManager, id: Keybinding, fallback: string): string {
	const key = keybindings.getKeys(id)[0];
	if (!key) return fallback;
	return key.replace("pageUp", "PgUp").replace("pageDown", "PgDn").replace("up", "↑").replace("down", "↓");
}

function activityText(row: TurnRow): string {
	const insight = row.node.insight;
	const tools = insight.tools.map((tool) => `${tool.name}${tool.count > 1 ? `×${tool.count}` : ""}`).join(", ");
	const files = [
		...insight.readFiles.map((path) => `R:${path}`),
		...insight.modifiedFiles.map((path) => `W:${path}`),
	].join(", ");
	return [tools && `tools ${tools}`, files && `files ${files}`].filter(Boolean).join(" · ") || "no tool or file activity";
}

const FACET_HINT = "facets: model: file: tool: label: cost:>N branch:active";

function roleColor(role: string): ThemeColor {
	if (role === "user") return "userMessageText";
	if (role === "assistant") return "text";
	if (role === "toolResult") return "success";
	return "dim";
}

export class SessionTurnsComponent implements Component, Focusable {
	private _focused = false;
	private readonly forest;
	private rows: TurnRow[] = [];
	private rowsVersion = 0;
	private cachedVisibleRows: TurnRow[] | undefined;
	private cachedQuery: string | undefined;
	private cachedFilterMode: OutlineFilterMode | undefined;
	private cachedRowsVersion = -1;
	private readonly tui: { requestRender(): void; terminal: { rows: number } };
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: OutlineAction | undefined) => void;
	private selectedId: string | undefined;
	private readonly activeIds: ReadonlySet<string>;
	private readonly collapsedIds: Set<string>;
	private query: string;
	private filterMode: OutlineFilterMode;
	private pendingG = false;
	private assistantView = false;
	private assistantScroll = 0;
	private searching = false;
	private readonly searchInput = new Input();
	private readonly rollupText: string;
	private drillView = false;
	private drillRows: EntryRow[] = [];
	private drillSelected = 0;

	constructor(
		tui: { requestRender(): void; terminal: { rows: number } },
		theme: Theme,
		keybindings: KeybindingsManager,
		tree: SessionTreeNode[],
		activeIds: ReadonlySet<string>,
		done: (result: OutlineAction | undefined) => void,
		state: OutlineState,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.forest = buildTurnForest(tree);
		this.activeIds = activeIds;
		this.rollupText = formatSessionRollup(sessionRollup(this.forest, this.activeIds));
		this.collapsedIds = new Set(state.collapsedIds);
		this.rows = flattenTurnForest(this.forest, this.collapsedIds, this.activeIds);
		this.done = done;
		const deepestActive = this.rows.filter((row) => this.isActive(row)).at(-1);
		this.selectedId = state.selectedId ?? deepestActive?.node.user.entry.id ?? this.rows[0]?.node.user.entry.id;
		this.query = state.query ?? "";
		this.filterMode = state.filterMode ?? "all";
		this.searchInput.setValue(this.query);
		this.searchInput.onSubmit = () => this.finishSearch();
		this.searchInput.onEscape = () => this.finishSearch();
		this.ensureSelection();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searching;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (this.drillView) {
			this.handleDrillViewInput(data);
			return;
		}
		if (this.assistantView) {
			this.handleAssistantViewInput(data);
			return;
		}
		if (this.searching) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.finishSearch();
				return;
			}
			this.searchInput.handleInput(data);
			this.query = this.searchInput.getValue();
			this.ensureSelection();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			this.pendingG = false;
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.slash)) {
			this.pendingG = false;
			this.searching = true;
			this.searchInput.focused = this.focused;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.pendingG = false;
			if (this.selectedRow()?.node.assistant) {
				this.assistantView = true;
				this.assistantScroll = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "app.tree.editLabel") || matchesKey(data, "t")) {
			this.pendingG = false;
			const row = this.selectedRow();
			if (row) this.done({ type: "label", targetId: row.node.user.entry.id, state: this.state() });
			return;
		}
		if (this.keybindings.matches(data, "app.tree.filter.cycleForward")) {
			this.pendingG = false;
			this.cycleFilter(1);
			return;
		}
		if (this.keybindings.matches(data, "app.tree.filter.cycleBackward")) {
			this.pendingG = false;
			this.cycleFilter(-1);
			return;
		}
		if (this.keybindings.matches(data, "app.tree.filter.default")) {
			this.setFilterMode("all");
			return;
		}
		if (this.keybindings.matches(data, "app.tree.filter.userOnly")) {
			this.setFilterMode(this.filterMode === "active" ? "all" : "active");
			return;
		}
		if (this.keybindings.matches(data, "app.tree.filter.labeledOnly")) {
			this.setFilterMode(this.filterMode === "labeled" ? "all" : "labeled");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.pendingG = false;
			const row = this.selectedRow();
			if (row) this.done({ type: "navigate", targetId: navigateTargetId(row.node, true), state: this.state() });
			return;
		}
		if (matchesKey(data, "f")) {
			this.pendingG = false;
			const row = this.selectedRow();
			if (row) this.done({ type: "navigate", targetId: navigateTargetId(row.node, false), state: this.state() });
			return;
		}
		if (matchesKey(data, "z")) {
			this.pendingG = false;
			const row = this.selectedRow();
			if (row) {
				const rows = entryRows(row.node);
				if (rows.length > 1) {
					this.drillRows = rows;
					this.drillSelected = this.drillRows.length - 1;
					this.drillView = true;
					this.tui.requestRender();
				}
			}
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.pendingG = false;
			this.toggleSelected();
			return;
		}
		if (this.keybindings.matches(data, "app.tree.foldOrUp") || matchesKey(data, "h")) {
			this.pendingG = false;
			this.foldOrPreviousBranch();
			return;
		}
		if (this.keybindings.matches(data, "app.tree.unfoldOrDown") || matchesKey(data, "l")) {
			this.pendingG = false;
			this.unfoldOrNextBranch();
			return;
		}
		if (matchesKey(data, "g")) {
			if (this.pendingG) this.moveToBoundary("first");
			this.pendingG = !this.pendingG;
			return;
		}
		if (matchesKey(data, Key.shift("g")) || data === "G") {
			this.pendingG = false;
			this.moveToBoundary("last");
			return;
		}
		this.pendingG = false;
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-this.maxVisibleRows());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveSelection(this.maxVisibleRows());
	}

	render(width: number): string[] {
		if (this.drillView) return this.renderDrillView(width);
		if (this.assistantView) return this.renderAssistantView(width);
		const rows = this.visibleRows();
		const selectedIndex = Math.max(0, rows.findIndex((row) => row.node.user.entry.id === this.selectedId));
		const searchLine = this.searching
			? `  Search: ${this.searchInput.render(Math.max(1, width - 10))[0] ?? ""} ${FACET_HINT}`
			: `  Search: ${this.query || "type / to filter"}`;
		const filter = this.filterMode === "all" ? "" : ` [${this.filterMode}]`;
		const status = `  (${selectedIndex + 1}/${rows.length || 0}) [user turns]${filter} · • active path`;
		const pageKeys = `${keyLabel(this.keybindings, "tui.select.pageUp", "PgUp")}/${keyLabel(this.keybindings, "tui.select.pageDown", "PgDn")}`;

		return [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold("  Session Outline"), width),
			padToWidth(this.theme.fg("accent", `  ◆ ${this.rollupText}`), width),
			padToWidth(this.theme.fg("muted", searchLine), width),
			padToWidth(
				this.theme.fg("dim", `  ↑↓/jk move · ${pageKeys} page · h/l branch · Space fold · Tab reply · Enter jump · f re-ask · z drill · t tag · Ctrl+O filter`),
				width,
			),
			...this.renderDetail(width),
			this.renderBorder(width),
			"",
			...this.renderRows(width, this.maxVisibleRows(), rows, selectedIndex),
			padToWidth(this.theme.fg("muted", status), width),
			"",
			this.renderBorder(width),
		];
	}

	private maxVisibleRows(): number {
		return Math.max(5, Math.min(Math.floor(this.tui.terminal.rows / 2), this.tui.terminal.rows - 12));
	}

	private handleAssistantViewInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.input.tab") ||
			this.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, "q")
		) {
			this.pendingG = false;
			this.assistantView = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "g")) {
			if (this.pendingG) this.assistantScroll = 0;
			this.pendingG = !this.pendingG;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("g")) || data === "G") {
			this.pendingG = false;
			this.assistantScroll = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		this.pendingG = false;
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.assistantScroll = Math.max(0, this.assistantScroll - 1);
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) this.assistantScroll += 1;
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.assistantScroll = Math.max(0, this.assistantScroll - this.maxVisibleRows());
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) this.assistantScroll += this.maxVisibleRows();
		this.tui.requestRender();
	}

	private renderAssistantView(width: number): string[] {
		const row = this.selectedRow();
		const assistant = row?.node.assistant;
		if (!row || !assistant) {
			this.assistantView = false;
			return this.render(width);
		}
		const contentWidth = Math.max(1, width - 2);
		const lines = new Markdown(messageText(assistant), 0, 0, getMarkdownTheme()).render(contentWidth);
		const maxVisible = Math.max(5, this.tui.terminal.rows - 12);
		const maxScroll = Math.max(0, lines.length - maxVisible);
		this.assistantScroll = Math.min(this.assistantScroll, maxScroll);
		const visible = lines.slice(this.assistantScroll, this.assistantScroll + maxVisible);
		const status = `  (${this.assistantScroll + 1}-${Math.min(lines.length, this.assistantScroll + maxVisible)}/${lines.length})`;

		return [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold("  Turn Reply"), width),
			padToWidth(this.theme.fg("dim", "  ↑↓/jk scroll · PgUp/PgDn page · gg/G boundary · Tab/q/Esc return"), width),
			padToWidth(this.theme.fg("accent", `  ${formatTurnInsight(row.node.insight)}`), width),
			padToWidth(this.theme.fg("muted", `  ${activityText(row)}`), width),
			this.renderBorder(width),
			"",
			...visible.map((line) => padToWidth(` ${line}`, width)),
			padToWidth(this.theme.fg("muted", status), width),
			"",
			this.renderBorder(width),
		];
	}

	private handleDrillViewInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.input.tab") ||
			this.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, "q")
		) {
			this.pendingG = false;
			this.drillView = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "g")) {
			if (this.pendingG) this.drillSelected = 0;
			this.pendingG = !this.pendingG;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("g")) || data === "G") {
			this.pendingG = false;
			this.drillSelected = this.drillRows.length - 1;
			this.tui.requestRender();
			return;
		}
		this.pendingG = false;
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.drillSelected = Math.max(0, this.drillSelected - 1);
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.drillSelected = Math.min(this.drillRows.length - 1, this.drillSelected + 1);
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.drillSelected = Math.max(0, this.drillSelected - this.maxVisibleRows());
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.drillSelected = Math.min(this.drillRows.length - 1, this.drillSelected + this.maxVisibleRows());
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const target = this.drillRows[this.drillSelected];
			if (target) this.done({ type: "navigate", targetId: target.entryId, state: this.state() });
			return;
		}
		this.tui.requestRender();
	}

	private renderDrillView(width: number): string[] {
		const rows = this.drillRows;
		if (rows.length === 0) {
			this.drillView = false;
			return this.render(width);
		}
		const maxVisible = this.maxVisibleRows();
		const start = Math.max(0, Math.min(this.drillSelected - Math.floor(maxVisible / 2), rows.length - maxVisible));
		const digits = Math.max(2, String(rows.length).length);
		const turn = this.selectedRow();
		const turnLabel = turn ? compactText(userText(turn.node.user), 90) : "";
		const lines = rows.slice(start, start + maxVisible).map((row, offset) => {
			const index = start + offset;
			const isSelected = index === this.drillSelected;
			const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const number = this.theme.fg("muted", `${String(index + 1).padStart(digits, "0")} `);
			const roleText = row.role.length >= 10 ? row.role : row.role + " ".repeat(10 - row.role.length);
			const role = this.theme.fg(roleColor(row.role), roleText);
			const tool = row.tool ? this.theme.fg("accent", `[${row.tool}] `) : "";
			const path = row.path ? this.theme.fg("dim", `(${row.path}) `) : "";
			const err = row.isError ? this.theme.fg("error", "! ") : "";
			const text = truncateToWidth(compactText(row.text, 200), Math.max(1, width - 30), "…");
			const line = `${cursor}${number}${role}${tool}${path}${err}${text}`;
			return isSelected ? this.theme.bg("selectedBg", padToWidth(line, width)) : padToWidth(line, width);
		});

		return [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold("  Turn Entries"), width),
			padToWidth(this.theme.fg("dim", `  turn: ${turnLabel}`), width),
			padToWidth(this.theme.fg("dim", "  ↑↓/jk move · Enter jump · gg/G boundary · Tab/q/Esc return"), width),
			this.renderBorder(width),
			"",
			...lines,
			...Array.from({ length: Math.max(0, maxVisible - lines.length) }, () => ""),
			padToWidth(this.theme.fg("muted", `  (${this.drillSelected + 1}/${rows.length})`), width),
			"",
			this.renderBorder(width),
		];
	}

	private finishSearch(): void {
		this.query = this.searchInput.getValue();
		this.searching = false;
		this.searchInput.focused = false;
		this.ensureSelection();
		this.tui.requestRender();
	}

	private visibleRows(): TurnRow[] {
		const rows = this.getVisibleRowsSnapshot();
		this.ensureSelection(rows);
		return rows;
	}

	private ensureSelection(rows = this.getVisibleRowsSnapshot()): void {
		if (rows.some((row) => row.node.user.entry.id === this.selectedId)) return;
		const deepestActive = rows.filter((row) => this.isActive(row)).at(-1);
		this.selectedId = deepestActive?.node.user.entry.id ?? rows[0]?.node.user.entry.id;
	}

	private getVisibleRowsSnapshot(): TurnRow[] {
		const query = this.query.trim();
		if (
			this.cachedVisibleRows &&
			this.cachedQuery === query &&
			this.cachedFilterMode === this.filterMode &&
			this.cachedRowsVersion === this.rowsVersion
		) {
			return this.cachedVisibleRows;
		}

		const rows = !query && this.filterMode === "all"
			? this.rows
			: flattenTurnForest(
				filterTurnForest(
					this.forest,
					(node) => matchesTurnFilter(node, this.filterMode, this.activeIds) && matchesTurnQuery(node, query),
				),
				this.collapsedIds,
				this.activeIds,
			);
		this.cachedVisibleRows = rows;
		this.cachedQuery = query;
		this.cachedFilterMode = this.filterMode;
		this.cachedRowsVersion = this.rowsVersion;
		return rows;
	}

	private selectedRow(): TurnRow | undefined {
		return this.getVisibleRowsSnapshot().find((row) => row.node.user.entry.id === this.selectedId);
	}

	private moveSelection(offset: number): void {
		const rows = this.visibleRows();
		const index = rows.findIndex((row) => row.node.user.entry.id === this.selectedId);
		const next = rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
		if (next) this.selectedId = next.node.user.entry.id;
		this.tui.requestRender();
	}

	private moveToBoundary(boundary: "first" | "last"): void {
		const rows = this.visibleRows();
		const target = boundary === "first" ? rows[0] : rows.at(-1);
		if (target) this.selectedId = target.node.user.entry.id;
		this.tui.requestRender();
	}

	private toggleSelected(): void {
		const row = this.selectedRow();
		if (!row || row.node.children.length === 0) return;
		if (row.collapsed) this.collapsedIds.delete(row.node.user.entry.id);
		else this.collapsedIds.add(row.node.user.entry.id);
		this.rebuildRows();
		this.tui.requestRender();
	}

	private foldOrPreviousBranch(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.node.children.length > 0 && !row.collapsed) {
			this.toggleSelected();
			return;
		}
		const rows = this.visibleRows();
		const index = rows.findIndex((candidate) => candidate.node.user.entry.id === this.selectedId);
		const previous = rows.slice(0, Math.max(0, index)).reverse().find((candidate) => candidate.showConnector);
		if (previous) this.selectedId = previous.node.user.entry.id;
		this.tui.requestRender();
	}

	private unfoldOrNextBranch(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.collapsed) {
			this.toggleSelected();
			return;
		}
		const rows = this.visibleRows();
		const index = rows.findIndex((candidate) => candidate.node.user.entry.id === this.selectedId);
		const next = rows.slice(index + 1).find((candidate) => candidate.showConnector) ?? rows.at(-1);
		if (next) this.selectedId = next.node.user.entry.id;
		this.tui.requestRender();
	}

	private cycleFilter(direction: 1 | -1): void {
		const modes: OutlineFilterMode[] = ["all", "active", "labeled", "branches"];
		const index = modes.indexOf(this.filterMode);
		this.setFilterMode(modes[(index + direction + modes.length) % modes.length]!);
	}

	private setFilterMode(mode: OutlineFilterMode): void {
		this.filterMode = mode;
		this.invalidateVisibleRows();
		this.ensureSelection();
		this.tui.requestRender();
	}

	private rebuildRows(): void {
		this.rows = flattenTurnForest(this.forest, this.collapsedIds, this.activeIds);
		this.rowsVersion++;
		this.invalidateVisibleRows();
		this.ensureSelection();
	}

	private invalidateVisibleRows(): void {
		this.cachedVisibleRows = undefined;
	}

	private renderRows(width: number, maxRows: number, rows: TurnRow[], selectedIndex: number): string[] {
		if (rows.length === 0) return [padToWidth(this.theme.fg("muted", "  No turns found"), width)];
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), rows.length - maxRows));
		const digits = Math.max(3, String(rows.length).length);
		const lines = rows.slice(start, start + maxRows).map((row, offset) => {
			const id = row.node.user.entry.id;
			const isSelected = id === this.selectedId;
			const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const connectorVisible = row.showConnector && !row.isVirtualRootChild;
			const prefix = this.theme.fg("dim", rowPrefix(row));
			const foldMarker = row.collapsed && !connectorVisible ? this.theme.fg("accent", "⊞ ") : "";
			const activeMarker = this.isActive(row) ? this.theme.fg("accent", "• ") : "";
			const number = this.theme.fg("muted", `${String(start + offset + 1).padStart(digits, "0")} `);
			const label = row.node.user.label ? this.theme.fg("warning", `[${row.node.user.label}] `) : "";
			const glyphs = turnStatusGlyphs(row.node);
			const bodyPrefix = `${cursor}${prefix}${foldMarker}${activeMarker}${number}${label}${glyphs ? this.theme.fg("muted", `${glyphs} `) : ""}`;
			const line = `${bodyPrefix}${truncateToWidth(compactText(userText(row.node.user)), Math.max(1, width - visibleWidth(bodyPrefix)), "…")}`;
			return isSelected ? this.theme.bg("selectedBg", padToWidth(line, width)) : padToWidth(line, width);
		});
		return [...lines, ...Array.from({ length: Math.max(0, maxRows - lines.length) }, () => "")];
	}

	private renderDetail(width: number): string[] {
		const row = this.selectedRow();
		const replyPrefix = this.theme.fg("success", "  assistant: ");
		const replyText = row?.node.assistant ? compactText(messageText(row.node.assistant), 10_000) : "(no final assistant reply)";
		const reply = truncateToWidth(replyText, Math.max(1, width - visibleWidth(replyPrefix)), "…");
		const insightPrefix = this.theme.fg("accent", "  insight: ");
		const insight = row ? formatTurnInsight(row.node.insight) : "(none)";
		return [
			padToWidth(`${replyPrefix}${reply}`, width),
			padToWidth(`${insightPrefix}${truncateToWidth(insight, Math.max(1, width - visibleWidth(insightPrefix)), "…")}`, width),
		];
	}

	private renderBorder(width: number): string {
		return new DynamicBorder((value: string) => this.theme.fg("border", value)).render(width)[0] ?? "";
	}

	private isActive(row: TurnRow): boolean {
		return this.activeIds.has(row.node.user.entry.id);
	}

	private state(): OutlineState {
		return {
			selectedId: this.selectedId,
			query: this.query,
			collapsedIds: [...this.collapsedIds],
			filterMode: this.filterMode,
		};
	}
}
