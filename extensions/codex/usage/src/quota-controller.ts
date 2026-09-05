import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withDirectoryLock } from "./file-lock.ts";
import {
	credentialCacheKey,
	createCacheEntry,
	getQuotaCachePaths,
	hasAttemptedInRefreshWindow,
	isFreshCacheEntry,
	isRetryDue,
	loadPersistentCache,
	savePersistentCache,
	MAX_CACHED_CREDENTIALS,
	RETRY_MAX_ATTEMPTS,
	type QuotaCachePaths,
} from "./quota-cache.ts";
import { REFRESH_INTERVAL_MS, windowBoundary } from "./quota.ts";
import { formatQuotaStatus, isCodexModel, safePaint, safeSetStatus, unavailableStatus } from "./quota-status.ts";
import { fetchUsage, readCodexCredential } from "./usage-api.ts";
import type { CacheEntry, CodexCredential, UsageResult } from "./types.ts";

export interface QuotaControllerOptions {
	readCredential?: () => CodexCredential | null;
	fetchUsage?: (credential: CodexCredential, signal?: AbortSignal) => Promise<UsageResult>;
	cachePaths?: QuotaCachePaths;
	now?: () => number;
}

export class QuotaController {
	private readonly readCredential: () => CodexCredential | null;
	private readonly fetchUsage: (credential: CodexCredential, signal?: AbortSignal) => Promise<UsageResult>;
	private readonly cachePaths: QuotaCachePaths;
	private readonly now: () => number;
	private readonly cache = new Map<string, CacheEntry>();
	private persistentCache: ReturnType<typeof loadPersistentCache>;
	private currentCtx: ExtensionContext | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshController = new AbortController();
	private refreshPromise: Promise<void> | undefined;
	private stopped = true;

	constructor(options: QuotaControllerOptions = {}) {
		this.readCredential = options.readCredential ?? readCodexCredential;
		this.fetchUsage = options.fetchUsage ?? fetchUsage;
		this.cachePaths = options.cachePaths ?? getQuotaCachePaths();
		try {
			mkdirSync(dirname(this.cachePaths.cacheFile), { recursive: true });
		} catch {
			// Cache persistence is best effort; refresh will still report its result.
		}
		this.now = options.now ?? Date.now;
		this.persistentCache = loadPersistentCache(this.cachePaths, this.now());
	}

	start(ctx: ExtensionContext): void {
		this.refreshController.abort();
		this.refreshPromise = undefined;
		this.refreshController = new AbortController();
		this.stopRefreshTimer();
		this.stopRetryTimer();
		this.currentCtx = ctx;
		this.stopped = false;
		this.startRefreshTimer(ctx);
		this.showCachedStatus(ctx, true);
		this.runRefresh(ctx);
		this.scheduleRetryTimer(ctx);
	}

	stop(ctx: ExtensionContext): void {
		this.stopped = true;
		this.refreshController.abort();
		this.currentCtx = undefined;
		this.stopRefreshTimer();
		this.stopRetryTimer();
		safeSetStatus(ctx, undefined);
	}

	handleModelSelected(ctx: ExtensionContext, model: unknown): void {
		if (this.stopped) return;
		if (!isCodexModel(model)) {
			safeSetStatus(ctx, undefined, model);
			return;
		}
		this.showCachedStatus(ctx, true, model);
	}

	handleCredentialChanged(): void {
		const ctx = this.currentCtx;
		if (!ctx || this.stopped) return;
		this.refreshController.abort();
		this.refreshPromise = undefined;
		this.refreshController = new AbortController();
		this.stopRetryTimer();
		this.showCachedStatus(ctx, true);
		this.runRefresh(ctx);
		this.scheduleRetryTimer(ctx);
	}

	async refreshIfDue(): Promise<void> {
		const ctx = this.currentCtx;
		if (!ctx || this.stopped) return;
		await this.refresh(ctx);
	}

	async applyCommandResult(
		credential: CodexCredential,
		result: UsageResult,
		observedAt: Date,
	): Promise<void> {
		if (result.status === "cancelled") return;
		const observedAtMs = observedAt.getTime();
		const saved = await withDirectoryLock(this.cachePaths.refreshLock, async () => {
			const latest = this.getCachedEntry(credential.access, true);
			if (latest && latest.lastAttemptAt > observedAtMs) return latest;

			const entry = createCacheEntry(latest, result, observedAtMs);
			const persisted = savePersistentCache(credential, entry, this.cachePaths);
			const savedEntry = persisted[credentialCacheKey(credential.access)] ?? entry;
			this.remember(credential.access, savedEntry);
			return savedEntry;
		});

		if (!saved || this.stopped || !this.currentCtx) return;
		if (this.readCredential()?.access !== credential.access) return;
		const ctx = this.currentCtx;
		this.setStatus(ctx, saved.result);
		this.scheduleRetryTimer(ctx, saved);
	}

	private async refresh(ctx: ExtensionContext): Promise<void> {
		const signal = this.refreshController.signal;
		let credential: CodexCredential | null = null;
		try {
			credential = this.readCredential();
			if (!credential) {
				safeSetStatus(ctx, undefined);
				return;
			}
			const activeCredential = credential;
			this.setRefreshing(ctx);

			const entry = await withDirectoryLock(this.cachePaths.refreshLock, async () => {
				if (signal.aborted) return undefined;
				const refreshBoundary = windowBoundary(this.now());
				const latest = this.getCachedEntry(activeCredential.access, true);
				if (latest && latest.lastAttemptAt < refreshBoundary) this.stopRetryTimer();
				if (latest && isFreshCacheEntry(latest, refreshBoundary)) return latest;
				if (latest
					&& hasAttemptedInRefreshWindow(latest, refreshBoundary)
					&& !isRetryDue(latest, this.now())) return latest;

				const result = await this.fetchUsage(activeCredential, signal);
				if (signal.aborted || result.status === "cancelled") return undefined;
				const observedAt = this.now();
				const next = createCacheEntry(latest, result, observedAt);
				const persisted = savePersistentCache(activeCredential, next, this.cachePaths);
				const saved = persisted[credentialCacheKey(activeCredential.access)] ?? next;
				this.remember(activeCredential.access, saved);
				return saved;
			}, signal);

			if (!entry || signal.aborted || this.stopped || this.currentCtx !== ctx) return;
			if (this.readCredential()?.access !== activeCredential.access) return;
			this.setStatus(ctx, entry.result);
			this.scheduleRetryTimer(ctx, entry);
		} catch {
			if (signal.aborted || this.stopped || this.currentCtx !== ctx) return;
			if (!credential || this.readCredential()?.access === credential.access) {
				safeSetStatus(ctx, unavailableStatus(safePaint(ctx)));
				this.scheduleRetryTimer(ctx);
			}
		}
	}

	private runRefresh(ctx: ExtensionContext): void {
		if (this.refreshPromise) return;
		const promise = this.refresh(ctx)
			.catch(() => undefined)
			.finally(() => {
				if (this.refreshPromise === promise) this.refreshPromise = undefined;
			});
		this.refreshPromise = promise;
	}

	private showCachedStatus(ctx: ExtensionContext, reload: boolean, model?: unknown): void {
		try {
			const credential = this.readCredential();
			if (!credential) {
				safeSetStatus(ctx, undefined, model);
				return;
			}
			const entry = this.getCachedEntry(credential.access, reload);
			if (!entry) {
				safeSetStatus(ctx, undefined, model);
				return;
			}
			this.setStatus(ctx, entry.result, model);
		} catch {
			safeSetStatus(ctx, unavailableStatus(safePaint(ctx)), model);
		}
	}

	private getCachedEntry(access: string, reload: boolean): CacheEntry | undefined {
		const key = credentialCacheKey(access);
		const cached = this.cache.get(access);
		const persisted = reload
			? loadPersistentCache(this.cachePaths, this.now())[key]
			: this.persistentCache[key];
		if (persisted && (!cached || persisted.lastAttemptAt > cached.lastAttemptAt)) {
			this.persistentCache[key] = persisted;
			this.remember(access, persisted);
			return persisted;
		}
		return cached ?? persisted;
	}

	private remember(access: string, entry: CacheEntry): void {
		this.cache.delete(access);
		this.cache.set(access, entry);
		this.persistentCache[credentialCacheKey(access)] = entry;
		while (this.cache.size > MAX_CACHED_CREDENTIALS) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	private setStatus(ctx: ExtensionContext, result: UsageResult, model?: unknown): void {
		safeSetStatus(ctx, formatQuotaStatus(result, safePaint(ctx)), model);
	}

	private setRefreshing(ctx: ExtensionContext): void {
		safeSetStatus(ctx, safePaint(ctx)("muted", "Codex·refreshing"));
	}

	private startRefreshTimer(ctx: ExtensionContext): void {
		this.stopRefreshTimer();
		try {
			const now = this.now();
			const nextBoundary = (Math.floor(now / REFRESH_INTERVAL_MS) + 1) * REFRESH_INTERVAL_MS;
			this.refreshTimer = setTimeout(() => {
				this.refreshTimer = undefined;
				if (this.stopped || this.currentCtx !== ctx) return;
				this.runRefresh(ctx);
				this.startRefreshTimer(ctx);
			}, Math.max(1, nextBoundary - now));
			this.refreshTimer.unref?.();
		} catch {
			this.refreshTimer = undefined;
		}
	}

	private stopRefreshTimer(): void {
		if (!this.refreshTimer) return;
		try {
			clearTimeout(this.refreshTimer);
		} catch {
			// Timer cleanup is best effort.
		}
		this.refreshTimer = undefined;
	}

	private scheduleRetryTimer(ctx: ExtensionContext, entry?: CacheEntry): void {
		this.stopRetryTimer();
		if (this.stopped || this.currentCtx !== ctx) return;
		let current = entry;
		if (!current) {
			const credential = this.readCredential();
			if (!credential) return;
			current = this.getCachedEntry(credential.access, true);
		}
		if (!current || current.retryCount <= 0
			|| current.retryCount >= RETRY_MAX_ATTEMPTS
			|| current.nextRetryAt === undefined) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.stopped || this.currentCtx !== ctx) return;
			this.runRefresh(ctx);
		}, Math.max(1, current.nextRetryAt - this.now()));
		this.retryTimer.unref?.();
	}

	private stopRetryTimer(): void {
		if (!this.retryTimer) return;
		try {
			clearTimeout(this.retryTimer);
		} catch {
			// Timer cleanup is best effort.
		}
		this.retryTimer = undefined;
	}
}

