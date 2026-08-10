import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	type Component,
	type Focusable,
	type Keybinding,
	type KeybindingsManager,
	type KeyId,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	eventTokens,
	filterEvents,
	modelAggregates,
	providerAggregates,
	scopeAggregates,
	sortRequests,
	totalsForEvents,
	trendBuckets,
} from "./aggregate.ts";
import {
	averageTokens,
	bar,
	formatCost,
	formatCount,
	formatDateTime,
	formatPath,
	formatRange,
	formatTotalsSummary,
	padLeft,
	padLine,
	padRight,
	share,
	stopLabel,
} from "./format.ts";
import { rollingRange } from "./time-range.ts";
import type {
	MetricTotals,
	ModelAggregate,
	ProviderAggregate,
	RequestSortKey,
	ScanProgress,
	ScanResult,
	ScopeAggregate,
	SortKey,
	TimeRange,
	TokenEvent,
} from "./types.ts";

export type MonitorView = "overview" | "providers" | "models" | "scope" | "requests";

type MonitorTui = {
	requestRender(): void;
	terminal: { rows: number };
};

type ListLine = {
	text: string;
	selectableIndex?: number;
};

export type ReloadEvents = (
	range: TimeRange,
	signal: AbortSignal,
	onProgress: (progress: ScanProgress) => void,
) => Promise<ScanResult>;

export type ChooseRange = (current: TimeRange) => Promise<TimeRange | undefined>;

const VIEWS: MonitorView[] = ["overview", "providers", "models", "scope", "requests"];
const VIEW_LABELS: Record<MonitorView, string> = {
	overview: "Overview",
	providers: "Providers",
	models: "Models",
	scope: "Scope",
	requests: "Requests",
};

function isProblemStop(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
}

function metricLine(totals: MetricTotals, theme: Theme): string {
	const parts = [
		`${theme.fg("accent", "Tokens")} ${formatCount(totals.tokens)}`,
		`${theme.fg("accent", "Cost")} ${formatCost(totals.cost)}`,
		`${theme.fg("accent", "Requests")} ${formatCount(totals.requests)}`,
		`${theme.fg("accent", "Avg/Req")} ${averageTokens(totals)}`,
	];
	return parts.join("  ");
}

function tokenBreakdownLine(totals: MetricTotals, theme: Theme): string {
	return [
		`${theme.fg("muted", "Input")} ${formatCount(totals.inputTokens)}`,
		`${theme.fg("muted", "Output")} ${formatCount(totals.outputTokens)}`,
		`${theme.fg("muted", "Cache R")} ${formatCount(totals.cacheReadTokens)}`,
		`${theme.fg("muted", "Cache W")} ${formatCount(totals.cacheWriteTokens)}`,
	].join("  ");
}

function compareSortLabel(sort: SortKey | RequestSortKey): string {
	if (sort === "time") return "time";
	return sort;
}

export class TokenMonitorComponent implements Component, Focusable {
	private _focused = false;
	private readonly searchInput = new Input();
	private readonly tui: MonitorTui;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly reloadEvents: ReloadEvents;
	private readonly chooseRange: ChooseRange;
	private events: TokenEvent[];
	private range: TimeRange;
	private view: MonitorView = "overview";
	private selectedIndex = 0;
	private aggregateSort: SortKey = "tokens";
	private requestSort: RequestSortKey = "time";
	private readonly expandedProviders = new Set<string>();
	private readonly expandedScopes = new Set<string>();
	private detailEvent: TokenEvent | undefined;
	private searchActive = false;
	private loading = false;
	private selectingRange = false;
	private loadingMessage = "Refreshing session data...";
	private lastError: string | undefined;
	private abortController: AbortController | undefined;

	constructor(
		tui: MonitorTui,
		theme: Theme,
		keybindings: KeybindingsManager,
		range: TimeRange,
		scan: ScanResult,
		done: () => void,
		reloadEvents: ReloadEvents,
		chooseRange: ChooseRange,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.range = range;
		this.events = scan.events;
		this.done = done;
		this.reloadEvents = reloadEvents;
		this.chooseRange = chooseRange;
		this.searchInput.setValue("");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searchActive;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (this.searchActive) {
			this.handleSearchInput(data);
			return;
		}

		const isCancel = this.matches(data, "tui.select.cancel", Key.escape);
		const isQuit = data.toLocaleLowerCase() === "q";

		if (this.loading || this.selectingRange) {
			if (isCancel || isQuit) this.abortReload();
			return;
		}

		if (isQuit) {
			this.done();
			return;
		}

		if (this.selectViewFromInput(data)) return;

		if (this.detailEvent) {
			if (isCancel || this.matches(data, "tui.input.tab", Key.tab)) {
				this.detailEvent = undefined;
				this.tui.requestRender();
			}
			return;
		}

		if (isCancel) {
			this.done();
			return;
		}
		if (data === "/") {
			this.searchActive = true;
			this.searchInput.focused = this._focused;
			this.tui.requestRender();
			return;
		}
		if (this.matches(data, "tui.select.up", Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (this.matches(data, "tui.select.down", Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (this.matches(data, "tui.select.pageUp", Key.pageUp)) {
			this.moveSelection(-this.pageStep());
			return;
		}
		if (this.matches(data, "tui.select.pageDown", Key.pageDown)) {
			this.moveSelection(this.pageStep());
			return;
		}
		if (this.matches(data, "tui.input.tab", Key.tab)) {
			this.changeView(1);
			return;
		}
		if (this.matches(data, "tui.select.confirm", Key.enter)) {
			this.activateSelection();
			return;
		}
		if (data.toLocaleLowerCase() === "s") {
			this.cycleSort();
			return;
		}
		if (data.toLocaleLowerCase() === "t") {
			void this.changeRange();
			return;
		}
		if (data.toLocaleLowerCase() === "r") {
			const nextRange = this.range.preset === "custom" ? this.range : rollingRange(this.range.preset);
			void this.refresh(nextRange);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		lines.push(this.border(safeWidth));
		lines.push(this.pad(this.theme.bold(`  Token Monitor  |  ${formatRange(this.range)}`), safeWidth));
		const filtered = this.filteredEvents();
		const totals = totalsForEvents(filtered);
		const filterLabel = this.searchInput.getValue().trim() ? `  |  Filtered ${filtered.length}/${this.events.length}` : "";
		lines.push(this.pad(`${metricLine(totals, this.theme)}${this.theme.fg("dim", filterLabel)}`, safeWidth));
		lines.push(this.pad(tokenBreakdownLine(totals, this.theme), safeWidth));
		lines.push(this.border(safeWidth));
		lines.push(this.pad(this.renderTabs(), safeWidth));
		if (this.searchActive) {
			const inputLine = this.searchInput.render(Math.max(1, safeWidth - 12))[0] ?? "";
			lines.push(this.pad(`${this.theme.fg("accent", "  Search: ")}${inputLine}`, safeWidth));
		}

		if (this.detailEvent) {
			lines.push(...this.renderDetail(this.detailEvent, safeWidth));
		} else if (this.view === "overview") {
			lines.push(...this.renderOverview(filtered, safeWidth));
		} else {
			const body = this.renderListBody(filtered, safeWidth);
			const bodyStart = lines.length;
			const bodyHeight = this.bodyHeight(bodyStart);
			const selectedLine = body.findIndex((line) => line.selectableIndex === this.selectedIndex);
			const start = selectedLine < 0
				? 0
				: Math.max(0, Math.min(Math.max(0, body.length - bodyHeight), selectedLine - Math.floor(bodyHeight / 2)));
			const visible = body.slice(start, start + bodyHeight);
			lines.push(...visible.map((line) => this.pad(line.text, safeWidth)));
			while (lines.length < bodyStart + bodyHeight) lines.push("");
			if (body.length > visible.length) {
				lines.push(this.pad(this.theme.fg("dim", `  Showing ${start + 1}-${Math.min(body.length, start + bodyHeight)} of ${body.length} lines`), safeWidth));
			}
		}

		if (this.loading || this.selectingRange) {
			lines.push(this.pad(this.theme.fg("warning", `  ${this.loadingMessage}`), safeWidth));
		}
		if (this.lastError) lines.push(this.pad(this.theme.fg("error", `  ${this.lastError}`), safeWidth));
		lines.push(this.border(safeWidth));
		lines.push(this.pad(this.footerText(), safeWidth));
		lines.push(this.border(safeWidth));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	private handleSearchInput(data: string): void {
		if (this.matches(data, "tui.select.cancel", Key.escape)) {
			this.searchActive = false;
			this.searchInput.focused = false;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		if (this.matches(data, "tui.input.submit", Key.enter)) {
			this.searchActive = false;
			this.searchInput.focused = false;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		this.searchInput.handleInput(data);
		this.clampSelection();
		this.tui.requestRender();
	}

	private matches(data: string, binding: Keybinding, fallback: KeyId): boolean {
		return this.keybindings.matches(data, binding) || matchesKey(data, fallback);
	}

	private filteredEvents(): TokenEvent[] {
		return filterEvents(this.events, this.searchInput.getValue());
	}

	private currentRowCount(): number {
		if (this.view === "providers") return providerAggregates(this.filteredEvents(), this.aggregateSort).length;
		if (this.view === "models") return modelAggregates(this.filteredEvents(), this.aggregateSort).length;
		if (this.view === "scope") return scopeAggregates(this.filteredEvents(), this.aggregateSort).length;
		if (this.view === "requests") return this.filteredEvents().length;
		return 0;
	}

	private clampSelection(): void {
		const count = this.currentRowCount();
		this.selectedIndex = count === 0 ? 0 : Math.max(0, Math.min(count - 1, this.selectedIndex));
	}

	private moveSelection(delta: number): void {
		const count = this.currentRowCount();
		if (count === 0) return;
		this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.tui.requestRender();
	}

	private pageStep(): number {
		return Math.max(1, this.terminalRows() - 14);
	}

	private selectView(view: MonitorView): void {
		this.view = view;
		this.selectedIndex = 0;
		this.detailEvent = undefined;
		this.tui.requestRender();
	}

	private selectViewFromInput(data: string): boolean {
		if (!/^[1-5]$/.test(data)) return false;
		const view = VIEWS[Number(data) - 1];
		if (!view) return false;
		this.selectView(view);
		return true;
	}

	private changeView(delta: number): void {
		const index = VIEWS.indexOf(this.view);
		const view = VIEWS[(index + VIEWS.length + delta) % VIEWS.length] ?? "overview";
		this.selectView(view);
	}

	private activateSelection(): void {
		if (this.view === "providers") {
			const row = providerAggregates(this.filteredEvents(), this.aggregateSort)[this.selectedIndex];
			if (!row) return;
			if (this.expandedProviders.has(row.key)) this.expandedProviders.delete(row.key);
			else this.expandedProviders.add(row.key);
			this.tui.requestRender();
			return;
		}
		if (this.view === "scope") {
			const row = scopeAggregates(this.filteredEvents(), this.aggregateSort)[this.selectedIndex];
			if (!row) return;
			if (this.expandedScopes.has(row.key)) this.expandedScopes.delete(row.key);
			else this.expandedScopes.add(row.key);
			this.tui.requestRender();
			return;
		}
		if (this.view === "requests") {
			this.detailEvent = sortRequests(this.filteredEvents(), this.requestSort)[this.selectedIndex];
			this.tui.requestRender();
		}
	}

	private cycleSort(): void {
		if (this.view === "requests") {
			const order: RequestSortKey[] = ["time", "tokens", "cost"];
			const index = order.indexOf(this.requestSort);
			this.requestSort = order[(index + 1) % order.length] ?? "time";
		} else {
			const order: SortKey[] = ["tokens", "cost", "requests"];
			const index = order.indexOf(this.aggregateSort);
			this.aggregateSort = order[(index + 1) % order.length] ?? "tokens";
		}
		this.clampSelection();
		this.tui.requestRender();
	}

	private async changeRange(): Promise<void> {
		this.selectingRange = true;
		this.loadingMessage = "Selecting time range...";
		this.tui.requestRender();
		try {
			const next = await this.chooseRange(this.range);
			if (next) await this.refresh(next);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.selectingRange = false;
			this.tui.requestRender();
		}
	}

	private async refresh(range: TimeRange): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.lastError = undefined;
		this.loadingMessage = "Refreshing session data...";
		const controller = new AbortController();
		this.abortController = controller;
		this.tui.requestRender();
		try {
			const next = await this.reloadEvents(range, controller.signal, (progress) => {
				this.loadingMessage = progress.phase === "discovering"
					? "Finding session files..."
					: `Scanning sessions ${progress.loaded}/${progress.total}...`;
				this.tui.requestRender();
			});
			if (!controller.signal.aborted) {
				this.events = next.events;
				this.range = range;
				this.selectedIndex = 0;
				this.detailEvent = undefined;
			}
		} catch (error) {
			if (!controller.signal.aborted) this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.abortController === controller) this.abortController = undefined;
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private abortReload(): void {
		if (this.loading || this.selectingRange) {
			this.abortController?.abort();
			this.selectingRange = false;
			this.loading = false;
			this.loadingMessage = "Refresh cancelled.";
			this.tui.requestRender();
			return;
		}
		this.done();
	}

	private renderTabs(): string {
		return VIEWS.map((view, index) => {
			const label = `[${index + 1}] ${VIEW_LABELS[view]}`;
			return view === this.view ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("dim", label);
		}).join("  ");
	}

	private renderOverview(events: TokenEvent[], width: number): string[] {
		const lines: string[] = [this.pad(this.theme.bold("  Overview"), width)];
		if (events.length === 0) {
			lines.push(this.pad(this.theme.fg("muted", "  No attributed usage in this range."), width));
			return lines;
		}

		const providers = providerAggregates(events, "tokens");
		const models = modelAggregates(events, "tokens");
		const totals = totalsForEvents(events);
		lines.push(this.pad(this.theme.fg("dim", `  ${formatTotalsSummary(totals)}`), width));
		lines.push("");
		lines.push(this.pad(this.theme.fg("accent", "  Provider Distribution"), width));
		for (const row of providers.slice(0, 5)) {
			lines.push(this.pad(this.compactShareRow(row.provider, row.totals, totals.tokens, width), width));
		}
		if (providers.length > 5) lines.push(this.pad(this.theme.fg("dim", `  +${providers.length - 5} more providers`), width));
		lines.push("");
		lines.push(this.pad(this.theme.fg("accent", "  Model Usage"), width));
		for (const row of models.slice(0, 5)) {
			lines.push(this.pad(this.compactShareRow(`${row.provider}/${row.model}`, row.totals, totals.tokens, width), width));
		}
		if (models.length > 5) lines.push(this.pad(this.theme.fg("dim", `  +${models.length - 5} more models`), width));
		lines.push("");
		lines.push(...this.renderCostTrend(events, width));
		return lines;
	}

	private compactShareRow(label: string, rowTotals: MetricTotals, totalTokens: number, width: number): string {
		const labelWidth = Math.max(10, Math.min(30, width - 34));
		const chartWidth = Math.max(4, Math.min(18, width - labelWidth - 18));
		return `  ${padRight(label, labelWidth)} ${this.theme.fg("accent", bar(rowTotals.tokens, totalTokens, chartWidth))} ${padLeft(share(rowTotals.tokens, totalTokens), 6)} ${padLeft(formatCount(rowTotals.tokens), 8)}`;
	}

	private renderCostTrend(events: TokenEvent[], width: number): string[] {
		const lines = [this.pad(this.theme.fg("accent", "  Cost Trend"), width)];
		const buckets = trendBuckets(events, this.range);
		const nonZero = buckets.filter((bucket) => bucket.totals.cost > 0);
		if (nonZero.length === 0) {
			lines.push(this.pad(this.theme.fg("muted", "  No non-zero recorded cost in this range."), width));
			return lines;
		}
		const visible = buckets.slice(-Math.min(6, buckets.length));
		const maxCost = Math.max(...buckets.map((bucket) => bucket.totals.cost), 0);
		const barWidth = Math.max(4, Math.min(24, width - 34));
		for (const bucket of visible) {
			lines.push(this.pad(`  ${padRight(bucket.label, 13)} ${this.theme.fg("accent", bar(bucket.totals.cost, maxCost, barWidth))} ${padLeft(formatCost(bucket.totals.cost), 9)}`, width));
		}
		if (buckets.length > visible.length) lines.push(this.pad(this.theme.fg("dim", `  +${buckets.length - visible.length} earlier buckets`), width));
		return lines;
	}

	private renderListBody(events: TokenEvent[], width: number): ListLine[] {
		if (this.view === "providers") return this.renderProviders(events, width);
		if (this.view === "models") return this.renderModels(events, width);
		if (this.view === "scope") return this.renderScopes(events, width);
		return this.renderRequests(events, width);
	}

	private renderProviders(events: TokenEvent[], width: number): ListLine[] {
		const rows = providerAggregates(events, this.aggregateSort);
		const lines: ListLine[] = [{ text: this.tableHeader("NAME", width) }];
		for (const [index, row] of rows.entries()) {
			const expanded = this.expandedProviders.has(row.key);
			lines.push({ text: this.providerRow(row, width, index === this.selectedIndex, expanded), selectableIndex: index });
			if (expanded) {
				for (const model of row.models) lines.push({ text: this.modelChildRow(model, width) });
			}
		}
		if (rows.length === 0) lines.push({ text: this.theme.fg("muted", "  No providers match this range or search.") });
		return lines;
	}

	private renderModels(events: TokenEvent[], width: number): ListLine[] {
		const rows = modelAggregates(events, this.aggregateSort);
		const lines: ListLine[] = [{ text: this.tableHeader("MODEL", width) }];
		for (const [index, row] of rows.entries()) {
			const cursor = index === this.selectedIndex ? this.theme.fg("accent", "> ") : "  ";
			if (width < 64) {
				lines.push({ text: `${cursor}${padRight(`${row.provider}/${row.model}`, Math.max(12, width - 34))} ${padLeft(formatCount(row.totals.tokens), 9)} ${padLeft(formatCost(row.totals.cost), 9)}`, selectableIndex: index });
			} else {
				lines.push({ text: `${cursor}${padRight(`${row.provider}/${row.model}`, width - 37)} ${padLeft(formatCount(row.totals.tokens), 10)} ${padLeft(formatCost(row.totals.cost), 10)} ${padLeft(formatCount(row.totals.requests), 7)}`, selectableIndex: index });
			}
		}
		if (rows.length === 0) lines.push({ text: this.theme.fg("muted", "  No models match this range or search.") });
		return lines;
	}

	private renderScopes(events: TokenEvent[], width: number): ListLine[] {
		const rows = scopeAggregates(events, this.aggregateSort);
		const lines: ListLine[] = [{ text: this.tableHeader("SCOPE", width) }];
		for (const [index, row] of rows.entries()) {
			const expanded = this.expandedScopes.has(row.key);
			lines.push({ text: this.scopeRow(row, width, index === this.selectedIndex, expanded), selectableIndex: index });
			if (expanded) {
				for (const provider of row.providers) lines.push({ text: this.providerChildRow(provider, width) });
			}
		}
		if (rows.length === 0) lines.push({ text: this.theme.fg("muted", "  No scopes match this range or search.") });
		return lines;
	}

	private renderRequests(events: TokenEvent[], width: number): ListLine[] {
		const rows = sortRequests(events, this.requestSort);
		const lines: ListLine[] = [{ text: this.tableHeader("TIME", width) }];
		for (const [index, event] of rows.entries()) lines.push({ text: this.requestRow(event, width, index === this.selectedIndex), selectableIndex: index });
		if (rows.length === 0) lines.push({ text: this.theme.fg("muted", "  No requests match this range or search.") });
		return lines;
	}

	private tableHeader(label: string, width: number): string {
		if (this.view === "requests") return this.theme.fg("dim", `  ${padRight(label, 14)} ${padRight("MODEL", Math.max(12, width - 42))} ${padLeft("TOKENS", 9)} ${padLeft("COST", 9)} ${padLeft("STOP", 10)}`);
		if (this.view === "scope") return this.theme.fg("dim", `  ${padRight(label, Math.max(16, width - 39))} ${padLeft("TOKENS", 10)} ${padLeft("COST", 10)} ${padLeft("REQ", 7)}`);
		return this.theme.fg("dim", `  ${padRight(label, Math.max(16, width - 39))} ${padLeft("TOKENS", 10)} ${padLeft("COST", 10)} ${padLeft("REQ", 7)}`);
	}

	private providerRow(row: ProviderAggregate, width: number, selected: boolean, expanded: boolean): string {
		const cursor = selected ? this.theme.fg("accent", "> ") : "  ";
		const toggle = expanded ? "v" : ">";
		const nameWidth = Math.max(16, width - 39);
		return `${cursor}${this.theme.fg("accent", `${toggle} ${padRight(row.provider, nameWidth - 2)}`)} ${padLeft(formatCount(row.totals.tokens), 10)} ${padLeft(formatCost(row.totals.cost), 10)} ${padLeft(formatCount(row.totals.requests), 7)}`;
	}

	private modelChildRow(row: { model: string; provider: string; totals: MetricTotals }, width: number): string {
		const nameWidth = Math.max(16, width - 39);
		return `    ${padRight(row.model, nameWidth - 4)} ${padLeft(formatCount(row.totals.tokens), 10)} ${padLeft(formatCost(row.totals.cost), 10)} ${padLeft(formatCount(row.totals.requests), 7)}`;
	}

	private providerChildRow(row: ProviderAggregate, width: number): string {
		const nameWidth = Math.max(16, width - 39);
		return `    ${padRight(row.provider, nameWidth - 4)} ${padLeft(formatCount(row.totals.tokens), 10)} ${padLeft(formatCost(row.totals.cost), 10)} ${padLeft(formatCount(row.totals.requests), 7)}`;
	}

	private scopeRow(row: ScopeAggregate, width: number, selected: boolean, expanded: boolean): string {
		const cursor = selected ? this.theme.fg("accent", "> ") : "  ";
		const toggle = expanded ? "v" : ">";
		const nameWidth = Math.max(16, width - 39);
		return `${cursor}${this.theme.fg("accent", `${toggle} ${padRight(formatPath(row.scope, nameWidth - 2), nameWidth - 2)}`)} ${padLeft(formatCount(row.totals.tokens), 10)} ${padLeft(formatCost(row.totals.cost), 10)} ${padLeft(formatCount(row.totals.requests), 7)}`;
	}

	private requestRow(event: TokenEvent, width: number, selected: boolean): string {
		const cursor = selected ? this.theme.fg("accent", "> ") : "  ";
		const modelWidth = Math.max(12, width - 43);
		const stop = stopLabel(event.stopReason);
		const stopText = isProblemStop(event.stopReason) ? this.theme.fg("warning", stop) : this.theme.fg("dim", stop);
		return `${cursor}${padRight(formatDateTime(event.timestampMs), 14)} ${padRight(truncateToWidth(`${event.provider}/${event.model}`, modelWidth, "..."), modelWidth)} ${padLeft(formatCount(eventTokens(event)), 9)} ${padLeft(formatCost(event.cost), 9)} ${padLeft(stopText, 10)}`;
	}

	private renderDetail(event: TokenEvent, width: number): string[] {
		const lines = [
			this.pad(this.theme.bold("  Request Detail"), width),
			this.pad(this.theme.fg("dim", "  Persisted assistant usage from Pi session JSONL."), width),
			"",
			this.detailLine("Timestamp", formatDateTime(event.timestampMs), width),
			this.detailLine("Provider", event.provider, width),
			this.detailLine("Model", event.model, width),
		];
		if (event.requestedModel) lines.push(this.detailLine("Requested", event.requestedModel, width));
		lines.push(
			this.detailLine("Scope", formatPath(event.scope, Math.max(16, width - 16)), width),
			this.detailLine("Input", formatCount(event.inputTokens), width),
			this.detailLine("Output", formatCount(event.outputTokens), width),
			this.detailLine("Cache Read", formatCount(event.cacheReadTokens), width),
			this.detailLine("Cache Write", formatCount(event.cacheWriteTokens), width),
			this.detailLine("Total Tokens", formatCount(eventTokens(event)), width),
			this.detailLine("Cost", formatCost(event.cost), width),
			this.detailLine("Stop Reason", stopLabel(event.stopReason), width),
			this.detailLine("Session", event.sessionId, width),
			this.detailLine("Entry", event.entryId, width),
			this.detailLine("File", formatPath(event.sessionFile, Math.max(16, width - 16)), width),
			"",
			this.pad(this.theme.fg("dim", "  Esc/Tab back"), width),
		);
		return lines;
	}

	private detailLine(label: string, value: string, width: number): string {
		const labelText = this.theme.fg("accent", `  ${padRight(label, 14)}`);
		return this.pad(`${labelText}${truncateToWidth(value, Math.max(1, width - 16), "...")}`, width);
	}

	private footerText(): string {
		if (this.detailEvent) return this.theme.fg("dim", "  Esc/Tab back");
		const sort = compareSortLabel(this.view === "requests" ? this.requestSort : this.aggregateSort);
		return this.theme.fg("dim", `  Up/Down navigate  Enter expand  1-5 tabs  / search  s sort:${sort}  t range  r refresh  q quit`);
	}

	private border(width: number): string {
		return this.theme.fg("border", "-".repeat(Math.max(1, width)));
	}

	private pad(text: string, width: number): string {
		return padLine(text, width);
	}

	private bodyHeight(headerLines: number): number {
		return Math.max(5, this.terminalRows() - headerLines - 4);
	}

	private terminalRows(): number {
		return Math.max(16, this.tui.terminal.rows || 24);
	}
}
