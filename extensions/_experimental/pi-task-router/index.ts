import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT,
	beginStrictFlashFirstTurn,
	completeStrictFlashFirstTurn,
	emptyRouterState,
	effectiveMode,
	guidanceFor,
	isDeepSeekV4,
	isDeepSeekV4Flash,
	isStrictFlashFirstTurnActive,
	isStrictFlashFirstTurnPending,
	modeSource,
	normalizeRouterState,
	parseRouterCommand,
	strictFlashFirstTurnTools,
	withoutOverride,
	withAutoMode,
	withOverride,
	type RouterState,
} from "./src/router-core.ts";

export const ROUTER_STATE_ENTRY = "pi-task-router-state";
const STATUS_KEY = "pi-task-router";

interface StoredRouterEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function isStoredRouterEntry(value: unknown): value is StoredRouterEntry {
	return typeof value === "object" && value !== null;
}

/** Return the most recent router state on the active branch only. */
export function stateFromEntries(entries: readonly unknown[]): RouterState {
	let state = emptyRouterState();

	for (const entry of entries) {
		if (!isStoredRouterEntry(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== ROUTER_STATE_ENTRY) continue;
		state = normalizeRouterState(entry.data);
	}

	return state;
}

function modelName(ctx: ExtensionContext): string {
	if (!ctx.model) return "no model selected";
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function statusText(state: RouterState, ctx: ExtensionContext): string {
	if (!isDeepSeekV4(ctx.model)) return "router: inactive";
	if (isDeepSeekV4Flash(ctx.model) && isStrictFlashFirstTurnActive(state)) return "router: strict first turn";

	const mode = effectiveMode(state);
	const source = modeSource(state);
	if (!mode || !source) return "router: waiting";
	return `router: ${mode} (${source})`;
}

function setRouterStatus(state: RouterState, ctx: ExtensionContext): void {
	const text = statusText(state, ctx);
	if (text.endsWith("inspect (auto)") || text.endsWith("inspect (manual)")) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", text));
		return;
	}
	if (text.endsWith("act (auto)") || text.endsWith("act (manual)") || text === "router: strict first turn") {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

function statusMessage(state: RouterState, ctx: ExtensionContext): string {
	const model = modelName(ctx);
	const mode = effectiveMode(state);
	const source = modeSource(state);

	if (!isDeepSeekV4(ctx.model)) {
		const retained = mode && source ? ` Stored route: ${mode} (${source}).` : "";
		return `Task router is inactive for ${model}; it applies only to DeepSeek V4 Pro or Flash.${retained}`;
	}

	if (isDeepSeekV4Flash(ctx.model) && isStrictFlashFirstTurnActive(state)) {
		return `Task router is applying the strict Flash first-turn profile for ${model}; the original tool set restores after its first tool-call decision or final settlement.`;
	}

	if (!mode || !source) {
		return `Task router is waiting for this session's first DeepSeek V4 request (${model}).`;
	}

	return `Task router: ${mode} (${source}) for ${model}. Use /router inspect|act|neutral|auto.`;
}

export default function piTaskRouterExtension(pi: ExtensionAPI): void {
	let state = emptyRouterState();

	function persistState(): void {
		pi.appendEntry<RouterState>(ROUTER_STATE_ENTRY, state);
	}

	function restoreStrictFlashTools(ctx: ExtensionContext): void {
		if (!isStrictFlashFirstTurnActive(state)) return;
		const restoreTools = state.flashFirstTurnRestoreTools;
		if (restoreTools?.length) pi.setActiveTools(restoreTools);
		state = completeStrictFlashFirstTurn(state);
		persistState();
		setRouterStatus(state, ctx);
	}

	function restoreState(ctx: ExtensionContext): void {
		state = stateFromEntries(ctx.sessionManager.getBranch());
		// A reload, resume, or branch switch cannot resume an in-flight strict
		// request safely. Restore the recorded tool surface and mark it consumed.
		restoreStrictFlashTools(ctx);
		setRouterStatus(state, ctx);
	}

	pi.registerCommand("router", {
		description: "Show or override the DeepSeek V4 task route: inspect, act, neutral, or auto.",
		handler: async (args, ctx) => {
			const command = parseRouterCommand(args);

			switch (command.kind) {
				case "status":
					setRouterStatus(state, ctx);
					ctx.ui.notify(statusMessage(state, ctx), "info");
					return;
				case "set":
					state = withOverride(state, command.mode);
					persistState();
					setRouterStatus(state, ctx);
					ctx.ui.notify(`Task router override set to ${command.mode} for this session branch.`, "info");
					return;
				case "auto":
					if (state.overrideMode) {
						state = withoutOverride(state);
						persistState();
					}
					setRouterStatus(state, ctx);
					ctx.ui.notify(statusMessage(state, ctx), "info");
					return;
				case "invalid":
					ctx.ui.notify(
						`Unknown router mode "${command.input}". Use /router [inspect|act|neutral|auto].`,
						"error",
					);
			}
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!isDeepSeekV4(ctx.model)) {
			setRouterStatus(state, ctx);
			return;
		}

		const nextState = withAutoMode(state, event.prompt);
		if (nextState !== state) {
			state = nextState;
			persistState();
		}

		const mode = effectiveMode(state);
		const strictPending = isDeepSeekV4Flash(ctx.model) && isStrictFlashFirstTurnPending(state);
		const strictTools = strictPending && mode !== "neutral"
			? strictFlashFirstTurnTools(pi.getActiveTools())
			: undefined;

		if (strictTools) {
			state = beginStrictFlashFirstTurn(state, pi.getActiveTools());
			persistState();
			pi.setActiveTools(strictTools);
			setRouterStatus(state, ctx);
			return { systemPrompt: STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT };
		}
		if (strictPending) {
			// This was still the first Flash request. Do not defer strict mode to a
			// later turn if the task is neutral or the exact tool surface is absent.
			state = completeStrictFlashFirstTurn(state);
			persistState();
		}

		setRouterStatus(state, ctx);
		const guidance = mode ? guidanceFor(mode) : undefined;
		if (!guidance) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	// Mirror the source preset's promotion point: once the restricted first
	// response has chosen a tool, expose the original tool surface for its next
	// continuation. If no tool is called, agent_end / agent_settled restore it.
	pi.on("message_end", (event, ctx) => {
		if (
			event.message.role === "assistant" &&
			Array.isArray(event.message.content) &&
			event.message.content.some((block) => block.type === "toolCall")
		) {
			restoreStrictFlashTools(ctx);
		}
	});
	pi.on("agent_end", (event, ctx) => {
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.role !== "assistant" || (lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "length")) {
			restoreStrictFlashTools(ctx);
		}
	});
	// A retryable failure or overflow recovery may skip restoration at agent_end.
	// agent_settled is the final safety net once no retry remains.
	pi.on("agent_settled", (_event, ctx) => {
		restoreStrictFlashTools(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		setRouterStatus(state, ctx);
	});
}
