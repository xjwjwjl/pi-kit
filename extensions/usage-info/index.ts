/**
 * /usage
 *
 * Integrated usage view: a timeline of usage over time, with the selected
 * period's provider → model tree as a drill-down detail (Tab toggles between
 * the selected period's tree and the whole range's tree).
 *
 * Replaces the old /usage-timeline + /usage-models pair.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Key, matchesKey, Spacer, Text, type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

// ═══════════════════════════════════════════════════════════════════════════
// types
// ═══════════════════════════════════════════════════════════════════════════

type ModelKey = string;
type MeasurementMode = "tokens" | "cost" | "duration";

interface ParsedUsageEvent { at: Date; model: ModelKey; tokens: number; cost: number; durationMs: number }
interface ParsedSession { filePath: string; startedAt: Date; events: ParsedUsageEvent[] }

interface DayAgg {
	date: Date; dayKeyLocal: string; tokens: number; totalCost: number; durationMs: number;
	costByModel: Map<ModelKey, number>; tokensByModel: Map<ModelKey, number>;
	durationByModel: Map<ModelKey, number>;
}

interface RangeAgg {
	days: DayAgg[]; dayByKey: Map<string, DayAgg>; hours: DayAgg[]; hourByKey: Map<string, DayAgg>;
	totalTokens: number; totalCost: number; totalDurationMs: number;
	modelCost: Map<ModelKey, number>; modelTokens: Map<ModelKey, number>;
	modelDuration: Map<ModelKey, number>;
}

interface BreakdownData { ranges: Map<(typeof RANGE_DAYS)[number], RangeAgg> }

type BreakdownProgressPhase = "scan" | "parse" | "finalize";
interface BreakdownProgressState {
	phase: BreakdownProgressPhase; foundFiles: number; parsedFiles: number; totalFiles: number; currentFile?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// constants
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RANGE_DAYS = ["yesterday", 1, 7, 30] as const;

// ═══════════════════════════════════════════════════════════════════════════
// ANSI / formatting helpers
// ═══════════════════════════════════════════════════════════════════════════

function dim(text: string): string { return `\x1b[2m${text}\x1b[0m`; }
function bold(text: string): string { return `\x1b[1m${text}\x1b[0m`; }

function formatCount(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(2)}万`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(2)}千`;
	return n.toLocaleString("en-US");
}

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const s = Math.max(1, Math.round(ms / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
	if (m > 0) return sec > 0 ? `${m}m${sec}s` : `${m}m`;
	return `${sec}s`;
}

function formatMetric(mode: MeasurementMode, value: number): string {
	if (mode === "cost") return formatUsd(value);
	if (mode === "duration") return formatDuration(value);
	return formatCount(value);
}

function metricForDay(day: DayAgg, mode: MeasurementMode): number {
	if (mode === "cost") return day.totalCost;
	if (mode === "duration") return day.durationMs;
	return day.tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
// date / path / model helpers
// ═══════════════════════════════════════════════════════════════════════════

function localMidnight(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }

function addDaysLocal(d: Date, days: number): Date {
	const x = new Date(d); x.setDate(x.getDate() + days); return x;
}

function toLocalDayKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toLocalHourKey(d: Date): string {
	return `${toLocalDayKey(d)}T${String(d.getHours()).padStart(2, "0")}`;
}

function formatShortDate(d: Date): string {
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayLabel(d: Date): string {
	return formatShortDate(d);
}

function formatHourLabel(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function mondayIndex(date: Date): number { return (date.getDay() + 6) % 7; }

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | null {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p && !m) return null;
	if (!p) return m; if (!m) return p;
	return `${p}/${m}`;
}

function rangeLabel(days: number | "yesterday"): string {
	if (days === "yesterday") return "Yest";
	return days === 1 ? "Today" : `${days}d`;
}

function rangeSummary(range: RangeAgg, days: number | "yesterday", mode: MeasurementMode): string {
	const prefix = days === "yesterday" ? "Yesterday" : days === 1 ? "Today" : `Last ${days} days`;
	const parts = [formatCount(range.totalTokens), formatUsd(range.totalCost), formatDuration(range.totalDurationMs)];
	if (mode === "cost") return `${prefix}: ${parts[1]} · ${parts[0]} · ${parts[2]}`;
	if (mode === "duration") return `${prefix}: ${parts[2]} · ${parts[0]} · ${parts[1]}`;
	return `${prefix}: ${parts[0]} · ${parts[1]} · ${parts[2]}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// parsing
// ═══════════════════════════════════════════════════════════════════════════

function parseSessionStartFromFilename(name: string): Date | null {
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): { provider?: any; model?: any; modelId?: any; usage?: any } {
	const msg = obj?.message;
	return {
		provider: obj?.provider ?? msg?.provider, model: obj?.model ?? msg?.model,
		modelId: obj?.modelId ?? msg?.modelId, usage: obj?.usage ?? msg?.usage,
	};
}

function extractTimestampDate(obj: any): Date | null {
	const msg = obj?.message;
	const raw = obj?.timestamp ?? obj?.createdAt ?? obj?.created_at ?? msg?.timestamp ?? msg?.createdAt ?? msg?.created_at;
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	const d = new Date(raw);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractMessageRole(obj: any): string {
	return typeof obj?.role === "string" ? obj.role : typeof obj?.message?.role === "string" ? obj.message.role : "";
}

function assistantContinuesTurn(obj: any): boolean {
	const stopReason = obj?.stopReason ?? obj?.message?.stopReason;
	if (typeof stopReason === "string") {
		const n = stopReason.trim();
		if (n === "toolUse" || n === "tool_use") return true;
		if (n) return false;
	}
	const content = obj?.content ?? obj?.message?.content;
	return Array.isArray(content) && content.some((part: any) => part?.type === "toolCall");
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") { const n = Number(c); return Number.isFinite(n) ? n : 0; }
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") { const n = Number(t); return Number.isFinite(n) ? n : 0; }
	return 0;
}

function extractTokensTotal(usage: any): number {
	if (!usage) return 0;
	const n = (v: any): number => typeof v === "number" ? (Number.isFinite(v) ? v : 0) : typeof v === "string" ? (Number.isFinite(Number(v)) ? Number(v) : 0) : 0;
	let total = n(usage?.totalTokens) || n(usage?.total_tokens) || n(usage?.tokens) || n(usage?.tokenCount) || n(usage?.token_count);
	if (total > 0) return total;
	total = n(usage?.tokens?.total) || n(usage?.tokens?.totalTokens) || n(usage?.tokens?.total_tokens);
	if (total > 0) return total;
	const a = n(usage?.promptTokens) || n(usage?.prompt_tokens) || n(usage?.inputTokens) || n(usage?.input_tokens);
	const b = n(usage?.completionTokens) || n(usage?.completion_tokens) || n(usage?.outputTokens) || n(usage?.output_tokens);
	return Math.max(0, a + b);
}

async function walkSessionFiles(
	root: string, startCutoffLocal: Date, signal?: AbortSignal,
	onFound?: (found: number) => void,
): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: Dirent[] = [];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
		for (const ent of entries) {
			if (signal?.aborted) break;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) { stack.push(p); continue; }
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
			const startedAt = parseSessionStartFromFilename(ent.name);
			if (startedAt && localMidnight(startedAt) >= startCutoffLocal) { out.push(p); if (onFound && out.length % 10 === 0) onFound(out.length); continue; }
			try {
				const st = await fs.stat(p);
				if (localMidnight(new Date(st.mtimeMs)) >= startCutoffLocal) { out.push(p); if (onFound && out.length % 10 === 0) onFound(out.length); }
			} catch { /* ignore */ }
		}
	}
	onFound?.(out.length);
	return out;
}

async function parseSessionFile(filePath: string, signal?: AbortSignal): Promise<ParsedSession | null> {
	const fileName = path.basename(filePath);
	let startedAt = parseSessionStartFromFilename(fileName);
	let currentModel: ModelKey | null = null;
	let openTurnStartedAt: Date | null = null;
	const pending: Array<{ at: Date | null; model: ModelKey; tokens: number; cost: number; durationMs: number }> = [];
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (signal?.aborted) { rl.close(); stream.destroy(); return null; }
			if (!line) continue;
			let obj: any;
			try { obj = JSON.parse(line); } catch { continue; }
			if (obj?.type === "session") {
				if (!startedAt) { const d = extractTimestampDate(obj); if (d) startedAt = d; }
				continue;
			}
			if (obj?.type === "model_change") { const mk = modelKeyFromParts(obj.provider, obj.modelId); if (mk) currentModel = mk; continue; }
			if (obj?.type !== "message") continue;

			const at = extractTimestampDate(obj);
			const role = extractMessageRole(obj);
			if (role === "user") { openTurnStartedAt = at; continue; }
			if (role !== "assistant") continue;

			const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
			const mk = modelKeyFromParts(provider, model) ?? modelKeyFromParts(provider, modelId) ?? currentModel ?? "unknown";
			const tokens = extractTokensTotal(usage), cost = extractCostTotal(usage);
			let durationMs = 0;
			if (!assistantContinuesTurn(obj)) {
				if (openTurnStartedAt && at) { const el = at.getTime() - openTurnStartedAt.getTime(); durationMs = el > 0 ? el : 0; }
				openTurnStartedAt = null;
			}
			if (tokens <= 0 && cost <= 0 && durationMs <= 0) continue;
			pending.push({ at, model: mk, tokens, cost, durationMs });
		}
	} finally { rl.close(); stream.destroy(); }
	if (!startedAt) return null;
	const events = pending.map((e) => ({ at: e.at ?? startedAt!, model: e.model, tokens: e.tokens, cost: e.cost, durationMs: e.durationMs }))
		.sort((a, b) => a.at.getTime() - b.at.getTime());
	return { filePath, startedAt, events };
}

// ═══════════════════════════════════════════════════════════════════════════
// aggregation
// ═══════════════════════════════════════════════════════════════════════════

function emptyAgg(date: Date, key: string): DayAgg {
	return {
		date, dayKeyLocal: key, tokens: 0, totalCost: 0, durationMs: 0,
		costByModel: new Map(), tokensByModel: new Map(), durationByModel: new Map(),
	};
}

function buildRangeAgg(days: number | "yesterday", now: Date): RangeAgg {
	const effectiveDays = days === "yesterday" ? 1 : days;
	const offset = days === "yesterday" ? 1 : 0;
	const end = localMidnight(addDaysLocal(now, -offset));
	const start = addDaysLocal(end, -(effectiveDays - 1));
	const outDays: DayAgg[] = [], dayByKey = new Map<string, DayAgg>();
	const hours: DayAgg[] = [], hourByKey = new Map<string, DayAgg>();
	for (let i = 0; i < effectiveDays; i++) {
		const d = addDaysLocal(start, i), key = toLocalDayKey(d), day = emptyAgg(d, key);
		outDays.push(day); dayByKey.set(key, day);
	}
	if (effectiveDays === 1) {
		for (let h = 0; h < 24; h++) {
			const d = new Date(start); d.setHours(h, 0, 0, 0);
			const key = toLocalHourKey(d), bucket = emptyAgg(d, key);
			hours.push(bucket); hourByKey.set(key, bucket);
		}
	}
	return {
		days: outDays, dayByKey, hours, hourByKey, totalTokens: 0, totalCost: 0, totalDurationMs: 0,
		modelCost: new Map(), modelTokens: new Map(), modelDuration: new Map(),
	};
}

function addToBucket(b: DayAgg, e: ParsedUsageEvent): void {
	b.tokens += e.tokens; b.totalCost += e.cost; b.durationMs += e.durationMs;
	if (e.tokens > 0) b.tokensByModel.set(e.model, (b.tokensByModel.get(e.model) ?? 0) + e.tokens);
	if (e.cost > 0) b.costByModel.set(e.model, (b.costByModel.get(e.model) ?? 0) + e.cost);
	if (e.durationMs > 0) b.durationByModel.set(e.model, (b.durationByModel.get(e.model) ?? 0) + e.durationMs);
}

function addToRangeTotals(r: RangeAgg, e: ParsedUsageEvent): void {
	r.totalTokens += e.tokens; r.totalCost += e.cost; r.totalDurationMs += e.durationMs;
	if (e.tokens > 0) r.modelTokens.set(e.model, (r.modelTokens.get(e.model) ?? 0) + e.tokens);
	if (e.cost > 0) r.modelCost.set(e.model, (r.modelCost.get(e.model) ?? 0) + e.cost);
	if (e.durationMs > 0) r.modelDuration.set(e.model, (r.modelDuration.get(e.model) ?? 0) + e.durationMs);
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
	for (const e of session.events) {
		const day = range.dayByKey.get(toLocalDayKey(e.at));
		if (!day) continue;
		addToRangeTotals(range, e);
		addToBucket(day, e);
		const hour = range.hourByKey.get(toLocalHourKey(e.at));
		if (hour) addToBucket(hour, e);
	}
}

// ── pad / truncate helpers ───────────────────────────────────────────────

function padRight(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
// Visible-width padding keeps columns aligned even with double-width CJK units (万/亿/…).
function padLeftVisible(s: string, n: number): string {
	const w = visibleWidth(s);
	return w >= n ? s : " ".repeat(n - w) + s;
}
function padRightVisible(s: string, n: number): string {
	const w = visibleWidth(s);
	return w >= n ? s : s + " ".repeat(n - w);
}
function clampIndex(idx: number, length: number): number { return length <= 0 ? 0 : Math.max(0, Math.min(length - 1, idx)); }

// ── computeBreakdown ──────────────────────────────────────────────────────

async function computeBreakdown(
	signal?: AbortSignal,
	onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
	const now = new Date();
	const ranges = new Map<(typeof RANGE_DAYS)[number], RangeAgg>();
	for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
	// Only scan sessions from the last 30 days; older files are skipped.
	const range30 = ranges.get(30)!;
	const start30 = range30.days[0].date;

	onProgress?.({ phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0 });
	const candidates = await walkSessionFiles(SESSION_ROOT, start30, signal, (found) => onProgress?.({ phase: "scan", foundFiles: found }));
	const totalFiles = candidates.length;
	onProgress?.({ phase: "parse", foundFiles: totalFiles, totalFiles, parsedFiles: 0, currentFile: totalFiles > 0 ? path.basename(candidates[0]!) : undefined });

	// Parse with limited concurrency; aggregation is order-independent, so workers
	// can run in parallel and stop pulling new files once the signal aborts.
	const PARSE_CONCURRENCY = 8;
	let nextIndex = 0;
	let parsedFiles = 0;
	const parseWorker = async (): Promise<void> => {
		while (!signal?.aborted) {
			const idx = nextIndex++;
			if (idx >= totalFiles) return;
			const filePath = candidates[idx]!;
			const session = await parseSessionFile(filePath, signal);
			if (!signal?.aborted && session) {
				for (const d of RANGE_DAYS) addSessionToRange(ranges.get(d)!, session);
			}
			parsedFiles++;
			onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: path.basename(filePath) });
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, totalFiles) }, parseWorker));
	if (!signal?.aborted) onProgress?.({ phase: "finalize" });
	return { ranges };
}

// ── progress loader ───────────────────────────────────────────────────────

/**
 * Bordered, cancellable loader with a public setMessage for progress updates.
 * Mirrors the stock BorderedLoader layout without reaching into private fields.
 */
class ProgressLoader extends Container {
	private loader: CancellableLoader;
	constructor(tui: TUI, theme: Theme, message: string) {
		super();
		const borderColor = (s: string) => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.loader = new CancellableLoader(tui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), message);
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}
	get signal(): AbortSignal { return this.loader.signal; }
	set onAbort(fn: (() => void) | undefined) { this.loader.onAbort = fn; }
	setMessage(message: string): void { this.loader.setMessage(message); }
	handleInput(data: string): void { this.loader.handleInput(data); }
	dispose(): void { this.loader.dispose(); }
}

// ── shared loader helper ──────────────────────────────────────────────────

async function loadWithProgress(
	pi: ExtensionAPI, ctx: ExtensionContext, label: string,
	onDone: (data: BreakdownData, tui: TUI, theme: Theme, done: () => void) => Component,
): Promise<void> {
	if (!ctx.hasUI) {
		const data = await computeBreakdown(undefined);
		const range = data.ranges.get(30)!;
		pi.sendMessage(
			{ customType: label, content: `${label} (non-interactive)\n${rangeSummary(range, 30, "tokens")}`, display: true },
			{ triggerTurn: false },
		);
		return;
	}

	let aborted = false;
	const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
		const loader = new ProgressLoader(tui, theme, "Analyzing usage…");
		const startedAt = Date.now();
		const progress: BreakdownProgressState = { phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0 };

		const renderMsg = (): string => {
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			if (progress.phase === "scan") return `Analyzing usage…  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
			if (progress.phase === "parse") return `Analyzing usage…  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
			return `Analyzing usage…  finalizing · ${elapsed}s`;
		};

		loader.setMessage(renderMsg());

		const intervalId = setInterval(() => loader.setMessage(renderMsg()), 500);

		loader.onAbort = () => { aborted = true; clearInterval(intervalId); done(null); };

		computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
			.then((d) => { clearInterval(intervalId); if (!aborted) done(d); })
			.catch((err) => { clearInterval(intervalId); console.error(`${label}: failed`, err); if (!aborted) done(null); });

		return loader;
	});

	if (!data) { ctx.ui.notify(aborted ? "Cancelled" : "Failed to analyze sessions", aborted ? "info" : "error"); return; }
	await ctx.ui.custom<void>((tui, theme, _kb, done) => onDone(data, tui, theme, done));
}

// ═══════════════════════════════════════════════════════════════════════════
// /usage
// ═══════════════════════════════════════════════════════════════════════════

interface Period { days: DayAgg[]; label: string; key: string }

function buildPeriods(range: RangeAgg, mode: MeasurementMode): Period[] {
	const n = range.days.length;
	if (n === 1) {
		const active = range.hours.filter((h) => metricForDay(h, mode) > 0);
		if (active.length > 0) return active.map((h) => ({ days: [h], label: formatHourLabel(h.date), key: h.dayKeyLocal }));
	}
	if (n >= 30) {
		const groups: DayAgg[][] = [];
		for (const day of range.days) {
			const last = groups[groups.length - 1];
			if (!last || mondayIndex(day.date) === 0) groups.push([day]); else last.push(day);
		}
		return groups.map((week) => {
			const first = week[0].date, last = week[week.length - 1].date;
			const m1 = first.getMonth() + 1, d1 = first.getDate();
			const m2 = last.getMonth() + 1, d2 = last.getDate();
			const label = m1 === m2 ? `${m1}/${d1}-${d2}` : `${m1}/${d1}-${m2}/${d2}`;
			return { days: week, key: week[0].dayKeyLocal, label };
		});
	}
	return range.days.map((day) => ({ days: [day], label: formatDayLabel(day.date), key: day.dayKeyLocal }));
}

class TimelineComponent implements Component {
	private data: BreakdownData; private tui: TUI; private theme: Theme; private onDone: () => void;
	private rangeIndex = 2; private measurement: MeasurementMode = "tokens"; private selectedIdx = Number.MAX_SAFE_INTEGER; // default: last period
	// Selected period's detail is a provider→model tree; Tab toggles between the
	// selected period's tree and the whole range's tree.
	private detailMode: "period" | "range" = "period";
	private cachedWidth?: number; private cachedLines?: string[];

	constructor(data: BreakdownData, tui: TUI, theme: Theme, onDone: () => void) { this.data = data; this.tui = tui; this.theme = theme; this.onDone = onDone; }
	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
	private currentRange(): RangeAgg { return this.data.ranges.get(RANGE_DAYS[this.rangeIndex])!; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") { this.onDone(); return; }
		if (matchesKey(data, Key.left) || data === "h") { this.rangeIndex = (this.rangeIndex - 1 + RANGE_DAYS.length) % RANGE_DAYS.length; this.selectedIdx = Number.MAX_SAFE_INTEGER; this.invalidate(); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.right) || data === "l") { this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length; this.selectedIdx = Number.MAX_SAFE_INTEGER; this.invalidate(); this.tui.requestRender(); return; }
		const num = Number(data);
		if (Number.isInteger(num) && num >= 1 && num <= RANGE_DAYS.length) { this.rangeIndex = num - 1; this.selectedIdx = Number.MAX_SAFE_INTEGER; this.invalidate(); this.tui.requestRender(); return; }

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.detailMode = this.detailMode === "period" ? "range" : "period";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const periods = buildPeriods(this.currentRange(), this.measurement);
		if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.up) || data === "k") { this.selectedIdx = clampIndex(this.selectedIdx - 1, periods.length); this.invalidate(); this.tui.requestRender(); }
		else if (matchesKey(data, Key.rightbracket) || matchesKey(data, Key.down) || data === "j") { this.selectedIdx = clampIndex(this.selectedIdx + 1, periods.length); this.invalidate(); this.tui.requestRender(); }
		else if (matchesKey(data, Key.leftbrace)) { this.selectedIdx = clampIndex(this.selectedIdx - 5, periods.length); this.invalidate(); this.tui.requestRender(); }
		else if (matchesKey(data, Key.rightbrace)) { this.selectedIdx = clampIndex(this.selectedIdx + 5, periods.length); this.invalidate(); this.tui.requestRender(); }
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const selectedDays = RANGE_DAYS[this.rangeIndex], range = this.currentRange(), mode = this.measurement;
		const periods = buildPeriods(range, mode);
		if (this.selectedIdx >= periods.length) this.selectedIdx = clampIndex(periods.length - 1, periods.length);

		const lines: string[] = [];
		const prefix = `${rangeLabel(selectedDays)}:`;
		const rest = `${formatCount(range.totalTokens)} · ${formatUsd(range.totalCost)} · ${formatDuration(range.totalDurationMs)}`;
		const header = `\x1b[1m←→ ${prefix}\x1b[22m ${rest}   ${dim("detail:" + this.detailMode)}`;
		lines.push(truncateToWidth(header, width));
		lines.push(dim("─".repeat(Math.min(visibleWidth(header), width))));

		if (periods.length === 0) {
			lines.push(dim("No activity in this range."));
		} else {
			const labelWidth = Math.min(14, periods[0]?.label?.length > 10 ? 11 : 9);
			const valueWidth = 8;

			for (let i = 0; i < periods.length; i++) {
				const p = periods[i], selected = i === this.selectedIdx;
				const value = p.days.reduce((s, d) => s + metricForDay(d, mode), 0);
				const label = padRight(p.label, labelWidth);
				const sel = (t: string): string => this.theme.bold(this.theme.fg("accent", t));
				const prefix = selected ? sel(` ${label}`) : ` ${label}`;
				const rawVal = formatMetric(mode, value);
				const valueCell = selected ? sel(padLeftVisible(rawVal, valueWidth)) : padLeftVisible(rawVal, valueWidth);
				const totalCost = p.days.reduce((s, d) => s + d.totalCost, 0);
				const totalDuration = p.days.reduce((s, d) => s + d.durationMs, 0);
				const costCell = selected ? sel(padRightVisible(formatUsd(totalCost), 7)) : padRightVisible(formatUsd(totalCost), 7);
				const durCell = selected ? sel(padRightVisible(formatDuration(totalDuration), 7)) : padRightVisible(formatDuration(totalDuration), 7);
				const row = `${padRightVisible(prefix, labelWidth + 1)}  ${valueCell}  ${costCell}  ${durCell}`;
				lines.push(truncateToWidth(row, width));
				if (selected) {
					const tree = this.detailMode === "range" ? modelTreeRows(range) : periodModelTree(p.days);
					if (tree.length > 0) {
						// Indent the detail block under the selected period row.
						for (const detailLine of modelTreeLines(tree, this.theme, Math.max(1, width - 4))) {
							lines.push(truncateToWidth(`  ${detailLine}`, width));
						}
					}
				}			}
		}

		lines.push("");
		lines.push(dim(`Up/Down select · [ ] step · Tab detail:${this.detailMode === "period" ? "period" : "range"} · 1-4 range · q quit`));
		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		return this.cachedLines;
	}
}

interface ModelTreeRow {
	provider: string;
	tokens: number;
	cost: number;
	durationMs: number;
	models: { name: string; tokens: number; cost: number; durationMs: number }[];
}

// Merge provider + model into a tree: provider as root, models as children.
function buildModelTreeRows(
	modelTokens: Map<string, number>,
	modelCost: Map<string, number>,
	modelDuration: Map<string, number>,
): ModelTreeRow[] {
	const byProvider = new Map<string, Map<string, { tokens: number; cost: number; durationMs: number }>>();
	for (const [model, tokens] of modelTokens) {
		if (tokens <= 0) continue;
		const idx = model.indexOf("/");
		const provider = idx === -1 ? "(unknown)" : model.slice(0, idx);
		const name = idx === -1 ? model : model.slice(idx + 1);
		let models = byProvider.get(provider);
		if (!models) { models = new Map(); byProvider.set(provider, models); }
		const entry = models.get(name) ?? { tokens: 0, cost: 0, durationMs: 0 };
		entry.tokens += tokens;
		entry.cost += modelCost.get(model) ?? 0;
		entry.durationMs += modelDuration.get(model) ?? 0;
		models.set(name, entry);
	}

	const rows: ModelTreeRow[] = [];
	for (const [provider, models] of byProvider) {
		const modelList = [...models.entries()]
			.map(([name, m]) => ({ name, ...m }))
			.sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
		rows.push({
			provider,
			tokens: modelList.reduce((s, m) => s + m.tokens, 0),
			cost: modelList.reduce((s, m) => s + m.cost, 0),
			durationMs: modelList.reduce((s, m) => s + m.durationMs, 0),
			models: modelList,
		});
	}
	return rows.sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
}

function modelTreeRows(range: RangeAgg): ModelTreeRow[] {
	return buildModelTreeRows(range.modelTokens, range.modelCost, range.modelDuration);
}

// Provider → model tree aggregated over a single period (day/week/hour).
function periodModelTree(days: DayAgg[]): ModelTreeRow[] {
	const modelTokens = new Map<string, number>();
	const modelCost = new Map<string, number>();
	const modelDuration = new Map<string, number>();
	for (const day of days) {
		for (const [m, v] of day.tokensByModel) modelTokens.set(m, (modelTokens.get(m) ?? 0) + v);
		for (const [m, v] of day.costByModel) modelCost.set(m, (modelCost.get(m) ?? 0) + v);
		for (const [m, v] of day.durationByModel) modelDuration.set(m, (modelDuration.get(m) ?? 0) + v);
	}
	return buildModelTreeRows(modelTokens, modelCost, modelDuration);
}

// Shared tree renderer used by the timeline detail (and the standalone models view).
function modelTreeLines(tree: ModelTreeRow[], theme: Theme, width: number): string[] {
	const tokenW = 8, costW = 7, durW = 7;
	const visibleProviders = tree.slice(0, 5);
	// Label widths adapt to the longest visible name (+2) so the gap before
	// the metric columns stays small while rows stay aligned.
	const rootLabelWidth = Math.max(1, ...visibleProviders.map((p) => visibleWidth(p.provider))) + 2;
	const childNameWidth = Math.max(1, ...visibleProviders.flatMap((p) => p.models.slice(0, 3).map((m) => visibleWidth(m.name)))) + 2;
	// Tree branches in neutral gray (rgb 140) — accent was too loud against the theme.
	const treeColor = (t: string): string => `\x1b[38;2;140;140;140m${t}\x1b[0m`;
	const metric = (t: number, c: number, d: number): string =>
		theme.fg("dim", `${padLeftVisible(formatCount(t), tokenW)}  ${padRightVisible(formatUsd(c), costW)}  ${padRightVisible(formatDuration(d), durW)}`);
	const rootMetric = (t: number, c: number, d: number): string =>
		bold(`${padLeftVisible(formatCount(t), tokenW)}  ${padRightVisible(formatUsd(c), costW)}  ${padRightVisible(formatDuration(d), durW)}`);
	const lines: string[] = [];
	// Root branch ("├── "/"└── ") and child continuation connector ("│     "/"      ").
	const rootPrefix = (last: boolean): string => (last ? "└── " : "├── ");
	const childConnector = (last: boolean): string => (last ? "      " : "│     ");
	for (const [pi, prov] of visibleProviders.entries()) {
		const lastProvider = pi === visibleProviders.length - 1;
		lines.push(truncateToWidth(`${treeColor(rootPrefix(lastProvider))}${bold(padRightVisible(prov.provider, rootLabelWidth))}  ${rootMetric(prov.tokens, prov.cost, prov.durationMs)}`, width));
		const shownModels = prov.models.slice(0, 3);
		for (const [mi, model] of shownModels.entries()) {
			const branch = mi === shownModels.length - 1 ? "└──" : "├──";
			const modelName = padRight(truncateToWidth(model.name, childNameWidth), childNameWidth);
			lines.push(truncateToWidth(
				`${treeColor(`${childConnector(lastProvider)}${branch} `)}${modelName}  ${metric(model.tokens, model.cost, model.durationMs)}`, width,
			));
		}
		if (prov.models.length > shownModels.length) {
			const branch = lastProvider ? "└──" : "├──";
			lines.push(truncateToWidth(`${treeColor(`${childConnector(lastProvider)}${branch} `)}${dim(`+${prov.models.length - shownModels.length} more models`)}`, width));
		}
	}
	if (tree.length > visibleProviders.length) lines.push(truncateToWidth(`${treeColor(rootPrefix(true))}${dim(`+${tree.length - visibleProviders.length} more providers`)}`, width));
	return lines;
}



// ═══════════════════════════════════════════════════════════════════════════
// extension entry — registers /usage
// ═══════════════════════════════════════════════════════════════════════════

export default function usageV2Extension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Usage over time with provider/model tree drill-down",
		handler: (_args, ctx: ExtensionContext) => loadWithProgress(pi, ctx, "usage", (data, tui, theme, done) => new TimelineComponent(data, tui, theme, done)),
	});
}
