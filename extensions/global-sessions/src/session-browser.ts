import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	type Component,
	type Focusable,
	type KeybindingsManager,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { limitText, normalizeText } from "./session-json.ts";
import { filterSessions, findMatchSnippet, sessionTitle } from "./session-search.ts";
import {
	buildProjectGroups,
	defaultCollapsedProjects,
	flattenProjectGroups,
	projectRowKey,
	type ProjectGroup,
	type SessionTreeRow,
} from "./session-tree.ts";
import type {
	BrowserAction,
	BrowserState,
	GlobalSession,
	SessionScanResult,
	SessionTranscript,
	TranscriptMessage,
} from "./types.ts";

type BrowserTui = {
	requestRender(): void;
	terminal: { rows: number };
};

type BrowserView = "list" | "summary-loading" | "summary" | "transcript" | "transcript-loading";

type TranscriptCursor = {
	messageIndex: number;
	chunkIndex: number;
};

type LoadTranscript = (path: string, signal: AbortSignal) => Promise<SessionTranscript>;

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function formatDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function roleLabel(message: TranscriptMessage): string {
	switch (message.role) {
		case "user":
			return "You";
		case "assistant":
			return "Pi";
		case "custom":
			return "Extension";
		case "summary":
			return "Context summary";
	}
}

export class SessionBrowserComponent implements Component, Focusable {
	private _focused = false;
	private readonly searchInput = new Input();
	private filtered: GlobalSession[] = [];
	private projects: ProjectGroup[] = [];
	private rows: SessionTreeRow[] = [];
	private collapsedProjects = new Set<string>();
	private selectedKey: string | undefined;
	private view: BrowserView;
	private transcript: SessionTranscript | undefined;
	private transcriptPath: string | undefined;
	private transcriptError: string | undefined;
	private transcriptCursor: TranscriptCursor = { messageIndex: 0, chunkIndex: 0 };
	private transcriptAbort: AbortController | undefined;
	private loadingReturnView: "list" | "summary" = "summary";
	private renderWidth = 80;
	private readonly tui: BrowserTui;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly sessions: readonly GlobalSession[];
	private readonly scan: Pick<SessionScanResult, "totalFiles" | "skippedFiles">;
	private readonly done: (action: BrowserAction) => void;
	private readonly loadTranscript: LoadTranscript;
	private readonly currentCwd: string;

	constructor(
		tui: BrowserTui,
		theme: Theme,
		keybindings: KeybindingsManager,
		sessions: readonly GlobalSession[],
		scan: Pick<SessionScanResult, "totalFiles" | "skippedFiles">,
		done: (action: BrowserAction) => void,
		loadTranscript: LoadTranscript,
		currentCwd: string,
		state: BrowserState = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.sessions = sessions;
		this.scan = scan;
		this.done = done;
		this.loadTranscript = loadTranscript;
		this.currentCwd = currentCwd;
		this.searchInput.setValue(state.query ?? "");
		this.view = state.view ?? "list";
		this.selectedKey = state.selectedKey;
		this.collapsedProjects = new Set(state.collapsedProjects ?? defaultCollapsedProjects(buildProjectGroups(sessions, currentCwd)));
		this.refreshMatches();
		if (!this.selectedRow()) this.selectInitialRow();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.view === "list";
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		switch (this.view) {
			case "list":
				this.handleListInput(data);
				return;
			case "summary":
				this.handleSummaryInput(data);
				return;
			case "transcript":
				this.handleTranscriptInput(data);
				return;
			case "summary-loading":
			case "transcript-loading":
				this.handleLoadingInput(data);
		}
	}

	render(width: number): string[] {
		switch (this.view) {
			case "summary":
				return this.renderSummary(width);
			case "transcript":
				return this.renderTranscript(width);
			case "summary-loading":
				return this.renderBranchLoading(width, "Loading Session Preview", "Reading the current resumable branch…");
			case "transcript-loading":
				return this.renderBranchLoading(width, "Session Transcript", "Loading the current resumable branch…");
			default:
				return this.renderList(width);
		}
	}

	private handleListInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refreshMatches();
				this.tui.requestRender();
			} else {
				this.done(undefined);
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-this.maxVisibleRows());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(this.maxVisibleRows());
			return;
		}
		if (matchesKey(data, "left") || this.keybindings.matches(data, "app.tree.foldOrUp")) {
			this.collapseSelection();
			return;
		}
		if (matchesKey(data, "right") || this.keybindings.matches(data, "app.tree.unfoldOrDown")) {
			this.expandSelection();
			return;
		}
		if (matchesKey(data, "space")) {
			this.toggleSelectedProject();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.selectedRow()?.kind === "session") this.openSummary();
			return;
		}

		this.searchInput.handleInput(data);
		this.refreshMatches();
		this.tui.requestRender();
	}

	private handleSummaryInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.view = "list";
			this.searchInput.focused = this._focused;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.openTranscript();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const session = this.selectedSession();
			if (session) this.done({ type: "resume", session, state: this.state() });
		}
	}

	private handleLoadingInput(data: string): void {
		if (!this.keybindings.matches(data, "tui.select.cancel")) return;
		this.transcriptAbort?.abort();
		this.transcriptAbort = undefined;
		this.view = this.loadingReturnView;
		this.searchInput.focused = this._focused && this.view === "list";
		this.tui.requestRender();
	}

	private handleTranscriptInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "tui.input.tab")) {
			this.view = "summary";
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveTranscript(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveTranscript(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveTranscript(-this.transcriptPageStep());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveTranscript(this.transcriptPageStep());
			return;
		}
		if (data === "g") {
			this.transcriptCursor = { messageIndex: 0, chunkIndex: 0 };
			this.tui.requestRender();
			return;
		}
		if (data === "G") {
			this.transcriptCursor = this.lastTranscriptCursor(this.renderWidth);
			this.tui.requestRender();
		}
	}

	private refreshMatches(): void {
		this.filtered = filterSessions(this.sessions, this.searchInput.getValue());
		this.projects = buildProjectGroups(this.filtered, this.currentCwd);
		this.rows = flattenProjectGroups(this.projects, this.collapsedProjects, this.searchInput.getValue().trim().length > 0);
		if (!this.selectedRow()) this.selectInitialRow();
	}

	private selectInitialRow(): void {
		const currentSession = this.rows.find((row) => row.kind === "session" && row.project.isCurrent);
		this.selectedKey = currentSession?.key ?? this.rows[0]?.key;
	}

	private selectedRow(): SessionTreeRow | undefined {
		return this.rows.find((row) => row.key === this.selectedKey);
	}

	private selectedSession(): GlobalSession | undefined {
		const row = this.selectedRow();
		return row?.kind === "session" ? row.session : undefined;
	}

	private moveSelection(offset: number): void {
		if (this.rows.length === 0) return;
		const current = Math.max(0, this.rows.findIndex((row) => row.key === this.selectedKey));
		const next = Math.max(0, Math.min(this.rows.length - 1, current + offset));
		this.selectedKey = this.rows[next]?.key;
		this.tui.requestRender();
	}

	private toggleSelectedProject(): void {
		const row = this.selectedRow();
		if (row?.kind !== "project" || this.searchInput.getValue().trim()) return;
		if (this.collapsedProjects.has(row.project.key)) this.collapsedProjects.delete(row.project.key);
		else this.collapsedProjects.add(row.project.key);
		this.refreshMatches();
		this.selectedKey = row.key;
		this.tui.requestRender();
	}

	private collapseSelection(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.kind === "session") {
			this.selectedKey = projectRowKey(row.project.key);
			this.tui.requestRender();
			return;
		}
		if (this.searchInput.getValue().trim() || this.collapsedProjects.has(row.project.key)) return;
		this.collapsedProjects.add(row.project.key);
		this.refreshMatches();
		this.selectedKey = row.key;
		this.tui.requestRender();
	}

	private expandSelection(): void {
		const row = this.selectedRow();
		if (row?.kind !== "project" || this.searchInput.getValue().trim() || !this.collapsedProjects.has(row.project.key)) return;
		this.collapsedProjects.delete(row.project.key);
		this.refreshMatches();
		this.selectedKey = row.key;
		this.tui.requestRender();
	}

	private openSummary(): void {
		const session = this.selectedSession();
		if (!session) return;
		if (this.currentTranscript(session)) {
			this.view = "summary";
			this.searchInput.focused = false;
			this.tui.requestRender();
			return;
		}
		this.loadBranch(session, "summary-loading", "list");
	}

	private openTranscript(): void {
		const session = this.selectedSession();
		if (!session) return;
		if (this.currentTranscript(session)) {
			this.view = "transcript";
			this.tui.requestRender();
			return;
		}
		this.loadBranch(session, "transcript-loading", "summary");
	}

	private currentTranscript(session: GlobalSession): SessionTranscript | undefined {
		return this.transcriptPath === session.path ? this.transcript : undefined;
	}

	private loadBranch(
		session: GlobalSession,
		loadingView: "summary-loading" | "transcript-loading",
		returnView: "list" | "summary",
	): void {
		this.transcriptError = undefined;
		this.view = loadingView;
		this.loadingReturnView = returnView;
		this.transcriptAbort?.abort();
		const controller = new AbortController();
		this.transcriptAbort = controller;
		this.tui.requestRender();

		void this.loadTranscript(session.path, controller.signal)
			.then((transcript) => {
				if (controller.signal.aborted || this.transcriptAbort !== controller) return;
				this.transcript = transcript;
				this.transcriptPath = session.path;
				this.transcriptCursor = { messageIndex: 0, chunkIndex: 0 };
				this.view = loadingView === "summary-loading" ? "summary" : "transcript";
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || this.transcriptAbort !== controller) return;
				this.transcriptError = error instanceof Error ? error.message : String(error);
				this.view = "summary";
			})
			.finally(() => {
				if (this.transcriptAbort === controller) this.transcriptAbort = undefined;
				this.tui.requestRender();
			});
	}

	private moveTranscript(offset: number): void {
		let cursor = this.normalizedTranscriptCursor(this.transcriptCursor, this.renderWidth);
		const step = offset < 0 ? -1 : 1;
		for (let index = 0; index < Math.abs(offset); index++) {
			const next = step > 0
				? this.nextTranscriptCursor(cursor, this.renderWidth)
				: this.previousTranscriptCursor(cursor, this.renderWidth);
			if (!next) break;
			cursor = next;
		}
		this.transcriptCursor = cursor;
		this.tui.requestRender();
	}

	private renderList(width: number): string[] {
		const selectedIndex = Math.max(0, this.rows.findIndex((row) => row.key === this.selectedKey));
		const queryLine = this.searchInput.render(Math.max(1, width - 12))[0] ?? "";
		const visibleRows = this.maxVisibleRows();
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), this.rows.length - visibleRows));
		const visible = this.rows.slice(start, start + visibleRows);
		const lines = [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold(`  Global Sessions · ${this.filtered.length}/${this.sessions.length} sessions · ${this.projects.length} projects`), width),
			padToWidth(this.theme.fg("muted", `  Search: ${queryLine}`), width),
			padToWidth(this.theme.fg("dim", "  ↑↓ select · ←→/Space collapse · Enter preview · PgUp/PgDn page · Esc clear/close"), width),
			this.renderBorder(width),
		];

		if (visible.length === 0) {
			lines.push(padToWidth(this.theme.fg("muted", "  No projects or sessions match this search."), width));
		} else {
			for (const row of visible) lines.push(this.renderTreeRow(row, width));
		}
		while (lines.length < 6 + visibleRows) lines.push("");

		const selectedText = this.rows.length === 0 ? "0/0" : `${selectedIndex + 1}/${this.rows.length}`;
		const skipped = this.scan.skippedFiles > 0 ? ` · ${this.scan.skippedFiles} skipped` : "";
		const searchState = this.searchInput.getValue().trim() ? "matching projects auto-expanded" : "current and recent projects expanded";
		lines.push(
			this.renderBorder(width),
			padToWidth(this.theme.fg("muted", `  ${selectedText} · ${searchState}${skipped}`), width),
			this.renderBorder(width),
		);
		return lines;
	}

	private renderTreeRow(row: SessionTreeRow, width: number): string {
		const selected = row.key === this.selectedKey;
		const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
		let line: string;
		if (row.kind === "project") {
			const toggle = row.expanded ? "▾" : "▸";
			const current = row.project.isCurrent ? this.theme.fg("accent", " [current]") : "";
			const metadata = this.theme.fg("dim", ` · ${row.project.sessions.length} · ${formatDate(row.project.latestActivity)}`);
			line = `${cursor}${this.theme.fg("accent", `${toggle} ${row.project.cwd}`)}${metadata}${current}`;
		} else {
			const connector = row.indexInProject === row.totalInProject - 1 ? "└─" : "├─";
			const prefix = `${cursor}  ${this.theme.fg("dim", `${connector} ${formatDate(row.session.modified)} · `)}`;
			line = `${prefix}${truncateToWidth(sessionTitle(row.session), Math.max(1, width - visibleWidth(prefix)), "…")}`;
		}
		const padded = padToWidth(line, width);
		return selected ? this.theme.bg("selectedBg", padded) : padded;
	}

	private renderSummary(width: number): string[] {
		const session = this.selectedSession();
		if (!session) {
			this.view = "list";
			return this.renderList(width);
		}
		const transcript = this.currentTranscript(session);
		const branchMessages = transcript?.messages ?? [];
		const firstPrompt = branchMessages.find((message) => message.role === "user")?.content || "(no user text on the resumable branch)";
		const lastReply = branchMessages.filter((message) => message.role === "assistant").at(-1)?.content || "(no assistant reply on the resumable branch)";
		const metadata = [
			session.cwd,
			`last active ${formatDate(session.modified)}`,
			transcript?.model ?? "current branch unavailable",
			`${session.messageCount} messages`,
		].join(" · ");
		const lines = [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold(`  Session Preview · ${sessionTitle(session)}`), width),
			padToWidth(this.theme.fg("muted", `  ${truncateToWidth(metadata, Math.max(1, width - 2), "…")}`), width),
			this.renderBorder(width),
			...this.renderSummaryBlock("First request", firstPrompt, width),
			...this.renderSummaryBlock("Latest reply", lastReply, width),
		];
		const snippet = findMatchSnippet(session, this.searchInput.getValue());
		if (snippet) lines.push(...this.renderSummaryBlock("Match", snippet, width));
		if (this.transcriptError) {
			lines.push(padToWidth(this.theme.fg("error", `  Unable to read the resumable branch: ${this.transcriptError}`), width));
		}
		lines.push(
			this.renderBorder(width),
			padToWidth(this.theme.fg("dim", "  Enter restore · Tab current branch transcript · Esc back"), width),
			this.renderBorder(width),
		);
		return lines;
	}

	private renderSummaryBlock(label: string, value: string, width: number): string[] {
		const body = limitText(normalizeText(value), 520) || "(empty)";
		const wrapped = wrapTextWithAnsi(this.theme.fg("text", body), Math.max(1, width - 4)).slice(0, 3);
		const lines = [padToWidth(this.theme.fg("accent", `  ${label}`), width)];
		lines.push(...wrapped.map((line) => padToWidth(`    ${line}`, width)));
		if (wrapped.length === 0) lines.push(padToWidth(this.theme.fg("muted", "    (empty)"), width));
		return lines;
	}

	private renderBranchLoading(width: number, title: string, message: string): string[] {
		return [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold(`  ${title}`), width),
			padToWidth(this.theme.fg("muted", `  ${message}`), width),
			padToWidth(this.theme.fg("dim", "  Esc cancels and returns to the previous view."), width),
			this.renderBorder(width),
		];
	}

	private renderTranscript(width: number): string[] {
		const transcript = this.transcript;
		if (!transcript) {
			this.view = "summary";
			return this.renderSummary(width);
		}
		this.renderWidth = width;
		const visibleLines = this.maxTranscriptLines();
		const branchNote = transcript.alternateBranchCount > 0
			? ` · ${transcript.alternateBranchCount} alternate branch${transcript.alternateBranchCount === 1 ? "" : "es"} retained`
			: "";

		if (transcript.messages.length === 0) {
			return [
				"",
				this.renderBorder(width),
				padToWidth(this.theme.bold("  Current Resumable Branch"), width),
				padToWidth(this.theme.fg("muted", `  No visible conversation text${branchNote}`), width),
				padToWidth(this.theme.fg("dim", "  Tab/Esc back"), width),
				this.renderBorder(width),
			];
		}

		this.transcriptCursor = this.normalizedTranscriptCursor(this.transcriptCursor, width);
		const page = this.renderTranscriptPage(width, visibleLines);
		const current = transcript.messages[this.transcriptCursor.messageIndex]!;
		const chunkCount = this.transcriptChunkCount(current, width);
		const status = `message ${this.transcriptCursor.messageIndex + 1}/${transcript.messages.length} · segment ${this.transcriptCursor.chunkIndex + 1}/${chunkCount}`;

		return [
			"",
			this.renderBorder(width),
			padToWidth(this.theme.bold("  Current Resumable Branch"), width),
			padToWidth(this.theme.fg("muted", `  ${transcript.messages.length} visible messages${branchNote}`), width),
			padToWidth(this.theme.fg("dim", "  ↑↓ scroll · PgUp/PgDn page · g/G boundary · Tab/Esc back"), width),
			this.renderBorder(width),
			"",
			...page,
			...Array.from({ length: Math.max(0, visibleLines - page.length) }, () => ""),
			padToWidth(this.theme.fg("muted", `  ${status}`), width),
			this.renderBorder(width),
		];
	}

	private renderTranscriptPage(width: number, maxLines: number): string[] {
		const lines: string[] = [];
		let cursor = this.normalizedTranscriptCursor(this.transcriptCursor, width);
		while (lines.length < maxLines) {
			const chunk = this.renderTranscriptChunk(cursor, width);
			if (lines.length > 0 && chunk.length > maxLines - lines.length) break;
			lines.push(...chunk);
			const next = this.nextTranscriptCursor(cursor, width);
			if (!next) break;
			cursor = next;
		}
		return lines.slice(0, maxLines);
	}

	private renderTranscriptChunk(cursor: TranscriptCursor, width: number): string[] {
		const transcript = this.transcript!;
		const message = transcript.messages[cursor.messageIndex]!;
		const chunkSize = this.transcriptChunkSize(width);
		const chunkCount = this.transcriptChunkCount(message, width);
		const rawContent = message.content || "(empty)";
		const start = cursor.chunkIndex * chunkSize;
		const content = normalizeText(rawContent.slice(start, start + chunkSize)) || "(empty)";
		const roleColor = message.role === "user" ? "accent" : message.role === "assistant" ? "success" : "muted";
		const timestamp = cursor.chunkIndex === 0 && message.timestamp
			? ` · ${message.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "")}`
			: "";
		const continuation = chunkCount > 1 ? ` · ${cursor.chunkIndex + 1}/${chunkCount}` : "";
		return [
			padToWidth(this.theme.fg(roleColor, `  ${roleLabel(message)}${continuation}${timestamp}`), width),
			padToWidth(`    ${this.theme.fg("text", content)}`, width),
			"",
		];
	}

	private transcriptChunkSize(width: number): number {
		return Math.max(8, Math.floor(Math.max(8, width - 4) / 2));
	}

	private transcriptChunkCount(message: TranscriptMessage, width: number): number {
		return Math.max(1, Math.ceil(Math.max(1, message.content.length) / this.transcriptChunkSize(width)));
	}

	private normalizedTranscriptCursor(cursor: TranscriptCursor, width: number): TranscriptCursor {
		const messages = this.transcript?.messages ?? [];
		if (messages.length === 0) return { messageIndex: 0, chunkIndex: 0 };
		const messageIndex = Math.max(0, Math.min(messages.length - 1, cursor.messageIndex));
		const chunkCount = this.transcriptChunkCount(messages[messageIndex]!, width);
		return { messageIndex, chunkIndex: Math.max(0, Math.min(chunkCount - 1, cursor.chunkIndex)) };
	}

	private nextTranscriptCursor(cursor: TranscriptCursor, width: number): TranscriptCursor | undefined {
		const messages = this.transcript?.messages ?? [];
		const normalized = this.normalizedTranscriptCursor(cursor, width);
		const chunks = this.transcriptChunkCount(messages[normalized.messageIndex]!, width);
		if (normalized.chunkIndex + 1 < chunks) return { ...normalized, chunkIndex: normalized.chunkIndex + 1 };
		if (normalized.messageIndex + 1 < messages.length) return { messageIndex: normalized.messageIndex + 1, chunkIndex: 0 };
		return undefined;
	}

	private previousTranscriptCursor(cursor: TranscriptCursor, width: number): TranscriptCursor | undefined {
		const messages = this.transcript?.messages ?? [];
		const normalized = this.normalizedTranscriptCursor(cursor, width);
		if (normalized.chunkIndex > 0) return { ...normalized, chunkIndex: normalized.chunkIndex - 1 };
		if (normalized.messageIndex === 0) return undefined;
		const messageIndex = normalized.messageIndex - 1;
		return { messageIndex, chunkIndex: this.transcriptChunkCount(messages[messageIndex]!, width) - 1 };
	}

	private lastTranscriptCursor(width: number): TranscriptCursor {
		const messages = this.transcript?.messages ?? [];
		if (messages.length === 0) return { messageIndex: 0, chunkIndex: 0 };
		const messageIndex = messages.length - 1;
		return { messageIndex, chunkIndex: this.transcriptChunkCount(messages[messageIndex]!, width) - 1 };
	}

	private transcriptPageStep(): number {
		return Math.max(1, Math.floor(this.maxTranscriptLines() / 3));
	}

	private maxVisibleRows(): number {
		return Math.max(5, Math.min(18, this.terminalRows() - 10));
	}

	private maxTranscriptLines(): number {
		return Math.max(5, this.terminalRows() - 10);
	}

	private terminalRows(): number {
		return Math.max(16, this.tui.terminal.rows || 24);
	}

	private renderBorder(width: number): string {
		return new DynamicBorder((text: string) => this.theme.fg("border", text)).render(width)[0] ?? "";
	}

	private state(): BrowserState {
		return {
			query: this.searchInput.getValue(),
			selectedKey: this.selectedKey,
			collapsedProjects: [...this.collapsedProjects],
			view: "summary",
		};
	}
}
