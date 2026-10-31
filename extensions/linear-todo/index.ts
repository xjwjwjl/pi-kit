import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reduceTodo, TodoDomainError } from "./reducer.ts";
import {
  cloneTodoState,
  getTodoProgress,
  type TodoInput,
  TodoInputSchema,
  type TodoState,
  type TodoToolDetails,
} from "./schema.ts";
import {
  TODO_CONTEXT_CUSTOM_TYPE,
  TODO_MAX_AUTO_CONTINUES_PER_STAGE,
  buildAutoContinueText,
  buildReminder,
  buildTodoToolFeedback,
  selectReminder,
  shouldAutoContinue,
  type ReminderDecision,
} from "./reminder.ts";
import { formatTodoListText, TodoListComponent, renderTodoCall, renderTodoResult } from "./render.ts";
import { buildTodoWidgetModel, formatTodoWidgetLines, TodoWidget } from "./src/widget.ts";
import type { TodoRenderSnapshot } from "./src/render-shared.ts";
import {
  createTodoStateStore,
  TODO_AUTO_CONTINUE_CUSTOM_TYPE,
  type TodoStateStore,
} from "./state.ts";

const TODO_WIDGET_KEY = "linear-todo";
const TODO_STATUS_KEY = "linear-todo";

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function currentSnapshot(store: TodoStateStore): TodoRenderSnapshot {
  return {
    state: store.getState(),
    compatibilityError: store.getCompatibilityError(),
    earlyStopWarning: store.runtime.earlyStopWarning,
    paused: store.runtime.paused,
    completedDismissed: store.runtime.completedDismissed,
  };
}

/**
 * Fallback for clients that ignore widgets. The TUI never needs it: the widget shows the same
 * progress, phase and pause state, and the footer is shared with other extensions.
 */
function fallbackStatus(snapshot: TodoRenderSnapshot, paused: boolean): string | undefined {
  if (snapshot.compatibilityError !== undefined) return "todo unavailable";
  const state = snapshot.state;
  if (state === null || state.phase === "completed") return undefined;

  const progress = getTodoProgress(state);
  const base = `todo ${progress.completed}/${progress.total} done`;
  if (state.phase === "blocked") return `${base} · blocked`;
  return paused ? `${base} paused` : base;
}

function refreshUi(ctx: ExtensionContext, store: TodoStateStore): void {
  if (!ctx.hasUI) return;

  try {
    const snapshot = currentSnapshot(store);
    const model = buildTodoWidgetModel(snapshot);
    if (ctx.mode === "tui") {
      if (model.kind === "hidden") {
        ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
      } else {
        ctx.ui.setWidget(TODO_WIDGET_KEY, (_tui, theme) => new TodoWidget(model, theme));
      }
    } else if (ctx.mode === "rpc") {
      const widgetLines = formatTodoWidgetLines(model);
      ctx.ui.setWidget(TODO_WIDGET_KEY, widgetLines.length > 0 ? widgetLines : undefined);
      ctx.ui.setStatus(TODO_STATUS_KEY, fallbackStatus(snapshot, store.runtime.paused));
    }
  } catch (error) {
    // UI failures must never roll back a committed Todo state.
    console.error("[linear-todo] UI refresh failed", error);
  }
}

function resultDetails(action: TodoInput["action"], state: TodoState | null, transition: string, error?: string): TodoToolDetails {
  return {
    action,
    state: state === null ? null : cloneTodoState(state),
    transition,
    ...(error === undefined ? {} : { error }),
  };
}

function errorResult(
  action: TodoInput["action"],
  state: TodoState | null,
  error: string,
  paused: boolean,
): AgentToolResult<TodoToolDetails> {
  return {
    content: [{ type: "text", text: buildTodoToolFeedback(state, `Todo error: ${error}`, paused) }],
    details: resultDetails(action, state, `Rejected: ${error}`, error),
    // Report the rejection without throwing: the host only forwards `isError` from the result
    // (1.3.0 agent-loop), and throwing would replace details with `{}` and lose the snapshot.
    isError: true,
  };
}

function compatibilityResult(
  action: TodoInput["action"],
  error: string,
): AgentToolResult<TodoToolDetails> {
  return {
    content: [{ type: "text", text: `Todo unavailable: ${error}` }],
    details: {
      action,
      state: null,
      transition: `Rejected: ${error}`,
      error,
      compatibilityError: error,
    },
    isError: true,
  };
}

function consumeReminder(runtime: TodoStateStore["runtime"], decision: ReminderDecision): void {
  switch (decision.reason) {
    case "force":
      runtime.forceReminder = false;
      runtime.userTurnReminder = false;
      runtime.skipNextContextReminder = false;
      runtime.turnsSinceMutation = 0;
      break;
    case "user":
      runtime.userTurnReminder = false;
      runtime.skipNextContextReminder = false;
      break;
    case "periodic":
      runtime.turnsSinceMutation = 0;
      break;
    case "skip":
      runtime.skipNextContextReminder = false;
      break;
    case "none":
      break;
  }
}

export default function linearTodoExtension(pi: ExtensionAPI): void {
  let runtimeActive = true;
  let lastContext: ExtensionContext | undefined;

  const store = createTodoStateStore(() => {
    if (runtimeActive && lastContext) refreshUi(lastContext, store);
  });

  const restore = (ctx: ExtensionContext): void => {
    lastContext = ctx;
    runtimeActive = true;
    store.recover(ctx.sessionManager.getBranch());
    store.runtime.forceReminder = store.getState() !== null;
  };

  pi.registerTool<typeof TodoInputSchema, TodoToolDetails>({
    name: "todo",
    label: "Todo",
    description:
      "Maintain one short, ordered Todo plan for complex multi-step work. Actions: plan, advance, replan, insert, undo, block, resume, show, clear.",
    promptSnippet: "Maintain a short ordered Todo plan for long, multi-step work.",
    promptGuidelines: [
      "Use todo only for complex, multi-step work or when the user explicitly asks for a plan; do not use it for simple tasks.",
      "Use todo with 3–7 result-oriented tasks, not every file read, search, or shell command.",
      "Always provide a concise title when creating a plan, changing its goal, and for every new task in plan/replan/insert. Keep titles within 60 characters. For the plan, write a stable action-oriented overview of the whole plan, for example 检查并整理 wifi-audit: verb + object, not the current step, a project/category/status fragment, or a restatement of the full request. Use short actions for task titles; do not copy paths, command lists, parameters or acceptance clauses into titles.",
      "Provide the complete overall target and scope in goal (required with title and tasks for plan). Put optional task execution details in description, not in title or doneWhen. Use doneWhen only for acceptance conditions and completions[].result only for observed results. When replan changes the normalized goal, explicitly provide a new matching title; otherwise title may be omitted and is preserved. Replan always requires tasks, which may be empty to finish the remaining work.",
      "Use todo advance with completions to atomically report one or more already-completed consecutive tasks from the current position; never skip unfinished tasks. Block when blocked, and replan when the direction changes.",
      "Use todo insert to add a task discovered mid-flight; use todo undo to revert the previous transition instead of rebuilding the plan.",
      "For code changes, include testing or verification as a Todo task before giving the final completion conclusion.",
      "Maintain and update the plan yourself; users do not need to manage Todo. Update on meaningful task transitions, not every tool call.",
      "Follow the latest user request. Replan or clear a superseded plan instead of letting old Todo tasks override a new request.",
      "Each completions record completes one task; its result is optional. Use doneWhen for verifiable completion conditions and completions[].result for observed results. Never invent results or claim checks that were not run.",
    ],
    parameters: TodoInputSchema,
    // Nested tool results are not session entries, so they cannot persist our state snapshots.
    exposure: "model-only",
    executionMode: "sequential",
    renderShell: "self",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastContext = ctx;
      if (store.getCompatibilityError() && params.action !== "clear") {
        return compatibilityResult(params.action, store.getCompatibilityError()!);
      }

      try {
        const transition = reduceTodo(store.getState(), params, {
          createPlanId: () => randomUUID(),
        });
        if (transition.changed || (params.action === "clear" && store.getCompatibilityError() !== undefined)) {
          store.replace(transition.state, params.action);
        }
        const state = transition.changed ? transition.state : store.getState();
        refreshUi(ctx, store);
        const text = params.action === "show"
          ? formatTodoListText(currentSnapshot(store), true)
          : buildTodoToolFeedback(state, transition.summary, store.runtime.paused);
        return {
          content: [{ type: "text", text }],
          details: resultDetails(params.action, state, transition.summary),
        };
      } catch (error) {
        if (error instanceof TodoDomainError) {
          return errorResult(params.action, store.getState(), `${error.code}: ${error.message}`, store.runtime.paused);
        }
        throw error;
      }
    },

    renderCall: renderTodoCall,
    renderResult: renderTodoResult,
  });

  pi.registerCommand("todos", {
    description: "Show or control the linear Todo plan: /todos [list|pause|resume]",
    handler: async (args, ctx) => {
      const subcommand = (args ?? "").trim().toLowerCase();

      if (subcommand === "pause" || subcommand === "resume") {
        const pause = subcommand === "pause";
        store.runtime.paused = pause;
        store.runtime.earlyStopWarning = false;
        refreshUi(ctx, store);
        const label = pause ? "Todo auto-continue paused." : "Todo auto-continue resumed.";
        if (ctx.hasUI) ctx.ui.notify(label, "info");
        return;
      }

      if (subcommand !== "" && subcommand !== "list" && subcommand !== "show") {
        if (ctx.hasUI) ctx.ui.notify(`Unknown /todos argument: ${subcommand}. Use list, pause, or resume.`, "warning");
        return;
      }

      // Read-only inspection must stay available while the agent is working.
      const snapshot = currentSnapshot(store);
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => new TodoListComponent(snapshot, theme, done, keybindings, () => tui.requestRender()),
        );
        return;
      }
      if (ctx.mode === "rpc") {
        const text = formatTodoListText(snapshot, true);
        ctx.ui.notify(text, snapshot.compatibilityError ? "error" : "info");
      }
      // JSON and Print intentionally have no blocking UI or forced output.
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    lastContext = ctx;
    if (store.getState() !== null) store.runtime.forceReminder = true;
    refreshUi(ctx, store);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    lastContext = ctx;
    // Only a submitted user turn counts as fresh input. `before_agent_start` also fires for
    // custom-message runs (`triggerTurn`), including our own auto-continue, and treating those
    // as user turns re-armed the reminder on every nudge.
    if (event.messageType !== "user") return;
    // The user is driving again, so the previous early-stop warning is stale.
    store.runtime.earlyStopWarning = false;
    const state = store.getState();
    if (state !== null && state.phase !== "completed") {
      // A new user round should not inherit the one-shot suppression intended for
      // the context request immediately following a Todo tool result.
      store.runtime.skipNextContextReminder = false;
      store.runtime.userTurnReminder = true;
    }
  });

  pi.on("context", async (event, ctx) => {
    lastContext = ctx;
    const decision = selectReminder(store.runtime);
    if (decision.mode === null) {
      consumeReminder(store.runtime, decision);
      return;
    }

    try {
      const state = store.getState();
      if (state === null) return;
      const reminder = buildReminder(state, decision.mode, { paused: store.runtime.paused });
      consumeReminder(store.runtime, decision);
      const message: AgentMessage = {
        role: "custom",
        customType: TODO_CONTEXT_CUSTOM_TYPE,
        content: reminder,
        display: false,
        details: { mode: decision.mode, reason: decision.reason },
        timestamp: Date.now(),
      };
      return { messages: [...event.messages, message] };
    } catch {
      // Reminder construction is best effort. Keep the flags so a later context
      // request can retry rather than silently losing the reminder.
      return;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastContext = ctx;
    if (store.getState() !== null) store.runtime.turnsSinceMutation += 1;
  });

  pi.on("agent_end", async (event, ctx) => {
    lastContext = ctx;
    const assistant = [...event.messages].reverse().find(isAssistantMessage);
    if (!assistant) return;
    store.runtime.lastRunStopReason = assistant.errorMessage ? "error" : assistant.stopReason;
  });

  // Auto-continue rides `agent_before_settle`, not `agent_settled`: the settle event is a
  // pure notification whose handler result is discarded, while the boundary accepts draft
  // entries plus `continue: true` and keeps the current run alive. The host commits those
  // drafts without emitting `message_end`, so the nudge ledger is marked here, synchronously.
  pi.on("agent_before_settle", async (event, ctx) => {
    lastContext = ctx;
    if (!runtimeActive) return;

    const state = store.getState();
    if (state === null || state.phase !== "active") return;

    const key = store.getStageKey(state);
    const alreadyNudged = store.isNudged(key);
    const nudgesAtStage = store.nudgesAt(state.planId, state.cursor);
    const continuationInput = {
      mode: ctx.mode,
      state,
      hasPendingMessages: ctx.hasPendingMessages(),
      // The boundary outcome is authoritative for abort/error; the stored stop reason still
      // carries "deferred", which must not auto-continue either.
      lastRunStopReason: event.outcome === "completed" ? store.runtime.lastRunStopReason : event.outcome,
      lastRunWasUserAbort: event.outcome === "aborted",
      alreadyNudged,
      nudgesAtStage,
      paused: store.runtime.paused,
      runtimeActive,
    };

    if (!shouldAutoContinue(continuationInput)) {
      // Warn only when the spent allowance is the sole reason continuation cannot run.
      // Reuse all other gates so pause, noninteractive modes and abnormal stops stay silent.
      const exhausted = alreadyNudged || nudgesAtStage >= TODO_MAX_AUTO_CONTINUES_PER_STAGE;
      store.runtime.earlyStopWarning = exhausted && shouldAutoContinue({
        ...continuationInput,
        alreadyNudged: false,
        nudgesAtStage: 0,
      });
      return;
    }

    store.markNudged(key, state.planId, state.cursor);
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: TODO_AUTO_CONTINUE_CUSTOM_TYPE,
          content: buildAutoContinueText(state),
          display: false,
          // `planId` and `cursor` let recovery rebuild the per-position budget after a restart.
          details: { stageKey: key, planId: state.planId, cursor: state.cursor },
        },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastContext = ctx;
    if (!runtimeActive) return;
    // The completing run keeps its final progress visible until it settles. Afterwards the
    // Widget is released, while the completed state remains for /todos, show and undo.
    if (store.getState()?.phase === "completed") store.runtime.completedDismissed = true;
    refreshUi(ctx, store);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    runtimeActive = false;
    try {
      if (ctx.hasUI) {
        ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
        ctx.ui.setStatus(TODO_STATUS_KEY, undefined);
      }
    } catch (error) {
      console.error("[linear-todo] UI cleanup failed", error);
    }
    lastContext = undefined;
  });
}
