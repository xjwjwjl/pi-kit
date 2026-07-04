/**
 * /usage-breakdown
 *
 * Interactive TUI that analyzes ~/.pi/agent/sessions (recursively, *.jsonl) and shows
 * recent activity for today and the last 7/30/90 days with breakdowns by model, directory,
 * and time of day. Duration is user-turn waiting time: user message to final assistant completion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

type ModelKey = string; // `${provider}/${model}`
type CwdKey = string; // normalized cwd path
type TodKey = string; // "after-midnight", "morning", "afternoon", "evening", "night"
type BreakdownView = "model" | "cwd" | "tod";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] = [
	{ key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
	{ key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
	{ key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
	{ key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
	{ key: "night", label: "Night (22–23)", from: 22, to: 23 },
];

function todBucketForHour(hour: number): TodKey {
	for (const b of TOD_BUCKETS) {
		if (hour >= b.from && hour <= b.to) return b.key;
	}
	return "after-midnight";
}

function todBucketLabel(key: TodKey): string {
	return TOD_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

interface ParsedUsageEvent {
	at: Date;
	model: ModelKey;
	tokens: number;
	cost: number;
	durationMs: number;
}

interface ParsedSession {
	filePath: string;
	startedAt: Date;
	cwd: CwdKey | null;
	events: ParsedUsageEvent[];
}

interface DayAgg {
	date: Date; // local midnight
	dayKeyLocal: string;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
	tokensByCwd: Map<CwdKey, number>;
	costByCwd: Map<CwdKey, number>;
	tokensByTod: Map<TodKey, number>;
	costByTod: Map<TodKey, number>;
	durationMs: number;
	durationByModel: Map<ModelKey, number>;
	durationByCwd: Map<CwdKey, number>;
	durationByTod: Map<TodKey, number>;
}

interface RangeAgg {
	days: DayAgg[];
	dayByKey: Map<string, DayAgg>;
	hours: DayAgg[];
	hourByKey: Map<string, DayAgg>;
	totalTokens: number;
	totalCost: number;
	modelCost: Map<ModelKey, number>;
	modelTokens: Map<ModelKey, number>;
	cwdCost: Map<CwdKey, number>;
	cwdTokens: Map<CwdKey, number>;
	todCost: Map<TodKey, number>;
	todTokens: Map<TodKey, number>;
	totalDurationMs: number;
	modelDuration: Map<ModelKey, number>;
	cwdDuration: Map<CwdKey, number>;
	todDuration: Map<TodKey, number>;
}

interface RGB {
	r: number;
	g: number;
	b: number;
}

interface BreakdownData {
	ranges: Map<number, RangeAgg>;
	todPalette: {
		todColors: Map<TodKey, RGB>;
		orderedTods: TodKey[];
	};
}

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RANGE_DAYS = [1, 7, 30, 90] as const;

type MeasurementMode = "tokens" | "cost" | "duration";

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
	phase: BreakdownProgressPhase;
	foundFiles: number;
	parsedFiles: number;
	totalFiles: number;
	currentFile?: string;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
	// BorderedLoader wraps a (Cancellable)Loader which supports setMessage(),
	// but it doesn't expose it publicly. Access the inner loader for progress updates.
	const inner = (loader as any)["loader"]; // eslint-disable-line @typescript-eslint/no-explicit-any
	if (inner && typeof inner.setMessage === "function") {
		inner.setMessage(message);
	}
}

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
	{ r: 64, g: 196, b: 99 }, // green
	{ r: 47, g: 129, b: 247 }, // blue
	{ r: 163, g: 113, b: 247 }, // purple
	{ r: 255, g: 159, b: 10 }, // orange
	{ r: 244, g: 67, b: 54 }, // red
];
const BREAKDOWN_CONTENT_MAX_WIDTH = 54;

function ansiFg(rgb: RGB, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

function formatCount(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
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
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

/**
 * Abbreviate a path for display. Strategy:
 * - Replace home dir with ~
 * - If still too long, keep first segment + last N segments with … in between
 * Examples:
 *   /Users/mitsuhiko/Development/agent-stuff  →  ~/Development/agent-stuff
 *   /Users/mitsuhiko/Development/minijinja/minijinja-go  →  ~/…/minijinja/minijinja-go
 */
function abbreviatePath(p: string, maxWidth = 40): string {
	const home = os.homedir();
	let display = p;
	if (display.startsWith(home)) {
		display = "~" + display.slice(home.length);
	}
	if (display.length <= maxWidth) return display;

	const parts = display.split(/[\\/]+/).filter(Boolean);
	// Always keep the first part (~ or root indicator) and try to keep as many trailing parts as possible
	if (parts.length <= 2) return display;

	const prefix = parts[0]; // typically "~"
	// Try keeping last N parts, increasing until it fits
	for (let keep = parts.length - 1; keep >= 1; keep--) {
		const tail = parts.slice(parts.length - keep);
		const candidate = prefix + "/…/" + tail.join("/");
		if (candidate.length <= maxWidth || keep === 1) return candidate;
	}
	return display;
}

function pathDisplayParts(p: string): string[] {
	const home = os.homedir();
	let display = p;
	if (display.startsWith(home)) display = "~" + display.slice(home.length);
	return display.split(/[\\/]+/).filter(Boolean);
}

function directoryBaseName(p: string): string {
	const parts = pathDisplayParts(p);
	return parts[parts.length - 1] ?? p;
}

function directoryParentName(p: string): string {
	const parts = pathDisplayParts(p);
	return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function compactDirectoryLabel(p: string, visibleKeys: readonly string[] = [p], maxWidth = 32): string {
	const base = directoryBaseName(p);
	const duplicateBase = visibleKeys.filter((key) => directoryBaseName(key) === base).length > 1;
	const parent = directoryParentName(p);
	const label = duplicateBase && parent ? `${parent}/${base}` : base;
	return truncateToWidth(label || abbreviatePath(p, maxWidth), maxWidth);
}

function padLeft(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? " ".repeat(delta) + s : s;
}

function toLocalDayKey(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function toLocalHourKey(d: Date): string {
	return `${toLocalDayKey(d)}T${String(d.getHours()).padStart(2, "0")}`;
}

function formatHourLabel(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function isHourKey(key: string): boolean {
	return /T\d{2}$/.test(key);
}

function localMidnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(d: Date, days: number): Date {
	const x = new Date(d);
	x.setDate(x.getDate() + days);
	return x;
}

function mondayIndex(date: Date): number {
	// Mon=0 .. Sun=6
	return (date.getDay() + 6) % 7;
}

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | null {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p && !m) return null;
	if (!p) return m;
	if (!m) return p;
	return `${p}/${m}`;
}

function parseSessionStartFromFilename(name: string): Date | null {
	// Example: 2026-02-02T21-52-28-774Z_<uuid>.jsonl
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): { provider?: any; model?: any; modelId?: any; usage?: any } {
	// Session format varies across versions.
	// - Newer: { provider, model, usage } on the message wrapper
	// - Older: { message: { provider, model, usage } }
	const msg = obj?.message;
	return {
		provider: obj?.provider ?? msg?.provider,
		model: obj?.model ?? msg?.model,
		modelId: obj?.modelId ?? msg?.modelId,
		usage: obj?.usage ?? msg?.usage,
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
	const msg = obj?.message;
	const raw = obj?.role ?? msg?.role;
	return typeof raw === "string" ? raw : "";
}

function assistantContinuesTurn(obj: any): boolean {
	const msg = obj?.message;
	const stopReason = obj?.stopReason ?? msg?.stopReason;
	if (typeof stopReason === "string") {
		const normalized = stopReason.trim();
		if (normalized === "toolUse" || normalized === "tool_use") return true;
		if (normalized) return false;
	}

	const content = obj?.content ?? msg?.content;
	return Array.isArray(content) && content.some((part) => part && typeof part === "object" && part.type === "toolCall");
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function extractTokensTotal(usage: any): number {
	// Usage format varies across providers and pi versions.
	// We try a few common shapes:
	// - { totalTokens }
	// - { total_tokens }
	// - { promptTokens, completionTokens }
	// - { prompt_tokens, completion_tokens }
	// - { input_tokens, output_tokens }
	// - { inputTokens, outputTokens }
	// - { tokens: number | { total } }
	if (!usage) return 0;

	const readNum = (v: any): number => {
		if (typeof v === "number") return Number.isFinite(v) ? v : 0;
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		}
		return 0;
	};

	let total = 0;
	// direct totals
	total =
		readNum(usage?.totalTokens) ||
		readNum(usage?.total_tokens) ||
		readNum(usage?.tokens) ||
		readNum(usage?.tokenCount) ||
		readNum(usage?.token_count);
	if (total > 0) return total;

	// nested tokens object
	total = readNum(usage?.tokens?.total) || readNum(usage?.tokens?.totalTokens) || readNum(usage?.tokens?.total_tokens);
	if (total > 0) return total;

	// sum of parts
	const a =
		readNum(usage?.promptTokens) ||
		readNum(usage?.prompt_tokens) ||
		readNum(usage?.inputTokens) ||
		readNum(usage?.input_tokens);
	const b =
		readNum(usage?.completionTokens) ||
		readNum(usage?.completion_tokens) ||
		readNum(usage?.outputTokens) ||
		readNum(usage?.output_tokens);
	const sum = a + b;
	return sum > 0 ? sum : 0;
}

async function walkSessionFiles(
	root: string,
	startCutoffLocal: Date,
	signal?: AbortSignal,
	onFound?: (found: number) => void,
): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: Dirent[] = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const ent of entries) {
			if (signal?.aborted) break;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

			// Include files whose session start or mtime falls in the scan window.
			const startedAt = parseSessionStartFromFilename(ent.name);
			if (startedAt && localMidnight(startedAt) >= startCutoffLocal) {
				out.push(p);
				if (onFound && out.length % 10 === 0) onFound(out.length);
				continue;
			}

			try {
				const st = await fs.stat(p);
				const approx = new Date(st.mtimeMs);
				if (localMidnight(approx) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
			} catch {
				// ignore
			}
		}
	}
	onFound?.(out.length);
	return out;
}

async function parseSessionFile(filePath: string, signal?: AbortSignal): Promise<ParsedSession | null> {
	const fileName = path.basename(filePath);
	let startedAt = parseSessionStartFromFilename(fileName);
	let currentModel: ModelKey | null = null;
	let cwd: CwdKey | null = null;
	let openTurnStartedAt: Date | null = null;
	const pendingEvents: Array<{ at: Date | null; model: ModelKey; tokens: number; cost: number; durationMs: number }> = [];

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (signal?.aborted) {
				rl.close();
				stream.destroy();
				return null;
			}
			if (!line) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			if (obj?.type === "session") {
				if (!startedAt) {
					const d = extractTimestampDate(obj);
					if (d) startedAt = d;
				}
				if (typeof obj?.cwd === "string" && obj.cwd.trim()) {
					cwd = obj.cwd.trim();
				}
				continue;
			}

			if (obj?.type === "model_change") {
				const mk = modelKeyFromParts(obj.provider, obj.modelId);
				if (mk) currentModel = mk;
				continue;
			}

			if (obj?.type !== "message") continue;

			const at = extractTimestampDate(obj);
			const role = extractMessageRole(obj);
			if (role === "user") {
				openTurnStartedAt = at;
				continue;
			}
			if (role !== "assistant") continue;

			const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
			const mk =
				modelKeyFromParts(provider, model) ??
				modelKeyFromParts(provider, modelId) ??
				currentModel ??
				"unknown";
			const tokens = extractTokensTotal(usage);
			const cost = extractCostTotal(usage);

			let durationMs = 0;
			if (!assistantContinuesTurn(obj)) {
				if (openTurnStartedAt && at) {
					const elapsed = at.getTime() - openTurnStartedAt.getTime();
					durationMs = elapsed > 0 ? elapsed : 0;
				}
				openTurnStartedAt = null;
			}

			if (tokens <= 0 && cost <= 0 && durationMs <= 0) continue;
			pendingEvents.push({ at, model: mk, tokens, cost, durationMs });
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	if (!startedAt) return null;
	const events = pendingEvents
		.map((event) => ({
			at: event.at ?? startedAt!,
			model: event.model,
			tokens: event.tokens,
			cost: event.cost,
			durationMs: event.durationMs,
		}))
		.sort((a, b) => a.at.getTime() - b.at.getTime());

	return {
		filePath,
		startedAt,
		cwd,
		events,
	};
}

function emptyAgg(date: Date, key: string): DayAgg {
	return {
		date,
		dayKeyLocal: key,
		tokens: 0,
		totalCost: 0,
		costByModel: new Map(),
		tokensByModel: new Map(),
		tokensByCwd: new Map(),
		costByCwd: new Map(),
		tokensByTod: new Map(),
		costByTod: new Map(),
		durationMs: 0,
		durationByModel: new Map(),
		durationByCwd: new Map(),
		durationByTod: new Map(),
	};
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
	const end = localMidnight(now);
	const start = addDaysLocal(end, -(days - 1));
	const outDays: DayAgg[] = [];
	const dayByKey = new Map<string, DayAgg>();
	const hours: DayAgg[] = [];
	const hourByKey = new Map<string, DayAgg>();

	for (let i = 0; i < days; i++) {
		const d = addDaysLocal(start, i);
		const dayKeyLocal = toLocalDayKey(d);
		const day = emptyAgg(d, dayKeyLocal);
		outDays.push(day);
		dayByKey.set(dayKeyLocal, day);
	}

	if (days === 1) {
		for (let hour = 0; hour < 24; hour++) {
			const d = new Date(start);
			d.setHours(hour, 0, 0, 0);
			const key = toLocalHourKey(d);
			const bucket = emptyAgg(d, key);
			hours.push(bucket);
			hourByKey.set(key, bucket);
		}
	}

	return {
		days: outDays,
		dayByKey,
		hours,
		hourByKey,
		totalTokens: 0,
		totalCost: 0,
		modelCost: new Map(),
		modelTokens: new Map(),
		cwdCost: new Map(),
		cwdTokens: new Map(),
		todCost: new Map(),
		todTokens: new Map(),
		totalDurationMs: 0,
		modelDuration: new Map(),
		cwdDuration: new Map(),
		todDuration: new Map(),
	};
}

function addUsageEventToBucket(bucket: DayAgg, event: ParsedUsageEvent, cwd: CwdKey | null): void {
	bucket.tokens += event.tokens;
	bucket.totalCost += event.cost;
	bucket.durationMs += event.durationMs;

	if (event.tokens > 0) bucket.tokensByModel.set(event.model, (bucket.tokensByModel.get(event.model) ?? 0) + event.tokens);
	if (event.cost > 0) bucket.costByModel.set(event.model, (bucket.costByModel.get(event.model) ?? 0) + event.cost);
	if (event.durationMs > 0) bucket.durationByModel.set(event.model, (bucket.durationByModel.get(event.model) ?? 0) + event.durationMs);

	if (cwd) {
		if (event.tokens > 0) bucket.tokensByCwd.set(cwd, (bucket.tokensByCwd.get(cwd) ?? 0) + event.tokens);
		if (event.cost > 0) bucket.costByCwd.set(cwd, (bucket.costByCwd.get(cwd) ?? 0) + event.cost);
		if (event.durationMs > 0) bucket.durationByCwd.set(cwd, (bucket.durationByCwd.get(cwd) ?? 0) + event.durationMs);
	}

	const tod = todBucketForHour(event.at.getHours());
	if (event.tokens > 0) bucket.tokensByTod.set(tod, (bucket.tokensByTod.get(tod) ?? 0) + event.tokens);
	if (event.cost > 0) bucket.costByTod.set(tod, (bucket.costByTod.get(tod) ?? 0) + event.cost);
	if (event.durationMs > 0) bucket.durationByTod.set(tod, (bucket.durationByTod.get(tod) ?? 0) + event.durationMs);
}

function addUsageEventToRangeTotals(range: RangeAgg, event: ParsedUsageEvent, cwd: CwdKey | null): void {
	range.totalTokens += event.tokens;
	range.totalCost += event.cost;
	range.totalDurationMs += event.durationMs;

	if (event.tokens > 0) range.modelTokens.set(event.model, (range.modelTokens.get(event.model) ?? 0) + event.tokens);
	if (event.cost > 0) range.modelCost.set(event.model, (range.modelCost.get(event.model) ?? 0) + event.cost);
	if (event.durationMs > 0) range.modelDuration.set(event.model, (range.modelDuration.get(event.model) ?? 0) + event.durationMs);

	if (cwd) {
		if (event.tokens > 0) range.cwdTokens.set(cwd, (range.cwdTokens.get(cwd) ?? 0) + event.tokens);
		if (event.cost > 0) range.cwdCost.set(cwd, (range.cwdCost.get(cwd) ?? 0) + event.cost);
		if (event.durationMs > 0) range.cwdDuration.set(cwd, (range.cwdDuration.get(cwd) ?? 0) + event.durationMs);
	}

	const tod = todBucketForHour(event.at.getHours());
	if (event.tokens > 0) range.todTokens.set(tod, (range.todTokens.get(tod) ?? 0) + event.tokens);
	if (event.cost > 0) range.todCost.set(tod, (range.todCost.get(tod) ?? 0) + event.cost);
	if (event.durationMs > 0) range.todDuration.set(tod, (range.todDuration.get(tod) ?? 0) + event.durationMs);
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
	for (const event of session.events) {
		const day = range.dayByKey.get(toLocalDayKey(event.at));
		if (!day) continue;

		addUsageEventToRangeTotals(range, event, session.cwd);
		addUsageEventToBucket(day, event, session.cwd);

		const hour = range.hourByKey.get(toLocalHourKey(event.at));
		if (hour) addUsageEventToBucket(hour, event, session.cwd);
	}
}

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
	return [...m.entries()]
		.map(([key, value]) => ({ key, value }))
		.sort((a, b) => b.value - a.value);
}

function modelMetricMapForRange(range: RangeAgg, mode: MeasurementMode): Map<ModelKey, number> {
	if (mode === "cost") return range.modelCost;
	if (mode === "duration") return range.modelDuration;
	return range.modelTokens;
}

// ponytail: one generic instead of chooseModelPalette + chooseCwdPalette
function choosePalette<K extends string>(metricMap: Map<K, number>, topN = 4): {
	colors: Map<K, RGB>;
	otherColor: RGB;
	ordered: K[];
} {
	const sorted = sortMapByValueDesc(metricMap);
	const ordered = sorted.slice(0, topN).map((x) => x.key);
	const colors = new Map<K, RGB>();
	for (let i = 0; i < ordered.length; i++) {
		colors.set(ordered[i], PALETTE[i % PALETTE.length]);
	}
	return { colors, otherColor: { r: 160, g: 160, b: 160 }, ordered };
}

function cwdMetricMapForRange(range: RangeAgg, mode: MeasurementMode): Map<CwdKey, number> {
	if (mode === "cost") return range.cwdCost;
	if (mode === "duration") return range.cwdDuration;
	return range.cwdTokens;
}

// Fixed palette for time-of-day buckets
const TOD_PALETTE: Map<TodKey, RGB> = new Map([
	["after-midnight", { r: 100, g: 60, b: 180 }],  // deep purple
	["morning", { r: 255, g: 200, b: 50 }],          // golden yellow
	["afternoon", { r: 64, g: 196, b: 99 }],         // green
	["evening", { r: 47, g: 129, b: 247 }],           // blue
	["night", { r: 60, g: 40, b: 140 }],              // dark indigo
]);

function buildTodPalette(): { todColors: Map<TodKey, RGB>; orderedTods: TodKey[] } {
	const todColors = new Map<TodKey, RGB>();
	const orderedTods: TodKey[] = [];
	for (const b of TOD_BUCKETS) {
		const c = TOD_PALETTE.get(b.key);
		if (c) todColors.set(b.key, c);
		orderedTods.push(b.key);
	}
	return { todColors, orderedTods };
}

function metricValueForDay(day: DayAgg, mode: MeasurementMode): number {
	if (mode === "cost") return day.totalCost;
	if (mode === "duration") return day.durationMs;
	return day.tokens;
}

function metricValueWidth(mode: MeasurementMode): number {
	return mode === "tokens" || mode === "cost" ? 10 : 9;
}

function formatMetricValue(mode: MeasurementMode, value: number): string {
	if (mode === "cost") return formatUsd(value);
	if (mode === "duration") return formatDuration(value);
	return formatCount(value);
}

function padMetricValue(mode: MeasurementMode, value: number, width: number): string {
	const formatted = formatMetricValue(mode, value);
	return mode === "cost" ? padRightVisible(formatted, width) : padLeft(formatted, width);
}

function padMetricHeader(mode: MeasurementMode, width: number): string {
	const label = activityMetricLabel(mode);
	return mode === "cost" ? padRightVisible(label, width) : padLeft(label, width);
}

function asStringMap<K extends string>(m: Map<K, number>): Map<string, number> {
	return m as unknown as Map<string, number>;
}

function dayBreakdownMap(day: DayAgg, view: BreakdownView, mode: MeasurementMode): Map<string, number> {
	if (view === "tod") {
		if (mode === "cost") return asStringMap(day.costByTod);
		if (mode === "duration") return asStringMap(day.durationByTod);
		return asStringMap(day.tokensByTod);
	}
	if (view === "cwd") {
		if (mode === "cost") return asStringMap(day.costByCwd);
		if (mode === "duration") return asStringMap(day.durationByCwd);
		return asStringMap(day.tokensByCwd);
	}
	if (mode === "cost") return asStringMap(day.costByModel);
	if (mode === "duration") return asStringMap(day.durationByModel);
	return asStringMap(day.tokensByModel);
}

function formatShortDate(d: Date): string {
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayLabel(d: Date): string {
	return `${formatShortDate(d)} ${WEEKDAY_NAMES[mondayIndex(d)]}`;
}

function aggregateBreakdownForDays(days: DayAgg[], view: BreakdownView, mode: MeasurementMode): Map<string, number> {
	const out = new Map<string, number>();
	for (const day of days) {
		for (const [key, value] of dayBreakdownMap(day, view, mode)) {
			out.set(key, (out.get(key) ?? 0) + value);
		}
	}
	return out;
}

function topBreakdownPrefix(view: BreakdownView): string {
	if (view === "cwd") return "dir";
	if (view === "tod") return "time";
	return "model";
}

function topBreakdownForDays(
	days: DayAgg[],
	view: BreakdownView,
	mode: MeasurementMode,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
): { label: string; color: RGB } | undefined {
	const top = sortMapByValueDesc(aggregateBreakdownForDays(days, view, mode))[0];
	if (!top || top.value <= 0) return undefined;
	return {
		label: view === "cwd" ? compactDirectoryLabel(top.key) : view === "tod" ? todBucketLabel(top.key as TodKey) : top.key,
		color: colorMap.get(top.key) ?? otherColor,
	};
}

function activityMetricLabel(mode: MeasurementMode): string {
	return mode;
}

interface ActivityTotals {
	tokens: number;
	cost: number;
	durationMs: number;
}

function activityTotalsForDays(days: DayAgg[]): ActivityTotals {
	return {
		tokens: days.reduce((sum, day) => sum + day.tokens, 0),
		cost: days.reduce((sum, day) => sum + day.totalCost, 0),
		durationMs: days.reduce((sum, day) => sum + day.durationMs, 0),
	};
}

function renderActivityTableRow(
	period: string,
	periodWidth: number,
	value: number,
	mode: MeasurementMode,
	width: number,
	selected: boolean,
	top?: { label: string; color: RGB },
): string {
	const marker = selected ? bold(">") : " ";
	const valueWidth = Math.max(8, metricValueWidth(mode));
	const showTop = !!top && width >= periodWidth + valueWidth + 14;
	const topText = showTop ? `  ${top.label}` : "";
	const row = `${marker} ${padRightVisible(period, periodWidth)}  ${padMetricValue(mode, value, valueWidth)}${topText}`;
	return truncateToWidth(row, width);
}

function activeHourBuckets(range: RangeAgg, mode: MeasurementMode): DayAgg[] {
	return range.hours.filter((hour) => metricValueForDay(hour, mode) > 0);
}

function renderHourlyActivityLines(
	range: RangeAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView,
	width: number,
	selectedDayKey?: string,
): string[] {
	const periodWidth = 5;
	const hours = activeHourBuckets(range, mode);
	if (hours.length === 0) return [dim("No usage yet today.")];
	const lines: string[] = [];
	for (const hour of hours) {
		const top = topBreakdownForDays([hour], view, mode, colorMap, otherColor);
		lines.push(
			renderActivityTableRow(
				formatHourLabel(hour.date),
				periodWidth,
				metricValueForDay(hour, mode),
				mode,
				width,
				hour.dayKeyLocal === selectedDayKey,
				top,
			),
		);
	}
	return lines;
}

function renderDailyActivityLines(
	range: RangeAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView,
	width: number,
	selectedDayKey?: string,
): string[] {
	const periodWidth = 9;
	const lines: string[] = [];
	for (const day of range.days) {
		const top = topBreakdownForDays([day], view, mode, colorMap, otherColor);
		lines.push(
			renderActivityTableRow(
				formatDayLabel(day.date),
				periodWidth,
				metricValueForDay(day, mode),
				mode,
				width,
				day.dayKeyLocal === selectedDayKey,
				top,
			),
		);
	}
	return lines;
}

function weekGroupsForRange(range: RangeAgg): DayAgg[][] {
	const groups: DayAgg[][] = [];
	for (const day of range.days) {
		const last = groups[groups.length - 1];
		if (!last || mondayIndex(day.date) === 0) groups.push([day]);
		else last.push(day);
	}
	return groups;
}

function renderWeeklyActivityLines(
	range: RangeAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView,
	width: number,
	selectedDayKey?: string,
): string[] {
	const periodWidth = 11;
	const lines: string[] = [];
	for (const days of weekGroupsForRange(range)) {
		const first = days[0];
		const last = days[days.length - 1];
		const selected = days.some((day) => day.dayKeyLocal === selectedDayKey);
		const top = topBreakdownForDays(days, view, mode, colorMap, otherColor);
		const value = days.reduce((sum, day) => sum + metricValueForDay(day, mode), 0);
		lines.push(renderActivityTableRow(`${formatShortDate(first.date)}–${formatShortDate(last.date)}`, periodWidth, value, mode, width, selected, top));
	}
	return lines;
}

function renderHybridActivityLines(
	range: RangeAgg,
	selectedDays: number,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView,
	width: number,
	selectedDayKey?: string,
): string[] {
	if (selectedDays === 1) return renderHourlyActivityLines(range, colorMap, otherColor, mode, view, width, selectedDayKey);
	return selectedDays >= 30
		? renderWeeklyActivityLines(range, colorMap, otherColor, mode, view, width, selectedDayKey)
		: renderDailyActivityLines(range, colorMap, otherColor, mode, view, width, selectedDayKey);
}

function displayModelName(modelKey: string) {
	const idx = modelKey.indexOf("/");
	return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function displayModelProvider(modelKey: string): string {
	const idx = modelKey.indexOf("/");
	return idx === -1 ? "" : modelKey.slice(0, idx);
}

function displayModelLabel(modelKey: string, visibleKeys: readonly string[]): string {
	const name = displayModelName(modelKey);
	const duplicateName = visibleKeys.filter((key) => displayModelName(key) === name).length > 1;
	if (!duplicateName) return name;
	const provider = displayModelProvider(modelKey);
	return provider ? `${name} (${provider})` : name;
}

function padRightVisible(s: string, width: number): string {
	const truncated = truncateToWidth(s, width);
	const w = visibleWidth(truncated);
	return w >= width ? truncated : truncated + " ".repeat(width - w);
}

function sumMapValues<K extends string>(m: Map<K, number>): number {
	return [...m.values()].reduce((a, b) => a + b, 0);
}

function formatPercent(share: number): string {
	if (!Number.isFinite(share) || share <= 0) return "0%";
	const pct = share * 100;
	return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

interface BreakdownShareRow {
	key: string;
	label: string;
	value: number;
	color: RGB;
	tokens?: number;
	cost?: number;
}

// ponytail: one generic instead of modelShareRows + cwdShareRows
function makeShareRows<K extends string>(
	ordered: K[],
	colors: Map<K, RGB>,
	getLabel: (key: K, visible: K[]) => string,
	metricMap: Map<K, number>,
	otherColor: RGB,
	tokenMap?: Map<K, number>,
	costMap?: Map<K, number>,
): BreakdownShareRow[] {
	const rows: BreakdownShareRow[] = [];
	let shownTotal = 0;
	for (const key of ordered) {
		const value = metricMap.get(key) ?? 0;
		if (value <= 0) continue;
		shownTotal += value;
		rows.push({
			key,
			label: getLabel(key, ordered),
			value,
			color: colors.get(key) ?? otherColor,
			tokens: tokenMap?.get(key) ?? 0,
			cost: costMap?.get(key) ?? 0,
		});
	}

	const total = sumMapValues(metricMap);
	const otherValue = Math.max(0, total - shownTotal);
	if (otherValue > 0) {
		const shownKeys = new Set(ordered);
		let otherTokens = 0;
		let otherCost = 0;
		if (tokenMap) {
			for (const [key, value] of tokenMap) {
				if (!shownKeys.has(key)) otherTokens += value;
			}
		}
		if (costMap) {
			for (const [key, value] of costMap) {
				if (!shownKeys.has(key)) otherCost += value;
			}
		}
		rows.push({ key: "other", label: "other", value: otherValue, color: otherColor, tokens: otherTokens, cost: otherCost });
	}
	return rows;
}

interface ShareDetailColumns {
	valueWidth: number;
	costWidth: number;
	pctWidth: number;
	labelWidth: number;
	showCostColumn: boolean;
}

function computeShareDetailColumns(rows: BreakdownShareRow[], total: number, width: number, mode: MeasurementMode): ShareDetailColumns {
	const showCostColumn = mode !== "cost";
	const valueWidth = Math.max(
		activityMetricLabel(mode).length,
		...rows.map((row) => formatMetricValue(mode, row.value).length),
	);
	const costWidth = showCostColumn
		? Math.max("cost".length, ...rows.map((row) => formatUsd(row.cost ?? 0).length))
		: 0;
	const pctWidth = Math.max(
		"share".length,
		...rows.map((row) => formatPercent(total > 0 ? row.value / total : 0).length),
	);
	const fixedWidth = 2 + 2 + valueWidth + (showCostColumn ? 2 + costWidth : 0) + 2 + pctWidth;
	return {
		valueWidth,
		costWidth,
		pctWidth,
		labelWidth: Math.max(6, width - fixedWidth),
		showCostColumn,
	};
}

function renderShareDetailHeader(label: string, width: number, mode: MeasurementMode, columns: ShareDetailColumns): string {
	return dim(
		`${" ".repeat(2)}${padRightVisible(label, columns.labelWidth)}  ${padMetricHeader(mode, columns.valueWidth)}` +
			(columns.showCostColumn ? `  ${padLeft("cost", columns.costWidth)}` : "") +
			`  ${padLeft("share", columns.pctWidth)}`,
	);
}

function renderShareDetailRow(row: BreakdownShareRow, total: number, width: number, mode: MeasurementMode, columns: ShareDetailColumns): string {
	const share = total > 0 ? row.value / total : 0;
	const pct = formatPercent(share);
	if (width < (columns.showCostColumn ? 34 : 24)) {
		return truncateToWidth(`${ansiFg(row.color, "█")} ${row.label} ${pct}`, width);
	}

	return (
		`${ansiFg(row.color, "█")} ${padRightVisible(row.label, columns.labelWidth)}  ${padMetricValue(mode, row.value, columns.valueWidth)}` +
			(columns.showCostColumn ? `  ${padLeft(formatUsd(row.cost ?? 0), columns.costWidth)}` : "") +
			`  ${padLeft(pct, columns.pctWidth)}`
	);
}

function renderCompactBreakdownRow(row: BreakdownShareRow, total: number, mode: MeasurementMode, width: number): string {
	const pct = formatPercent(total > 0 ? row.value / total : 0);
	if (width < 26) {
		return truncateToWidth(`${ansiFg(row.color, "█")} ${row.label} ${pct}`, width);
	}

	const valueWidth = Math.max(8, metricValueWidth(mode));
	const pctWidth = 6;
	const fixedWidth = 2 + 2 + valueWidth + 2 + pctWidth;
	const labelWidth = Math.max(6, width - fixedWidth);
	return `${ansiFg(row.color, "█")} ${padRightVisible(row.label, labelWidth)}  ${padMetricValue(mode, row.value, valueWidth)}  ${padLeft(pct, pctWidth)}`;
}

function renderCompactBreakdownSummary(
	title: string,
	rows: BreakdownShareRow[],
	total: number,
	mode: MeasurementMode,
	width: number,
	maxRows = 5,
): string[] {
	if (width <= 0) return [];
	const contentWidth = Math.max(24, Math.min(width, BREAKDOWN_CONTENT_MAX_WIDTH));
	const activeRows = rows.filter((row) => row.value > 0);
	const visibleRows = activeRows.slice(0, maxRows);
	const lines = [dim(title)];
	if (total <= 0 || activeRows.length === 0) {
		lines.push(dim("(no breakdown data found)"));
		return lines;
	}

	for (const row of visibleRows) {
		lines.push(renderCompactBreakdownRow(row, total, mode, contentWidth));
	}
	const hidden = activeRows.length - visibleRows.length;
	if (hidden > 0) lines.push(dim(`  +${hidden} more`));
	return lines;
}

function todMetricMapForRange(range: RangeAgg, mode: MeasurementMode): Map<TodKey, number> {
	if (mode === "cost") return range.todCost;
	if (mode === "duration") return range.todDuration;
	return range.todTokens;
}

function todShareRows(
	range: RangeAgg,
	mode: MeasurementMode,
	palette: { todColors: Map<TodKey, RGB>; orderedTods: TodKey[] },
): BreakdownShareRow[] {
	const metricMap = todMetricMapForRange(range, mode);
	return palette.orderedTods
		.map((key) => ({
			key,
			label: todBucketLabel(key),
			value: metricMap.get(key) ?? 0,
			color: palette.todColors.get(key) ?? { r: 160, g: 160, b: 160 },
			tokens: range.todTokens.get(key) ?? 0,
			cost: range.todCost.get(key) ?? 0,
		}))
		.filter((row) => row.value > 0);
}

function rangeLabel(days: number): string {
	return days === 1 ? "today" : `${days}d`;
}

function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
	const prefix = days === 1 ? "Today" : `Last ${days} days`;
	const tokenPart = `${formatCount(range.totalTokens)} tokens`;
	const costPart = formatUsd(range.totalCost);
	const durationPart = formatDuration(range.totalDurationMs);

	if (mode === "cost") {
		return `${prefix}: ${costPart} · ${tokenPart} · ${durationPart}`;
	}
	if (mode === "duration") {
		return `${prefix}: ${durationPart} · ${tokenPart} · ${costPart}`;
	}
	return `${prefix}: ${tokenPart} · ${costPart} · ${durationPart}`;
}

function clampIndex(idx: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(length - 1, idx));
}

function aggregateCostMapForDays(days: DayAgg[], view: BreakdownView): Map<string, number> {
	const out = new Map<string, number>();
	for (const day of days) {
		const source =
			view === "cwd" ? asStringMap(day.costByCwd)
			: view === "tod" ? asStringMap(day.costByTod)
			: asStringMap(day.costByModel);
		for (const [key, value] of source) {
			out.set(key, (out.get(key) ?? 0) + value);
		}
	}
	return out;
}

function periodLabel(days: DayAgg[]): string {
	if (days.length === 1 && isHourKey(days[0].dayKeyLocal)) return formatHourLabel(days[0].date);
	if (days.length === 1) return `${days[0].dayKeyLocal} (${WEEKDAY_NAMES[mondayIndex(days[0].date)]})`;
	return `${formatShortDate(days[0].date)}–${formatShortDate(days[days.length - 1].date)}`;
}

interface SelectedBreakdownRows {
	rows: BreakdownShareRow[];
	total: number;
	hidden: number;
}

function selectedBreakdownLabel(view: BreakdownView, key: string, visibleKeys: readonly string[]): string {
	if (view === "cwd") return compactDirectoryLabel(key, visibleKeys, 42);
	if (view === "tod") return todBucketLabel(key as TodKey);
	return displayModelLabel(key, visibleKeys);
}

function selectedBreakdownRowsForDays(
	days: DayAgg[],
	view: BreakdownView,
	mode: MeasurementMode,
	maxRows: number,
): SelectedBreakdownRows {
	const valueMap = aggregateBreakdownForDays(days, view, mode);
	const costMap = aggregateCostMapForDays(days, view);
	const total = sumMapValues(valueMap);
	const ordered = view === "tod"
		? TOD_BUCKETS.map((bucket) => ({ key: bucket.key, value: valueMap.get(bucket.key) ?? 0 }))
		: sortMapByValueDesc(valueMap);
	const active = ordered.filter((row) => row.value > 0);
	const visible = active.slice(0, maxRows);
	const visibleKeys = visible.map((row) => row.key);
	return {
		total,
		hidden: Math.max(0, active.length - visible.length),
		rows: visible.map((row, idx) => ({
			key: row.key,
			label: selectedBreakdownLabel(view, row.key, visibleKeys),
			value: row.value,
			color: view === "tod" ? (TOD_PALETTE.get(row.key as TodKey) ?? PALETTE[idx % PALETTE.length]) : PALETTE[idx % PALETTE.length],
			cost: costMap.get(row.key) ?? 0,
		})),
	};
}

function renderSelectedBreakdownSection(
	title: string,
	keyHeader: string,
	breakdown: SelectedBreakdownRows,
	mode: MeasurementMode,
	width: number,
): string[] {
	if (breakdown.total <= 0 || breakdown.rows.length === 0) return [];
	const contentWidth = Math.max(28, Math.min(width, BREAKDOWN_CONTENT_MAX_WIDTH));
	const columns = computeShareDetailColumns(breakdown.rows, breakdown.total, contentWidth, mode);
	const lines = [dim(title)];
	lines.push(renderShareDetailHeader(keyHeader, contentWidth, mode, columns));
	for (const row of breakdown.rows) {
		lines.push(renderShareDetailRow(row, breakdown.total, contentWidth, mode, columns));
	}
	if (breakdown.hidden > 0) lines.push(dim(`  +${breakdown.hidden} more`));
	return lines;
}

function selectedBreakdownDescriptor(view: BreakdownView): { title: string; keyHeader: string; maxRows: number } {
	if (view === "cwd") return { title: "Dirs", keyHeader: "dir", maxRows: 5 };
	if (view === "tod") return { title: "Time", keyHeader: "time", maxRows: TOD_BUCKETS.length };
	return { title: "Models", keyHeader: "model", maxRows: 5 };
}

function topContextItemForDays(days: DayAgg[], view: BreakdownView, mode: MeasurementMode): string | null {
	const valueMap = aggregateBreakdownForDays(days, view, mode);
	const top = sortMapByValueDesc(valueMap)[0];
	if (!top || top.value <= 0) return null;
	return `${topBreakdownPrefix(view)} ${selectedBreakdownLabel(view, top.key, [top.key])}`;
}

function selectedContextItems(days: DayAgg[], activeView: BreakdownView, mode: MeasurementMode): string[] {
	const views: BreakdownView[] = ["model", "cwd", "tod"];
	return views
		.filter((view) => view !== activeView)
		.map((view) => topContextItemForDays(days, view, mode))
		.filter((item): item is string => !!item);
}

function renderSelectedPeriodDetails(label: string, days: DayAgg[], mode: MeasurementMode, width: number, activeView: BreakdownView): string[] {
	const lines: string[] = [];
	const totals = activityTotalsForDays(days);
	const selectedValue = days.reduce((sum, day) => sum + metricValueForDay(day, mode), 0);
	const isHour = days.length === 1 && isHourKey(days[0].dayKeyLocal);
	const periodKind = isHour ? "hour" : days.length === 1 ? "day" : "week";
	const summaryParts = [`${mode}: ${formatMetricValue(mode, selectedValue)}`];
	if (mode !== "duration") summaryParts.push(formatDuration(totals.durationMs));
	if (mode !== "tokens") summaryParts.push(`${formatCount(totals.tokens)} tokens`);
	if (mode !== "cost") summaryParts.push(formatUsd(totals.cost));
	lines.push(bold(isHour ? `Selected ${label} today` : `Selected ${periodKind} ${label}`));
	lines.push(summaryParts.join(" · "));

	if (totals.tokens === 0 && totals.cost === 0 && totals.durationMs === 0) {
		lines.push(dim(`No activity recorded for this ${periodKind}.`));
		return lines;
	}

	const section = selectedBreakdownDescriptor(activeView);
	const sectionLines = renderSelectedBreakdownSection(
		section.title,
		section.keyHeader,
		selectedBreakdownRowsForDays(days, activeView, mode, section.maxRows),
		mode,
		width,
	);
	if (sectionLines.length > 0) lines.push("", ...sectionLines);

	const context = selectedContextItems(days, activeView, mode);
	if (context.length > 0) lines.push("", dim(`Context: ${context.join(" · ")}`));

	return lines;
}

async function computeBreakdown(
	signal?: AbortSignal,
	onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
	const now = new Date();
	const ranges = new Map<number, RangeAgg>();
	for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
	const range90 = ranges.get(90)!;
	const start90 = range90.days[0].date;

	onProgress?.({ phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0, currentFile: undefined });

	const candidates = await walkSessionFiles(SESSION_ROOT, start90, signal, (found) => {
		onProgress?.({ phase: "scan", foundFiles: found });
	});

	const totalFiles = candidates.length;
	onProgress?.({
		phase: "parse",
		foundFiles: totalFiles,
		totalFiles,
		parsedFiles: 0,
		currentFile: totalFiles > 0 ? path.basename(candidates[0]!) : undefined,
	});

	let parsedFiles = 0;
	for (const filePath of candidates) {
		if (signal?.aborted) break;
		parsedFiles += 1;
		onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: path.basename(filePath) });

		const session = await parseSessionFile(filePath, signal);
		if (!session) continue;

		for (const d of RANGE_DAYS) {
			addSessionToRange(ranges.get(d)!, session);
		}
	}

	onProgress?.({ phase: "finalize", currentFile: undefined });

	const todPalette = buildTodPalette();
	return { ranges, todPalette };
}

class BreakdownComponent implements Component {
	private data: BreakdownData;
	private tui: TUI;
	private onDone: () => void;
	private rangeIndex = 0; // default today
	private measurement: MeasurementMode = "tokens";
	private view: BreakdownView = "model";
	private selectedDayKey?: string;
	private showDayDetails = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
		this.data = data;
		this.tui = tui;
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private currentRange(): RangeAgg {
		const selectedDays = RANGE_DAYS[this.rangeIndex];
		return this.data.ranges.get(selectedDays)!;
	}

	private activityPeriods(range = this.currentRange()): DayAgg[][] {
		const selectedDays = RANGE_DAYS[this.rangeIndex];
		if (selectedDays === 1) {
			const hours = activeHourBuckets(range, this.measurement);
			return (hours.length > 0 ? hours : range.days).map((day) => [day]);
		}
		return selectedDays >= 30 ? weekGroupsForRange(range) : range.days.map((day) => [day]);
	}

	private selectedPeriod(range = this.currentRange()): { days: DayAgg[]; label: string; index: number } {
		const periods = this.activityPeriods(range);
		const existingIndex = this.selectedDayKey
			? periods.findIndex((period) => period.some((day) => day.dayKeyLocal === this.selectedDayKey))
			: -1;
		const index = existingIndex >= 0 ? existingIndex : periods.length - 1;
		const days = periods[clampIndex(index, periods.length)];
		this.selectedDayKey = days[0].dayKeyLocal;
		return { days, label: periodLabel(days), index: clampIndex(index, periods.length) };
	}

	private moveSelectedRow(delta: number): void {
		const range = this.currentRange();
		const periods = this.activityPeriods(range);
		const current = this.selectedPeriod(range);
		const next = periods[clampIndex(current.index + delta, periods.length)];
		this.selectedDayKey = next[0].dayKeyLocal;
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || data.toLowerCase() === "t") {
			const order: MeasurementMode[] = ["tokens", "cost", "duration"];
			const idx = Math.max(0, order.indexOf(this.measurement));
			const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.measurement = order[(idx + order.length + dir) % order.length] ?? "tokens";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.comma)) {
			this.moveSelectedRow(-1);
			return;
		}
		if (matchesKey(data, Key.rightbracket) || matchesKey(data, Key.period)) {
			this.moveSelectedRow(1);
			return;
		}
		if (matchesKey(data, Key.leftbrace) || matchesKey(data, Key.lessthan)) {
			this.moveSelectedRow(-5);
			return;
		}
		if (matchesKey(data, Key.rightbrace) || matchesKey(data, Key.greaterthan)) {
			this.moveSelectedRow(5);
			return;
		}
		if (matchesKey(data, Key.enter) || data.toLowerCase() === "d") {
			this.showDayDetails = !this.showDayDetails;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const prev = () => {
			this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};
		const next = () => {
			this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};

		if (matchesKey(data, Key.left) || data.toLowerCase() === "h") prev();
		if (matchesKey(data, Key.right) || data.toLowerCase() === "l") next();

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data.toLowerCase() === "j" || data.toLowerCase() === "k") {
			const views: BreakdownView[] = ["model", "cwd", "tod"];
			const idx = views.indexOf(this.view);
			const dir = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
			this.view = views[(idx + views.length + dir) % views.length] ?? "model";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const rangeShortcut = Number(data);
		if (Number.isInteger(rangeShortcut) && rangeShortcut >= 1 && rangeShortcut <= RANGE_DAYS.length) {
			this.rangeIndex = rangeShortcut - 1;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const selectedDays = RANGE_DAYS[this.rangeIndex];
		const range = this.data.ranges.get(selectedDays)!;
		const metricKind = this.measurement;
		const selectedPeriod = this.selectedPeriod(range);

		const tab = (days: number, idx: number): string => {
			const selected = idx === this.rangeIndex;
			const label = rangeLabel(days);
			return selected ? bold(`[${label}]`) : dim(label);
		};

		const metricTab = (mode: MeasurementMode, label: string): string => {
			const selected = mode === this.measurement;
			return selected ? bold(`[${label}]`) : dim(label);
		};

		const viewTab = (v: BreakdownView, label: string): string => {
			const selected = v === this.view;
			return selected ? bold(`[${label}]`) : dim(label);
		};

		const viewLabel = this.view === "cwd" ? "dir" : this.view === "tod" ? "time" : "model";
		const rangeControls = `Range ←→  ${RANGE_DAYS.map((days, idx) => tab(days, idx)).join(" ")}`;
		const metricControls = `Metric tab  ${metricTab("tokens", "tokens")} ${metricTab("cost", "cost")} ${metricTab("duration", "duration")}`;
		const viewControls = `View  ↑↓  ${viewTab("model", "model")} ${viewTab("cwd", "dir")} ${viewTab("tod", "time")}`;

		// Choose colors and breakdown content based on current view
		let activeColorMap: Map<string, RGB>;
		let activeOtherColor: RGB = { r: 160, g: 160, b: 160 };
		let compactBreakdownBlock: string[] = [];

		if (this.view === "model") {
			const metricMap = modelMetricMapForRange(range, metricKind);
			const palette = choosePalette(metricMap);
			activeColorMap = palette.colors as Map<string, RGB>;
			const total = sumMapValues(metricMap);
			const rows = makeShareRows(palette.ordered, palette.colors, (key, visible) => displayModelLabel(key, visible), metricMap, activeOtherColor, range.modelTokens, range.modelCost);
			compactBreakdownBlock = renderCompactBreakdownSummary(`Top 5 models by ${metricKind}`, rows, total, metricKind, width);
		} else if (this.view === "cwd") {
			const metricMap = cwdMetricMapForRange(range, metricKind);
			const palette = choosePalette(metricMap);
			activeColorMap = palette.colors as Map<string, RGB>;
			const total = sumMapValues(metricMap);
			const rows = makeShareRows(palette.ordered, palette.colors, (key, visible) => compactDirectoryLabel(key, visible), metricMap, activeOtherColor, range.cwdTokens, range.cwdCost);
			compactBreakdownBlock = renderCompactBreakdownSummary(`Top 5 dirs by ${metricKind}`, rows, total, metricKind, width);
		} else {
			activeColorMap = this.data.todPalette.todColors as Map<string, RGB>;
			const total = sumMapValues(todMetricMapForRange(range, metricKind));
			const rows = todShareRows(range, metricKind, this.data.todPalette);
			compactBreakdownBlock = renderCompactBreakdownSummary(`Top time by ${metricKind}`, rows, total, metricKind, width);
		}

		const summary = rangeSummary(range, selectedDays, metricKind);

		const activityColumnWidth = width;
		const graphLines = renderHybridActivityLines(
			range,
			selectedDays,
			activeColorMap,
			activeOtherColor,
			metricKind,
			this.view,
			activityColumnWidth,
			selectedPeriod.days[0].dayKeyLocal,
		);
		const lines: string[] = [];
		const detailHint = this.showDayDetails ? "d compact" : "d details";
		const controlLines = width < 78
			? [
				`${bold("Usage breakdown")}  Range ←→ ${bold(`[${rangeLabel(selectedDays)}]`)} · Metric tab ${bold(`[${metricKind}]`)} · View ↑↓ ${bold(`[${viewLabel}]`)}`,
				`Row []  ${selectedPeriod.label} · ${detailHint} · q quit`,
			]
			: [
				bold("Usage breakdown"),
				`${rangeControls}  ·  ${metricControls}`,
				`${viewControls}  ·  Row []  ${selectedPeriod.label}  ·  ${detailHint}  q quit`,
			];
		for (const line of controlLines) lines.push(truncateToWidth(line, width));
		lines.push("");
		lines.push(truncateToWidth(summary, width));
		lines.push("");

		if (this.showDayDetails) {
			lines.push(truncateToWidth(dim(`Activity · top ${topBreakdownPrefix(this.view)}`), width));
			for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
			lines.push("");
			for (const dl of renderSelectedPeriodDetails(selectedPeriod.label, selectedPeriod.days, metricKind, width, this.view)) lines.push(truncateToWidth(dl, width));
		} else {
			for (const it of compactBreakdownBlock) lines.push(truncateToWidth(it, width));
			lines.push("");
			lines.push(truncateToWidth(dim(`Activity · top ${topBreakdownPrefix(this.view)}`), width));
			for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
			const selectedValue = selectedPeriod.days.reduce((sum, day) => sum + metricValueForDay(day, metricKind), 0);
			const selectedTop = topBreakdownForDays(selectedPeriod.days, this.view, metricKind, activeColorMap, activeOtherColor);
			const selectedTopText = selectedTop ? ` · top ${topBreakdownPrefix(this.view)} ${selectedTop.label}` : "";
			lines.push("");
			lines.push(
				truncateToWidth(
					dim(`Selected ${selectedPeriod.label} · ${metricKind}: ${formatMetricValue(metricKind, selectedValue)}${selectedTopText} · d details`),
					width,
				),
			);
		}


		// Ensure no overly long lines (truncateToWidth already), but keep at least 1 line.
		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		return this.cachedLines;
	}
}

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage-breakdown", {
		description: "Interactive usage breakdown for today and the last 7/30/90 days (tokens + cost + duration)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				// Non-interactive fallback: just notify.
				const data = await computeBreakdown(undefined);
				const range = data.ranges.get(30)!;
				pi.sendMessage(
					{
						customType: "usage-breakdown",
						content: `Usage breakdown (non-interactive)\n${rangeSummary(range, 30, "tokens")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			let aborted = false;
			const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
				const baseMessage = "Analyzing usage (last 90 days)…";
				const loader = new BorderedLoader(tui, theme, baseMessage);

				const startedAt = Date.now();
				const progress: BreakdownProgressState = {
					phase: "scan",
					foundFiles: 0,
					parsedFiles: 0,
					totalFiles: 0,
					currentFile: undefined,
				};

				const renderMessage = (): string => {
					const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
					if (progress.phase === "scan") {
						return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
					}
					if (progress.phase === "parse") {
						return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
					}
					return `${baseMessage}  finalizing · ${elapsed}s`;
				};

				let intervalId: NodeJS.Timeout | null = null;
				const stopTicker = () => {
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
				};

				// Update every 0.5s so long-running scans show some visible progress.
				setBorderedLoaderMessage(loader, renderMessage());
				intervalId = setInterval(() => {
					setBorderedLoaderMessage(loader, renderMessage());
				}, 500);

				loader.onAbort = () => {
					aborted = true;
					stopTicker();
					done(null);
				};

				computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
					.then((d) => {
						stopTicker();
						if (!aborted) done(d);
					})
					.catch((err) => {
						stopTicker();
						console.error("usage-breakdown: failed to analyze usage", err);
						if (!aborted) done(null);
					});

				return loader;
			});

			if (!data) {
				ctx.ui.notify(aborted ? "Cancelled" : "Failed to analyze sessions", aborted ? "info" : "error");
				return;
			}

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				return new BreakdownComponent(data, tui, done);
			});
		},
	});
}
