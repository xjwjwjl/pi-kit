/** Bounded UI observations for one foreground call; never owns the child session. */
import { singleLine } from "./tool-format.ts";

export const ACTIVITY_LIMIT = 5;
const UPDATE_INTERVAL_MS = 750;

export type ProgressPhase = "queued" | "starting" | "running" | "cleanup" | "preparing";
const PHASES: ProgressPhase[] = ["queued", "starting", "running", "cleanup", "preparing"];
export type ActivityStatus = "running" | "done" | "failed" | "unfinished";
export interface ToolActivity {
	id: string;
	name: string;
	target?: string;
	status: ActivityStatus;
	durationMs?: number;
}
export interface ProgressSnapshot {
	version: 2;
	elapsedMs: number;
	phase?: ProgressPhase;
	toolUses: number;
	tools: ToolActivity[];
	slots: [ToolActivity | null, ToolActivity | null];
}
export type ProgressEvent =
	| { type: "phase"; phase: ProgressPhase }
	| { type: "tool-count"; count: number }
	| { type: "tool-start"; id: string; name: string; target?: string }
	| { type: "tool-end"; id: string; isError: boolean; durationMs?: number };
export type ProgressListener = (event: ProgressEvent) => void;

/** An observer, including a UI update callback, must never affect execution. */
export function publishProgress(listener: ProgressListener | undefined, event: ProgressEvent): void {
	try { listener?.(event); } catch { /* Observation is best-effort. */ }
}

function label(value: string, limit: number): string {
	return singleLine(value.slice(0, limit * 2)).slice(0, limit);
}

const BASH_LABELS: Record<string, string> = {
	rg: "rg", grep: "grep", fd: "fd", ls: "ls", pwd: "pwd", pytest: "pytest", tsc: "tsc",
	"npm test": "npm test", "npm run test": "npm run test", "npm run check": "npm run check",
	"npm run build": "npm run build", "npm run typecheck": "npm run typecheck",
	"pnpm test": "pnpm test", "pnpm run test": "pnpm run test", "pnpm run check": "pnpm run check",
};

/** Classify simple commands to constant labels. This is not a shell parser or an argument preview. */
function bashTarget(command: unknown): string | undefined {
	if (typeof command !== "string" || command.length > 4096 || /[\u0000-\u001f\u007f'"\\;&|<>`$(){}]/.test(command)) return undefined;
	const words = command.trim().split(/ +/, 3);
	for (const count of [3, 2, 1]) {
		const key = words.slice(0, count).join(" ");
		if (Object.hasOwn(BASH_LABELS, key)) return BASH_LABELS[key];
	}
	return undefined;
}

/** Known file paths or constant bash labels only; never serialize command arguments or output. */
export function toolTarget(name: string, args: unknown): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	if (name === "bash") return bashTarget((args as { command?: unknown }).command);
	if (!["read", "edit", "write"].includes(name)) return undefined;
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? label(path, 200) : undefined;
}

/** Timers belong to execute(), not renderers; finish() fences all late events. */
export class RunProgress {
	private readonly started: number;
	private readonly now: () => number;
	private readonly onUpdate: (snapshot: ProgressSnapshot) => void;
	private readonly active = new Map<string, ToolActivity>();
	private readonly tools: ToolActivity[] = [];
	private readonly slots: [ToolActivity | null, ToolActivity | null] = [null, null];
	private readonly completed = new WeakMap<ToolActivity, number>();
	private completionOrder = 0;
	private phase?: ProgressPhase;
	private toolUses = 0;
	private closed = false;
	private frozenElapsed = 0;
	private lastPublished = -Infinity;
	private pending?: ReturnType<typeof setTimeout>;
	private readonly heartbeat: ReturnType<typeof setInterval>;

	constructor(onUpdate: (snapshot: ProgressSnapshot) => void, now = () => performance.now()) {
		this.now = now;
		this.started = now();
		this.onUpdate = onUpdate;
		this.heartbeat = setInterval(() => this.schedule(), 1_000);
		this.heartbeat.unref();
	}

	update(event: ProgressEvent): void {
		if (this.closed || this.phase === "preparing") return;
		if (this.phase === "cleanup" && event.type !== "phase") return;
		switch (event.type) {
			case "phase":
				if (this.phase && PHASES.indexOf(event.phase) <= PHASES.indexOf(this.phase)) return;
				this.phase = event.phase;
				if (event.phase === "cleanup" || event.phase === "preparing") this.closeTools();
				break;
			case "tool-count":
				if (!Number.isSafeInteger(event.count) || event.count < this.toolUses || event.count === this.toolUses) return;
				this.toolUses = event.count;
				break;
			case "tool-start": {
				if (this.active.has(event.id) || this.tools.some((tool) => tool.id === event.id) || this.slots.some((tool) => tool?.id === event.id)) return;
				const tool: ToolActivity = { id: event.id, name: label(event.name, 80), status: "running",
					...(event.target !== undefined ? { target: label(event.target, 200) } : {}) };
				this.active.set(event.id, tool);
				this.tools.push(tool);
				if (this.tools.length > ACTIVITY_LIMIT) this.tools.shift();
				this.fillSlots();
				break;
			}
			case "tool-end": {
				const tool = this.active.get(event.id);
				if (!tool) return;
				tool.status = event.isError ? "failed" : "done";
				if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0) tool.durationMs = event.durationMs;
				this.completed.set(tool, ++this.completionOrder);
				this.active.delete(event.id);
				this.fillSlots();
				break;
			}
		}
		this.schedule();
	}

	/** Active rows are pinned; only empty or oldest-completed slots can be replaced. */
	private fillSlots(): void {
		for (const tool of this.active.values()) {
			if (this.slots.includes(tool)) continue;
			let index = this.slots.indexOf(null);
			if (index < 0) {
				let oldest = Infinity;
				for (const [candidate, shown] of this.slots.entries()) {
					if (!shown || shown.status === "running") continue;
					const order = this.completed.get(shown) ?? 0;
					if (order < oldest) { oldest = order; index = candidate; }
				}
			}
			if (index < 0) break;
			this.slots[index] = tool;
		}
	}

	private closeTools(): void {
		for (const tool of this.active.values()) tool.status = "unfinished";
		this.active.clear();
	}

	private snapshot(): ProgressSnapshot {
		return { version: 2, elapsedMs: this.closed ? this.frozenElapsed : Math.max(0, this.now() - this.started),
			phase: this.phase, toolUses: this.toolUses, tools: this.tools.map(copyActivity),
			slots: [this.slots[0] ? copyActivity(this.slots[0]) : null, this.slots[1] ? copyActivity(this.slots[1]) : null],
		};
	}

	private schedule(): void {
		if (this.closed) return;
		const delay = UPDATE_INTERVAL_MS - (this.now() - this.lastPublished);
		if (delay <= 0) this.flush();
		else if (this.pending === undefined) {
			this.pending = setTimeout(() => this.flush(), delay);
			this.pending.unref();
		}
	}

	private flush(): void {
		if (this.pending !== undefined) clearTimeout(this.pending);
		this.pending = undefined;
		if (this.closed) return;
		this.lastPublished = this.now();
		try { this.onUpdate(this.snapshot()); } catch { /* A broken renderer cannot fail a task. */ }
	}

	finish(): ProgressSnapshot {
		if (!this.closed) {
			this.frozenElapsed = Math.max(0, this.now() - this.started);
			this.closed = true;
			clearInterval(this.heartbeat);
			if (this.pending !== undefined) clearTimeout(this.pending);
			this.pending = undefined;
			this.closeTools();
		}
		return this.snapshot();
	}
}

function copyActivity(tool: ToolActivity): ToolActivity {
	return { ...tool, id: tool.id.slice(0, 200) };
}

const STATUSES: ActivityStatus[] = ["running", "done", "failed", "unfinished"];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function readActivity(raw: unknown): ToolActivity | undefined {
	const tool = object(raw);
	if (typeof tool.id !== "string" || typeof tool.name !== "string" || !STATUSES.includes(tool.status as ActivityStatus)) return undefined;
	return { id: tool.id.slice(0, 200), name: label(tool.name, 80), status: tool.status as ActivityStatus,
		...(typeof tool.target === "string" ? { target: label(tool.target, 200) } : {}),
		...(nonnegative(tool.durationMs) ? { durationMs: tool.durationMs } : {}),
	};
}

/** Current progress snapshots use a required, versioned shape; older snapshots are ignored. */
export function readProgress(value: unknown): ProgressSnapshot | undefined {
	const data = object(value);
	if (data.version !== 2 || !nonnegative(data.elapsedMs) || !Number.isSafeInteger(data.toolUses) || !nonnegative(data.toolUses)
		|| !Array.isArray(data.tools) || !Array.isArray(data.slots) || data.slots.length !== 2) return undefined;
	const tools: ToolActivity[] = [];
	for (const raw of data.tools.slice(-ACTIVITY_LIMIT)) {
		const tool = readActivity(raw);
		if (tool) tools.push(tool);
	}
	const slots: [ToolActivity | null, ToolActivity | null] = [readActivity(data.slots[0]) ?? null, readActivity(data.slots[1]) ?? null];
	if (slots[0] && slots[1]?.id === slots[0].id) slots[1] = null;
	return { version: 2, elapsedMs: data.elapsedMs, toolUses: data.toolUses,
		...(PHASES.includes(data.phase as ProgressPhase) ? { phase: data.phase as ProgressPhase } : {}), tools, slots,
	};
}
