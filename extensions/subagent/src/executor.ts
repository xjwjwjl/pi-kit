import { cancelIfRequested, cancelledOutcome, failedOutcome, type RunOutcome } from "./outcome.ts";
import { runOnce, type RunOnceOptions } from "./runner.ts";
import { publishProgress } from "./progress.ts";

export interface ForegroundExecutorOptions {
	maxConcurrent?: number;
	shutdownTimeoutMs?: number;
	run?: (options: RunOnceOptions) => Promise<RunOutcome>;
}

interface PendingCall {
	options: RunOnceOptions;
	controller: AbortController;
	resolve: (outcome: RunOutcome) => void;
	detachCaller: () => void;
	onQueuedAbort: () => void;
}

/** Own only in-flight calls; runOnce owns all SDK session cleanup. */
export class ForegroundExecutor {
	private readonly maxConcurrent: number;
	private readonly shutdownTimeoutMs: number;
	private readonly run: (options: RunOnceOptions) => Promise<RunOutcome>;
	private readonly active = new Map<AbortController, Promise<void>>();
	private readonly queue: PendingCall[] = [];
	private closed = false;
	private shutdown: Promise<void> | undefined;

	constructor(options: ForegroundExecutorOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 10;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
		this.run = options.run ?? runOnce;
		if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
			throw new RangeError("maxConcurrent must be a positive safe integer");
		}
		if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 0) {
			throw new RangeError("shutdownTimeoutMs must be finite and non-negative");
		}
	}

	get runningCount(): number {
		return this.active.size;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	execute(options: RunOnceOptions): Promise<RunOutcome> {
		if (this.closed) return Promise.resolve(failedOutcome("Foreground executor is disposed"));
		if (options.signal?.aborted) return Promise.resolve(cancelledOutcome());

		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort();
		return new Promise<RunOutcome>((resolve) => {
			const call: PendingCall = {
				options,
				controller,
				resolve,
				detachCaller: () => options.signal?.removeEventListener("abort", forwardAbort),
				onQueuedAbort: () => {
					const index = this.queue.indexOf(call);
					if (index < 0) return;
					this.queue.splice(index, 1);
					controller.signal.removeEventListener("abort", call.onQueuedAbort);
					call.detachCaller();
					resolve(cancelledOutcome());
				},
			};
			this.queue.push(call);
			controller.signal.addEventListener("abort", call.onQueuedAbort, { once: true });
			options.signal?.addEventListener("abort", forwardAbort, { once: true });
			publishProgress(options.onProgress, { type: "phase", phase: "queued" });
			this.drain();
		});
	}

	private drain(): void {
		while (!this.closed && this.active.size < this.maxConcurrent && this.queue.length > 0) {
			const call = this.queue.shift()!;
			call.controller.signal.removeEventListener("abort", call.onQueuedAbort);
			// Register the permit before invoking injected code, including sync throws.
			const work = Promise.resolve().then(async () => {
				try {
					// Cancellation can land after a permit is granted but before run starts.
					if (!call.controller.signal.aborted) publishProgress(call.options.onProgress, { type: "phase", phase: "starting" });
					if (call.controller.signal.aborted) call.resolve(cancelledOutcome());
					else call.resolve(cancelIfRequested(await this.run({ ...call.options, signal: call.controller.signal }), call.controller.signal));
				} catch (error) {
					call.resolve(call.controller.signal.aborted ? cancelledOutcome() : failedOutcome(error));
				} finally {
					call.detachCaller();
					this.active.delete(call.controller);
					this.drain();
				}
			});
			this.active.set(call.controller, work);
		}
	}

	/** Abort cooperatively and wait at most the deadline, never force-kill tools. */
	dispose(): Promise<void> {
		if (this.shutdown) return this.shutdown;
		this.closed = true;
		// Publish the shutdown promise before abort listeners can re-enter dispose.
		const controllers = [...this.active.keys(), ...this.queue.map((call) => call.controller)];
		this.shutdown = this.waitForActive([...this.active.values()]);
		for (const controller of controllers) controller.abort();
		return this.shutdown;
	}

	private async waitForActive(work: Promise<void>[]): Promise<void> {
		if (work.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(work),
				new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownTimeoutMs); }),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}
