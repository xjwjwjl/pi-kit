import type {
	MetricTotals,
	ModelAggregate,
	ProviderAggregate,
	RequestSortKey,
	ScopeAggregate,
	SortKey,
	TimeRange,
	TokenEvent,
	TrendBucket,
} from "./types.ts";
import { rangeUnit } from "./time-range.ts";

export function eventTokens(event: TokenEvent): number {
	return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
}

export function emptyTotals(): MetricTotals {
	return {
		tokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		requests: 0,
	};
}

export function addEvent(totals: MetricTotals, event: TokenEvent): void {
	totals.inputTokens += event.inputTokens;
	totals.outputTokens += event.outputTokens;
	totals.cacheReadTokens += event.cacheReadTokens;
	totals.cacheWriteTokens += event.cacheWriteTokens;
	totals.tokens += eventTokens(event);
	totals.cost += event.cost;
	totals.requests++;
}

export function totalsForEvents(events: readonly TokenEvent[]): MetricTotals {
	const totals = emptyTotals();
	for (const event of events) addEvent(totals, event);
	return totals;
}

function queryTerms(query: string): string[] {
	return query
		.match(/"[^"]+"|\S+/g)
		?.map((term) => term.replace(/^"|"$/g, "").toLocaleLowerCase())
		.filter(Boolean) ?? [];
}

export function matchesEvent(event: TokenEvent, query: string): boolean {
	const terms = queryTerms(query);
	if (terms.length === 0) return true;
	const searchable = [
		event.provider,
		event.model,
		event.requestedModel ?? "",
		event.scope,
		event.stopReason ?? "",
		event.sessionId,
		event.entryId,
	].join(" ").toLocaleLowerCase();
	return terms.every((term) => searchable.includes(term));
}

export function filterEvents(events: readonly TokenEvent[], query: string): TokenEvent[] {
	return events.filter((event) => matchesEvent(event, query));
}

function compareTotals(a: MetricTotals, b: MetricTotals, sort: SortKey): number {
	if (sort === "cost") return b.cost - a.cost || b.tokens - a.tokens;
	if (sort === "requests") return b.requests - a.requests || b.tokens - a.tokens;
	return b.tokens - a.tokens || b.cost - a.cost;
}

function groupEvents<K extends string>(events: readonly TokenEvent[], keyOf: (event: TokenEvent) => K): Map<K, TokenEvent[]> {
	const groups = new Map<K, TokenEvent[]>();
	for (const event of events) {
		const key = keyOf(event);
		const group = groups.get(key);
		if (group) group.push(event);
		else groups.set(key, [event]);
	}
	return groups;
}

export function providerAggregates(events: readonly TokenEvent[], sort: SortKey): ProviderAggregate[] {
	const rows = [...groupEvents(events, (event) => event.provider)].map(([provider, grouped]) => ({
		key: provider,
		provider,
		totals: totalsForEvents(grouped),
		models: modelAggregates(grouped, sort),
	}));
	return rows.sort((a, b) => compareTotals(a.totals, b.totals, sort) || a.provider.localeCompare(b.provider));
}

export function modelAggregates(events: readonly TokenEvent[], sort: SortKey): ModelAggregate[] {
	const rows = [...groupEvents(events, (event) => `${event.provider}/${event.model}`)].map(([key, grouped]) => {
		const first = grouped[0]!;
		return {
			key,
			provider: first.provider,
			model: first.model,
			totals: totalsForEvents(grouped),
		};
	});
	return rows.sort((a, b) => compareTotals(a.totals, b.totals, sort) || a.key.localeCompare(b.key));
}

function scopeGroupKey(scope: string): string {
	const normalized = scope.replace(/[\\/]+/g, "/").replace(/\/$/, "") || "/";
	return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export function scopeAggregates(events: readonly TokenEvent[], sort: SortKey): ScopeAggregate[] {
	const rows = [...groupEvents(events, (event) => scopeGroupKey(event.scope))].map(([key, grouped]) => ({
		key,
		scope: grouped[0]?.scope ?? key,
		totals: totalsForEvents(grouped),
		providers: providerAggregates(grouped, sort),
	}));
	return rows.sort((a, b) => compareTotals(a.totals, b.totals, sort) || a.scope.localeCompare(b.scope));
}

export function sortRequests(events: readonly TokenEvent[], sort: RequestSortKey): TokenEvent[] {
	return [...events].sort((a, b) => {
		if (sort === "cost") return b.cost - a.cost || b.timestampMs - a.timestampMs;
		if (sort === "tokens") return eventTokens(b) - eventTokens(a) || b.timestampMs - a.timestampMs;
		return b.timestampMs - a.timestampMs || a.entryId.localeCompare(b.entryId);
	});
}

function floorBucket(timestampMs: number, unit: "hour" | "day"): Date {
	const date = new Date(timestampMs);
	if (unit === "hour") date.setMinutes(0, 0, 0);
	else date.setHours(0, 0, 0, 0);
	return date;
}

function nextBucket(date: Date, unit: "hour" | "day"): Date {
	const next = new Date(date);
	if (unit === "hour") next.setHours(next.getHours() + 1);
	else next.setDate(next.getDate() + 1);
	return next;
}

function bucketLabel(date: Date, unit: "hour" | "day"): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return unit === "hour"
		? `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:00`
		: `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

export function trendBuckets(events: readonly TokenEvent[], range: TimeRange): TrendBucket[] {
	const unit = rangeUnit(range);
	const buckets: TrendBucket[] = [];
	let cursor = floorBucket(range.startMs, unit);
	while (cursor.getTime() < range.endMs) {
		const next = nextBucket(cursor, unit);
		buckets.push({
			label: bucketLabel(cursor, unit),
			startMs: cursor.getTime(),
			endMs: next.getTime(),
			totals: emptyTotals(),
		});
		cursor = next;
	}

	for (const event of events) {
		const bucket = buckets.find((candidate) => event.timestampMs >= candidate.startMs && event.timestampMs < candidate.endMs);
		if (bucket) addEvent(bucket.totals, event);
	}
	return buckets;
}
