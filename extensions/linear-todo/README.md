# Linear Todo for Pi

A branch-aware, session-persisted linear Todo extension for Pi 1.3.0+.

The agent maintains one ordered plan through the `todo` tool (`plan`, `advance`, `insert`, `undo`, `replan`, `block`, `resume`, `show`, `clear`). Todo is the agent's working memory, not a user-managed task board: plan, advance, revise and finish autonomously, update at meaningful task boundaries rather than after every tool call, and keep the latest user request authoritative. `insert` adds a task discovered mid-flight without moving the cursor, `undo` reverts the previous transition, and every action rejects fields it does not read instead of silently ignoring them.

The `todo` tool is model-only: codemode scripts and other nested tool calls cannot invoke it, because Pi does not persist nested results as session entries. Mutations return a concise transition plus the plan title and goal, current task and its execution description, completion condition, next task and any blocker. `advance` includes every newly reported result, including when a batch completes the plan; results are agent-reported observations, not independently verified proof. `show` returns the complete plan. Tool feedback and context reminders share the same bounded work view and expose paused auto-continuation. Undo restores tasks while preserving the plan's task-ID allocation high-water mark.

Auto-continue remains automatic in TUI/RPC and includes the plan title/goal, current task, execution description and completion condition. Each plan position gets one correction attempt; plain `replan`, `insert` and `undo` do not replenish it. A successful explicit `todo resume` after a blocker grants another attempt, capped at three total per `(planId, cursor)`, including across restart or branch recovery. Replanning from blocked to active does not count as an explicit resume. A replacement task at an already-spent position inherits that position's allowance; no task identity system is introduced. The latest user request takes precedence over an obsolete plan.

`/todos` (`list`, `pause`, `resume`) is an optional inspection/emergency-control interface, not a required workflow. Pause/resume take effect immediately; pausing prevents subsequent auto-continues without aborting the current tool or model call. Opening the list also responds immediately while the agent is working: TUI shows a read-only snapshot captured when opened, and RPC sends the current list notification. Descriptions, acceptance conditions and results wrap without truncation in an eight-visual-line scroll window. Use injected direction/PgUp/PgDn bindings to scroll and Home/End to reach the ends; the injected `app.interrupt` binding closes only the list. Scrolling never changes revision or undo, waits for idle, or stops background work. Closing the TUI list does not interrupt background work or restore an older plan; reopen it for a newer snapshot. JSON/print stay silent and never wait for idle. These user controls do not replenish correction attempts. An early-stop warning appears only when an otherwise eligible correction is blocked by its spent allowance; pause, queued input, errors, aborts, deferral and noninteractive modes do not produce that warning. Existing revision-based ledgers are mapped conservatively when their position can be identified; unresolvable legacy keys are retained without guessing.

## Completing tasks

Use `advance` with `completions` to report one or more already-completed consecutive tasks in one call:

```json
{
  "action": "advance",
  "completions": [
    { "result": "Located the integration point" },
    {}
  ]
}
```

Each record completes one task starting at the current position; the example completes two tasks. `result` means the optional observed result after doing the work, not the prior `doneWhen` condition or independently verified proof. Use an empty record when no result note is needed; never invent a result to fill it. Do not skip unfinished tasks or delay useful updates just to accumulate a batch.

The entire batch is validated before changing state. Empty arrays, excess records, unsupported record fields and invalid results reject the whole call. A successful batch creates one revision and one undo snapshot; `undo` reverts the whole batch. V3 task snapshots store the note as `result`.

`advance` requires `completions`, even for a single task (`[{ "result": "Observed fact" }]` or `[{}]`). Top-level result notes, the removed `outcome` field, aliases and implicit single-item calls are not supported. There is no separate `count` or arbitrary task-ID selection.

This is a breaking format change: `TODO_SCHEMA_VERSION = 3`, with `TodoState` / `isTodoState` and no V2 aliases or migration. V1/V2, unknown versions and corrupt snapshots enter non-mutating protection; explicitly `clear` before rebuilding. Old `displayTitle` and state `createdAt`/`updatedAt` properties are rejected, not silently ignored. Pi's own message/session timestamps are unaffected.

## Titles and execution details

A plan requires `title` (a nonblank action-oriented overview, max 60 characters), `goal` (the complete goal and scope, max 300) and `tasks`. The title must cover the whole group of work: a stable verb + object phrase such as `检查并整理 wifi-audit`, not the current step, project/category/status fragments, progress or a restatement of the request. Aim for at most 40 terminal display columns as writing guidance only; rendering has no fixed 40-column cap.

Each new task accepts only `title` (the sole short action name, nonblank, max 60), optional `description` (execution details, max 300) and optional `doneWhen` (verifiable acceptance condition, max 300). Put paths, commands, parameters and execution scope in `description`, not a duplicate title. `result` (max 1000) is an actual observed result written only through `advance.completions[].result`, never during task creation. Description, acceptance and result have distinct roles.

Example fields (not a complete work breakdown):

```json
{
  "action": "plan",
  "title": "检查并整理 wifi-audit",
  "goal": "对 D:/code/lab/wifi-audit 做结构整理与质量检查，产出问题清单并做低风险修复",
  "tasks": [{
    "title": "梳理文档与脚本",
    "description": "通读 README 与全部脚本，建立功能清单",
    "doneWhen": "功能清单覆盖 README 和全部脚本中的实际能力"
  }]
}
```

The shared multi-action input schema may mark top-level `title` optional, but the reducer requires it for `plan`. `replan` still requires `tasks` and a revision reason; it may retain the title only when the normalized goal is unchanged. Changing that goal requires an explicit new title; omission rejects the entire call rather than preserving a stale title. An empty replacement list completes remaining work only when completed history exists; otherwise use `clear`. `insert`/`replan` create tasks using their own titles and descriptions.

Invalid plan titles use `INVALID_PLAN_TITLE`, invalid task titles `INVALID_TASK_TITLE`, and invalid descriptions `INVALID_DESCRIPTION`. Unknown or inapplicable fields reject the entire mutation. No aliases, title fallback or automatic summaries are provided. Clone, one-step undo, restart and branch recovery preserve title, goal and task descriptions. `/todos`, expanded historical tool details and `show` retain full execution information; compact/full feedback and reminders include the plan title/goal and task descriptions within their bounded work view. Title edits do not replenish continuation allowances.

State has no creation/update timestamps. The pure reducer signature is `reduceTodo(previous, input, dependencies)`, with injected `dependencies.createPlanId`, not a clock/`now` argument. Plan ID, revision, cursor, next-item sequence, phase, blocker and undo semantics remain unchanged.

## Tool presentation

In the TUI, completed `todo` calls collapse into one event summary: the tool name, the concrete change, then the completed/total counter right after the summary, for example `Todo ✓ 梳理渲染路径 · 1/3`. Exactly one space separates the tool name, the marker and the summary. Internal operation names such as `advance` do not occupy a separate header field; creation, revisions and other changes use user-facing descriptions. The counter follows the content instead of the row edge, so a wide terminal cannot push it away; it is still reserved before the summary, so a long summary truncates first and the counter stays intact. Below 48 columns the counter is dropped, and errors or calls without a plan snapshot never show one. Only three status glyphs remain: `✓` success, `!` warning and `✗` error; every other action starts with its own verb (`查看 …`, `已恢复 …`, `已撤销上次变更`, `补充 N 项任务`, `已清空当前计划`) instead of inventing more symbols. A batch names its last completed task and adds `等 N 项` only when that count differs from the counter numerator; a final batch reads `✓ 计划完成` with both the check and the milestone text in the success color. The row honours the host's `outputPad` like `compact-tool-ui`'s self shell and draws no background block and no blank rows above or below its content; only the host's single separator line precedes it. Long results stay out of the collapsed view; blocked states use a warning marker instead of a success check.

Expand a tool row to inspect that call only, through the `compact-tool-ui` tree: `  ├─ ` introduces each section label (`操作`, `结果`, `受阻`, `错误`, `计划`, `目标`, `原因`, `当前`), `  │ ` carries that section's content on one shared column, and `  ╰─ ` closes the tree with `/todos 查看完整计划`. Labels never share a line with their value, so there is exactly one content column. Content order is the raw operation token first, then what the call produced (added tasks with their descriptions and acceptance conditions, completed tasks with reported results, a blocking reason or an error), then the plan title, the full goal and the resulting cursor. Earlier or later tasks are not replayed, so a twenty-task plan does not turn one `advance` row into forty lines. Below 24 columns the glyphs are dropped and the same fields keep plain indentation. Expansion uses Pi's normal tool controls (including clicking in fullscreen mode). The Widget remains the live progress view; tool rows do not follow subsequent state changes. This presentation does not change model-facing feedback, persistence, RPC or print output.

## Widget

The approved TUI Widget is a **rounded left half-frame**, retaining the readable B palette and bounded upcoming-task window. Header uses dim `╭─ `, middle content uses `│  ` and the last actual content row uses `╰─ `. There is no right border, extended top/bottom rail, background, artificial right-padding, blank row, dedicated bottom line or 72-column cap. The Widget and tool rows are separate surfaces: the Widget follows live progress, while each tool row keeps only that call's history.

At `available >= 12`, each prefix occupies three cells, leaving `available - 3` columns for content. At `available < 12`, omit all frame decoration and use full width. The last task closes the half-frame when there is no more-pending row; if an alert exists it closes the half-frame instead. Never add a border-only row or reuse a top prefix at the bottom. Short content is never padded. A concrete short-title example of this plugin's design-inspired layout (not ClaudeCode's native UI or a runtime acceptance record):

```text
╭─ 检查并整理 wifi-audit（1/6）
│  ✓ 梳理文档与脚本
│  → 语法与静态检查
│  ○ 核对文档与实现
│  ○ 检查跨脚本约定
╰─ 另有 2 项待办
```

The TUI header is `<state.title>（N/T）`, with no `计划：` prefix or middle-dot separator. Compute the title budget from the Widget's current available width after subtracting the three-column half-frame (when present) and the complete parenthesized progress suffix `（N/T）`; there is no fixed 40-column or other title-width cap. Show the complete plan title whenever it fits, including an exact fit, and truncate with Unicode `…` only when it actually overflows. Resizing recomputes the budget; measure CJK, emoji and ANSI-styled text in terminal cells. Progress follows short titles without right-alignment padding; long titles may naturally push it toward the right. Keep the header on one line; extremely narrow layouts show only `N/T`. No decoration-only rows, Widget wrapping or content-collapse mode are introduced.

The window contains the **two most recently completed items**, the current item and the next **two pending items** (at most five task rows). If older completed items exist, put `… 较早已完成 N 项` before all task rows; N counts only those omitted completed items. `另有 N 项待办` is a separate content row, without an ellipsis marker in TUI, after the tasks and before the optional alert; N excludes the current and visible pending items. Normal height is at most eight rows, or nine with one merged alert. A one-task plan uses exactly two rows (header + task), or three with an applicable alert; a final remaining task can still have completed history above it. “Current” still means the plan cursor, **not** that the agent is actually executing that task.

The palette follows Pi's semantic foreground colors, with one primary focus:

| Element | Style |
| --- | --- |
| Left half-frame (`╭─ ` / `│  ` / `╰─ `) only | dim |
| Progress parentheses (`（` and `）`) | muted |
| Action-oriented overview (`state.title`, no goal fallback) | text, not bold |
| Numeric completion count | success after at least one completed item; text at zero; not bold |
| Task titles | current accent + bold; pending text; blocked current text + bold |
| Current `→` | accent; warning when blocked |
| Completed `✓` / completed title | success / muted, no strikethrough |
| Pending `○` | muted |
| Older-completion summary / more-pending text / resume hint | muted, not dim |
| Alert signal and status labels | warning |
| Blocking reason | text |

Bold marks the selected plan item, not live execution. Blocked items keep the arrow and the bold text-colored title; the separate alert explains the reason. No right-hand tag or textual current label is added. The Widget adds no expand/collapse controls, shortcuts, configuration, telemetry fields, timers, animated activity, spinners or progress bars.

Alerts append one content row after the optional more row. Only the signal and status labels use warning color; the reason uses readable text color and `/todos resume` is a muted hint, rather than coloring the entire row. Wording remains `阻塞：<reason>` for blocked alone, `自动续跑已暂停 · /todos resume` for pause alone, and `提前停止` when the agent ended with its current task unfinished. Pause affects only automatic continuation, not current work. Simultaneous flags share one row with applicable labels before the long reason, for example `╰─ ! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：<reason>`; combined flags omit the resume hint. Preserve status labels over a long reason whenever the labels fit the content width. Existing warning trigger semantics are unchanged.

Only a null/cleared plan, or a completed plan whose Widget has been released, hides the Widget (`hidden` = zero rows). Until settlement, a completed plan retains its last at most two completed tasks and optional older-completion summary, with no blocked, paused or early-stop alert. Settlement releases the Widget but keeps the completed state for `/todos`, `show` and `undo`; an undo back to an active cursor re-arms it, an undo that restores a completed pre-image stays hidden, and a new plan replaces it. A completed plan recovered from a branch or session is already settled and therefore hidden. No cross-plan archive or additional persisted history field is introduced, and the state schema remains V3. `/todos` still shows the full current-plan snapshot and completed history. The non-mutating compatibility guard remains ahead of unknown state access: `unavailable` shows only one **unframed, rail-free** diagnostic row, `Todo 不可用：<error>`, with warning prefix and text-colored message, still width-bounded in TUI.

`src/widget.ts` owns `buildTodoWidgetModel(snapshot)` and its discriminated `hidden`/`unavailable`/`plan` model, `TodoWidget(model, theme)` and `formatTodoWidgetLines(model)`. Only the builder selects the completed/current/future window and derives `kind`, including the released-completed `hidden` result; plan model `title` comes directly from `state.title`, and each row is only `{ title, kind: "completed" | "current" | "pending" }`, replacing `isCurrent`, with no ID or duplicate status. Blocking comes from `plan.alerts.blocked`, not row status; only the current arrow becomes warning, while the blocked current title remains text + bold. `index.ts` builds one model per refresh for TUI or RPC, and `agent_settled` sets the runtime-only completed-release flag when the finished plan's run ends. `src/render-shared.ts` holds `TodoRenderSnapshot` (state, compatibility error, early-stop warning, pause and completed release) and shared whitespace/terminal-control sanitization; `render.ts` retains tool history and `/todos`; `index.ts` keeps the existing RPC status fallback. V3 snapshots validate and persist plan title/goal and task title/description separately; descriptions remain available to details and model feedback without entering compact Widget rows. Task progression, acceptance conditions, IDs, undo and reminder/continuation rules remain unchanged. A newly completed plan stays visible until settlement; an undo that restores a completed pre-image marks it released, while an undo to active or a recovered active plan clears the flag; recovery of an already-completed plan sets it.

RPC `formatTodoWidgetLines(model)` retains unframed, width-independent text and indentation; the header only removes the completion label: `计划：<state.title> · N/T`. Rows use `  … 较早已完成 N 项` before tasks when needed, `  ✓ ...`, `  → ...`, `  ○ ...`, then `  … 另有 N 项待办` and `  ! ...` when applicable. It does not adopt the TUI's parenthesized header. For a plan completed 1/6 with the current and next two tasks visible, RPC returns:

```text
计划：检查并整理 wifi-audit · 1/6
  ✓ 梳理文档与脚本
  → 语法与静态检查
  ○ 核对文档与实现
  ○ 检查跨脚本约定
  … 另有 2 项待办
```

Content selection, window and counts are shared; TUI decoration and truncation are not RPC output. RPC has no ANSI, theme, borders, terminal-width layout, truncation or artificial right-padding; its original more-pending row still precedes the alert. Its existing English footer status fallback (for example `todo 0/2 done`) still clears on completed, independently of the Widget; the completed Widget itself is released at settlement, while `show`, `/todos` and undo keep the completed state. Noninteractive behavior is unchanged and TUI does not add a footer status. `/todos` opens its scrollable read-only snapshot immediately during work; RPC list notifications remain complete and untruncated, while JSON/print remain silent. Only V3 states are accepted; the Widget never falls back to goal or generates summaries. Full title/goal/description/doneWhen/result remain available outside the compact Widget; this layout does not change progression, continuation or historical snapshot semantics.

## Development

Run these commands from `extensions/linear-todo/` (there is no root package check). Entrypoints below are not pass records. For the current field-simplification verification, use only offline checks, direct CLI artifacts/workspaces/sessions/reports to `/tmp` via supported output options, and do not run real-model or authentication commands. The model commands below document a separate, explicitly budget-approved future evaluation.

```bash
npm install
npm run check
```

Run the deterministic RPC E2E suite:

```bash
npm run test:e2e
npm run test:e2e:controls
npm run test:e2e:modes
npm run test:e2e -- --scenario plan-and-stop --repeat 10
```

The offline runners use an isolated staged fixture baseline without creating Git commits. Script exhaustion is a harness failure, not a successful provider-error scenario. The controls suite checks the actual post-compaction request rather than accepting a reminder from before compaction.

Run model Smoke/A-B evaluation with explicit provider/model IDs. The runner preflights each model through `pi auth check` and hands the credential to the isolated agent directory as a `0600` file that the auth bridge reads once and deletes before the first tool call. The secret never enters the child environment, so the agent's own bash tool cannot read it:

```bash
npm run eval:smoke -- --models "provider/model-a,provider/model-b"
npm run eval:full -- --models "provider/model-a,provider/model-b,provider/model-c"
```

Model runs are scored on a task oracle, not on process signals: 70 points for the scenario's acceptance tests, 20 for the pre-existing suite, 10 for an honest final answer. Both arms use the same denominator, and Todo/plan/auto-continue numbers are reported as metrics only. Validate the harness itself before trusting a score:

```bash
npm run test:acceptance    # every acceptance oracle fails before the fix and passes on the reference implementation
npm run test:eval:controls # no-op 20, honest no-op 30, false claim 20, reference solution 100
```

Use `--dry-run` to validate the matrix without making model requests. Each run writes redacted evidence under `.e2e/artifacts/`; failed workspaces are retained under `.e2e/workspaces/` for diagnosis. Runtime credentials are never written under `.e2e/artifacts/`, and the per-run agent directory is deleted after the run.

Real-model repository-change metrics compare final content with a captured Git tree plus untracked paths, not the staged fixture status; staging an edit cannot hide it. Git diagnostics are retained separately from diff data.

Real-TTY manual acceptance has not been performed, and real-model adherence to action-oriented titles and the title/description split has not been calibrated. See [runtime acceptance and calibration](docs/RUNTIME_ACCEPTANCE.md) for manual TUI checks, a dry-run calibration matrix and the limits of automated model scoring. A dry run does not establish model benefit, and the model runner has no monetary/token hard cap: confirm the model and budget before removing `--dry-run`.

E2E entrypoints use a shared `e2e/is-main.ts` guard instead of `import.meta.main`, which only exists on Node >= 22.18 / 24.2; on Node 22.6–22.17 the older guard silently exited 0 without running anything.

Generate `.e2e/current-report.md` with:

```bash
npm run eval:report
```

Use `npm run eval:report:stdout` when the report should only be printed.

Run it directly from the repository:

```bash
pi -e ./index.ts
```

The authoritative Todo snapshot is stored in each `todo` tool result's `details.state`, so session recovery and `/tree` branching follow Pi's active branch semantics.

## Project documents

- [Requirements](docs/LINEAR_TODO_REQUIREMENTS.md)
- [Architecture](docs/LINEAR_TODO_ARCHITECTURE.md)
- [E2E and multi-model evaluation plan](docs/LINEAR_TODO_E2E_EVALUATION_PLAN.md)
- [Evaluation methodology (reusable)](docs/EVAL_METHODOLOGY.md)
