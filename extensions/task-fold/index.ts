import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHintState } from "./src/hint-state.ts";
import { TaskFoldAdapter } from "./src/pi-adapter.ts";
import { completedGroup, restoredGroups } from "./src/task-model.ts";

export default function taskFoldExtension(pi: ExtensionAPI): void {
  let adapter: TaskFoldAdapter | undefined;
  let startingEntries: Set<string> | undefined;

  const fail = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const old = adapter;
    adapter = undefined;
    startingEntries = undefined;
    try { old?.dispose(); } catch { /* Preserve Pi's UI even if cleanup fails. */ }
    if (ctx.mode === "tui") ctx.ui.notify(`task-fold disabled: ${message}`, "warning");
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      adapter = new TaskFoldAdapter(ctx, (error) => fail(ctx, error), loadHintState());
      adapter.restore(restoredGroups(ctx.sessionManager.buildContextEntries()));
    } catch (error) {
      fail(ctx, error);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!adapter) return;
    try {
      adapter.restore(restoredGroups(ctx.sessionManager.buildContextEntries()));
    } catch (error) {
      fail(ctx, error);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!adapter || startingEntries) return; // Keep the same batch across retries and continuations.
    startingEntries = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
  });

  pi.on("agent_settled", (event, ctx) => {
    const before = startingEntries;
    startingEntries = undefined;
    if (!adapter || !before) return;
    try {
      const group = completedGroup(ctx.sessionManager.getBranch(), before, event.aborted);
      if (group) adapter.add(group);
    } catch (error) {
      fail(ctx, error);
    }
  });

  pi.on("session_shutdown", () => {
    startingEntries = undefined;
    const old = adapter;
    adapter = undefined;
    try { old?.dispose(); } catch { /* Shutdown must remain safe. */ }
  });

  pi.registerCommand("task-fold", {
    description: "Toggle the latest folded task; use show or hide for all visible tasks",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/task-fold is only available in interactive TUI mode", "error");
        return;
      }
      if (!adapter) {
        ctx.ui.notify("task-fold is not active in this session", "warning");
        return;
      }
      const value = args.trim().toLowerCase();
      if (value !== "" && value !== "toggle" && value !== "show" && value !== "hide") {
        ctx.ui.notify("Usage: /task-fold [toggle|show|hide]", "info");
        return;
      }
      try {
        const action = value === "show" || value === "hide" ? value : "toggle";
        if (adapter.change(action) === 0) ctx.ui.notify("No folded tasks in the current transcript", "info");
      } catch (error) {
        fail(ctx, error);
      }
    },
  });
}
