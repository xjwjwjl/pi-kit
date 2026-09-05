import { randomUUID } from "node:crypto";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { consumeResetCredit, fetchResetCredits, readCodexCredential } from "./reset-api.ts";
import {
	formatConsumeResetCreditResult,
	formatCreditChoice,
	formatResetCreditsResult,
} from "./reset-format.ts";
import { ResetCreditPicker, type ResetPickerResult } from "./reset-picker.ts";
import type {
	CodexCredential,
	ConsumeResetCreditRequest,
	ConsumeResetCreditResult,
	ResetCreditsResult,
} from "./types.ts";

const REQUEST_TIMEOUT_MS = 20_000;

type NotifyType = "info" | "warning" | "error";

export interface CodexQuotaCommandOptions {
	readCredential?: () => CodexCredential | null;
	fetchCredits?: (credential: CodexCredential, signal?: AbortSignal) => Promise<ResetCreditsResult>;
	consumeCredit?: (
		credential: CodexCredential,
		request: ConsumeResetCreditRequest,
		signal?: AbortSignal,
	) => Promise<ConsumeResetCreditResult>;
	uuid?: () => string;
	now?: () => Date;
	onReset?: () => void | Promise<void>;
	useLoaderUI?: boolean;
}

export function createCodexQuotaCommand(options: CodexQuotaCommandOptions = {}) {
	const readCredential = options.readCredential ?? readCodexCredential;
	const fetchCredits = options.fetchCredits ?? fetchResetCredits;
	const consumeCredit = options.consumeCredit ?? consumeResetCredit;
	const uuid = options.uuid ?? randomUUID;
	const now = options.now ?? (() => new Date());
	const useLoaderUI = options.useLoaderUI ?? true;

	return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const credential = readCredential();
		if (!credential) {
			notify(ctx, "No openai-codex OAuth credential found.", "warning");
			return;
		}

		let credits: ResetCreditsResult;
		try {
			credits = await withLoader(ctx, "Fetching Codex reset credits…", () =>
				fetchCredits(credential, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
				useLoaderUI,
			);
		} catch (error) {
			notify(ctx, describeError(error), "warning");
			return;
		}

		if (credits.status !== "success" || !credits.credits) {
			notify(ctx, formatResetCreditsResult(credits, now(), themeOf(ctx)), "warning");
			return;
		}
		if (credits.credits.availableCount <= 0) {
			notify(ctx, formatResetCreditsResult(credits, now(), themeOf(ctx)), "warning");
			return;
		}
		if (!ctx.hasUI) {
			notify(ctx, "Codex quota reset requires interactive confirmation.", "warning");
			return;
		}

		const creditId = await pickCredit(credits.credits, now(), ctx);
		if (creditId === null) {
			notify(ctx, "Codex quota reset cancelled.", "info");
			return;
		}

		// Non-TUI flow needs the confirmation dialog too (the picker stage has it built-in).
		if (ctx.mode !== "tui") {
			const confirmed = await ctx.ui.confirm(
				"Reset Codex quota?",
				"This action cannot be undone. The selected reset credit will be consumed.",
			);
			if (!confirmed) {
				notify(ctx, "Codex quota reset cancelled.", "info");
				return;
			}
		}

		const request: ConsumeResetCreditRequest = {
			idempotencyKey: uuid(),
			...(creditId ? { creditId } : {}),
		};
		let result: ConsumeResetCreditResult;
		try {
			result = await withLoader(ctx, "Consuming reset credit…", () =>
				consumeCredit(credential, request, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
				useLoaderUI,
			);
		} catch (error) {
			notify(ctx, describeError(error), "error");
			return;
		}
		notify(ctx, formatConsumeResetCreditResult(result, themeOf(ctx)), resultType(result));
		if (result.status === "success"
			&& (result.outcome === "reset" || result.outcome === "alreadyRedeemed")) {
			await options.onReset?.();
		}
	};
}

async function pickCredit(
	snapshot: NonNullable<ResetCreditsResult["credits"]>,
	now: Date,
	ctx: ExtensionCommandContext,
): Promise<string | undefined | null> {
	if (ctx.mode === "tui") {
		const result = await ctx.ui.custom<ResetPickerResult>(
			(tui, theme, keybindings, done) => {
				const picker = new ResetCreditPicker(snapshot.credits, now, theme, keybindings, done);
				return {
					render: (w: number) => picker.render(w),
					handleInput: (data: string) => {
						picker.handleInput(data);
						tui.requestRender();
					},
					invalidate: () => picker.invalidate(),
				};
			},
		);
		if ("cancelled" in result) return null;
		return result.creditId;
	}

	// Non-TUI fallback: keep the simpler select + confirm flow.
	if (snapshot.availableCount === 1 && snapshot.credits.length === 1) {
		return snapshot.credits[0]!.id;
	}
	if (snapshot.credits.length <= 1) return undefined;

	const choices = snapshot.credits.map((credit, index) => formatCreditChoice(credit, index, now));
	const selected = await ctx.ui.select("Select a Codex reset credit", choices);
	if (selected === undefined) return null;
	const index = choices.indexOf(selected);
	return index >= 0 ? snapshot.credits[index]!.id : null;
}

async function withLoader<T>(
	ctx: ExtensionCommandContext,
	message: string,
	action: () => Promise<T>,
	useLoaderUI = true,
): Promise<T> {
	if (ctx.mode !== "tui" || !useLoaderUI) return action();

	const result = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
		loader.onAbort = () => done({ error: new Error("cancelled") });
		void Promise.resolve()
			.then(action)
			.then(
				(value) => done({ value }),
				(error: unknown) => done({ error }),
			);
		return loader;
	});

	if ("error" in result) throw result.error;
	return result.value;
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function resultType(result: ConsumeResetCreditResult): NotifyType {
	if (result.status === "error") return "error";
	return result.status === "success" && (result.outcome === "reset" || result.outcome === "alreadyRedeemed")
		? "info"
		: "warning";
}

function themeOf(ctx: ExtensionCommandContext) {
	return ctx.hasUI ? ctx.ui.theme : undefined;
}

function notify(ctx: ExtensionCommandContext, message: string, type: NotifyType): void {
	ctx.ui.notify(message, type);
}
