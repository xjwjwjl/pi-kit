/**
 * Pure routing helpers for the experimental Pi task router.
 *
 * The Flash first-turn profile is deliberately a narrow, observable interface
 * experiment. It does not make claims about a model's internal reasoning
 * mechanism or guarantee a particular reasoning prefix.
 */

export const ROUTES = ["inspect", "act", "neutral"] as const;
export const STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";
export const STRICT_FLASH_FIRST_TURN_TOOLS = ["bash", "edit"] as const;

const DEEPSEEK_V4_IDS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const DEEPSEEK_V4_FLASH_ID = "deepseek-v4-flash";

export type Route = (typeof ROUTES)[number];
export type RouteSource = "auto" | "manual";

export interface RouterState {
	version: 2;
	autoMode?: Route;
	overrideMode?: Route;
	/** The strict Flash profile has already been consumed for this branch. */
	flashFirstTurnCompleted?: true;
	/** Active strict profile recovery data; removed at promotion or final settlement. */
	flashFirstTurnRestoreTools?: string[];
}

export interface ModelLike {
	id?: unknown;
	provider?: unknown;
}

export type RouterCommand =
	| { kind: "status" }
	| { kind: "auto" }
	| { kind: "set"; mode: Route }
	| { kind: "invalid"; input: string };

const INSPECT_PATTERNS = [
	/修复/i,
	/排查/i,
	/调试/i,
	/报错/i,
	/错误/i,
	/异常/i,
	/故障/i,
	/崩溃/i,
	/审查/i,
	/评审/i,
	/重构/i,
	/维护/i,
	/迁移/i,
	/升级/i,
	/兼容/i,
	/诊断/i,
	/分析/i,
	/优化/i,
	/回归/i,
	/性能/i,
	/测试失败/i,
	/\bbug\b/i,
	/\bfix\b/i,
	/\bdebug\b/i,
	/\btroubleshoot\b/i,
	/\berror\b/i,
	/\bcrash\b/i,
	/\breview\b/i,
	/\baudit\b/i,
	/\brefactor\b/i,
	/\bmaintain\b/i,
	/\brepair\b/i,
	/\bmigrat(?:e|ion)\b/i,
	/\bupgrade\b/i,
	/\bcompat(?:ible|ibility)?\b/i,
	/\bdiagnos(?:e|is|tic)\b/i,
	/\banaly[sz](?:e|ing|is)\b/i,
	/\boptimi[sz](?:e|ation|ing)\b/i,
	/\bregression\b/i,
	/\bperformance\b/i,
	/\bbroken\b/i,
] as const;

const ACT_PATTERNS = [
	/新建/i,
	/创建/i,
	/开发/i,
	/实现/i,
	/构建/i,
	/搭建/i,
	/生成/i,
	/编写/i,
	/从零/i,
	/制作/i,
	/做一个/i,
	/写一个/i,
	/落地/i,
	/交付/i,
	/上线/i,
	/部署/i,
	/发布/i,
	/新增/i,
	/扩展/i,
	/\bbuild\b/i,
	/\bcreate\b/i,
	/\bdevelop\b/i,
	/\bimplement\b/i,
	/\bgenerate\b/i,
	/\bscaffold\b/i,
	/\bbootstrap\b/i,
	/\bship\b/i,
	/\bdeploy\b/i,
	/\blaunch\b/i,
	/\bwrite\b/i,
	/\badd\b/i,
	/\bmake\b/i,
	/\bnew\s+(?:feature|project|app|site|tool)\b/i,
] as const;

const INSPECT_GUIDANCE = `## Task route: inspect
This session is routed for maintenance, debugging, review, or analysis. Establish evidence from the repository before changing files. Prefer narrowly scoped changes that preserve existing behavior, then verify the relevant behavior after changes. This is advisory only: the user's request and Pi's tool and safety rules remain authoritative.`;

const ACT_GUIDANCE = `## Task route: act
This session is routed for implementation or delivery. Make a brief design decision, inspect enough local context, then deliver focused changes using existing patterns. Verify the result when practical and avoid unrelated ceremony. This is advisory only: the user's request and Pi's tool and safety rules remain authoritative.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const names = new Set<string>();
	for (const item of value) {
		if (typeof item === "string" && item.trim() !== "") names.add(item);
	}
	return names.size > 0 ? [...names] : undefined;
}

export function isRoute(value: unknown): value is Route {
	return typeof value === "string" && (ROUTES as readonly string[]).includes(value);
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
	return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

/**
 * A deliberately small keyword classifier. Ties and unmatched prompts fall
 * back to neutral rather than guessing a strong route.
 */
export function classifyTask(text: unknown): Route {
	if (typeof text !== "string" || text.trim() === "") return "neutral";

	const inspectScore = countMatches(text, INSPECT_PATTERNS);
	const actScore = countMatches(text, ACT_PATTERNS);

	if (inspectScore === actScore) return "neutral";
	return inspectScore > actScore ? "inspect" : "act";
}

/**
 * Match only the supported DeepSeek V4 model IDs across direct and proxy
 * providers. Provider identity is intentionally not used: Pi proxy providers
 * retain the upstream model ID while changing only transport/authentication.
 */
export function isDeepSeekV4(model: ModelLike | null | undefined): boolean {
	if (!model || typeof model.id !== "string") return false;
	return DEEPSEEK_V4_IDS.has(model.id.toLowerCase());
}

/** The strict first-turn profile is calibrated only for Flash. */
export function isDeepSeekV4Flash(model: ModelLike | null | undefined): boolean {
	return typeof model?.id === "string" && model.id.toLowerCase() === DEEPSEEK_V4_FLASH_ID;
}

/**
 * Preserve the user's currently enabled tools: strict mode never activates a
 * tool that was not already active. It runs only when its exact two-tool
 * surface is available.
 */
export function strictFlashFirstTurnTools(activeTools: readonly string[]): string[] | undefined {
	const active = new Set(activeTools);
	if (!STRICT_FLASH_FIRST_TURN_TOOLS.every((tool) => active.has(tool))) return undefined;
	return [...STRICT_FLASH_FIRST_TURN_TOOLS];
}

export function emptyRouterState(): RouterState {
	return { version: 2 };
}

/**
 * Safely restore persisted state while ignoring malformed or future fields.
 * Version-1 entries are treated as already past their first Flash request so
 * upgrading this experimental extension never retroactively applies the strict
 * profile to an existing branch.
 */
export function normalizeRouterState(value: unknown): RouterState {
	if (!isRecord(value)) return emptyRouterState();

	const state = emptyRouterState();
	if (isRoute(value.autoMode)) state.autoMode = value.autoMode;
	if (isRoute(value.overrideMode)) state.overrideMode = value.overrideMode;

	if (value.version !== 2) {
		state.flashFirstTurnCompleted = true;
		return state;
	}

	if (value.flashFirstTurnCompleted === true) {
		state.flashFirstTurnCompleted = true;
		return state;
	}

	const restoreTools = normalizedToolNames(value.flashFirstTurnRestoreTools);
	if (restoreTools !== undefined) state.flashFirstTurnRestoreTools = restoreTools;
	return state;
}

/** The explicit override wins, otherwise retain the session's initial route. */
export function effectiveMode(state: RouterState): Route | undefined {
	return state.overrideMode ?? state.autoMode;
}

export function modeSource(state: RouterState): RouteSource | undefined {
	if (state.overrideMode) return "manual";
	if (state.autoMode) return "auto";
	return undefined;
}

/** Preserve the first automatic decision for the entire session. */
export function withAutoMode(state: RouterState, prompt: unknown): RouterState {
	if (state.autoMode) return state;
	return { ...state, autoMode: classifyTask(prompt) };
}

export function withOverride(state: RouterState, mode: Route): RouterState {
	return { ...state, overrideMode: mode };
}

export function withoutOverride(state: RouterState): RouterState {
	const { overrideMode: _overrideMode, ...rest } = state;
	return rest;
}

/** A fresh Flash request may receive the strict profile exactly once per branch. */
export function isStrictFlashFirstTurnPending(state: RouterState): boolean {
	return state.flashFirstTurnCompleted !== true && state.flashFirstTurnRestoreTools === undefined;
}

/** The strict profile is active until promotion or final settlement. */
export function isStrictFlashFirstTurnActive(state: RouterState): boolean {
	return state.flashFirstTurnRestoreTools !== undefined;
}

/** Store the tool set that must be restored after strict promotion or settlement. */
export function beginStrictFlashFirstTurn(state: RouterState, restoreTools: readonly string[]): RouterState {
	if (!isStrictFlashFirstTurnPending(state)) return state;
	return {
		...state,
		flashFirstTurnRestoreTools: normalizedToolNames(restoreTools) ?? [],
	};
}

/** Mark the Flash first request consumed and remove temporary restore data. */
export function completeStrictFlashFirstTurn(state: RouterState): RouterState {
	if (state.flashFirstTurnCompleted === true && state.flashFirstTurnRestoreTools === undefined) return state;
	const { flashFirstTurnRestoreTools: _restoreTools, ...rest } = state;
	return { ...rest, flashFirstTurnCompleted: true };
}

export function parseRouterCommand(input: string): RouterCommand {
	const trimmed = input.trim().toLowerCase();
	if (trimmed === "" || trimmed === "status") return { kind: "status" };
	if (trimmed === "auto") return { kind: "auto" };
	if (isRoute(trimmed)) return { kind: "set", mode: trimmed };
	return { kind: "invalid", input: input.trim() };
}

/** Advisory guidance used by Pro and Flash requests after the strict first turn. */
export function guidanceFor(mode: Route): string | undefined {
	switch (mode) {
		case "inspect":
			return INSPECT_GUIDANCE;
		case "act":
			return ACT_GUIDANCE;
		default:
			return undefined;
	}
}
