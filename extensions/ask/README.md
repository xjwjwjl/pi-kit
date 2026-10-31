# pi-ask-user

A lightweight structured `ask_user` tool for Pi's interactive TUI. Supports free text, single choice, multiple choice, custom answers, per-question supplementary notes, explicit skips, and up to five question tabs.

## Install

```bash
pi install ./extensions/ask
```

For a one-off development session:

```bash
pi -e ./extensions/ask/index.ts
```

The package entrypoint is `index.ts`. Existing settings that explicitly reference `ask_user.ts` continue to work through a compatibility entrypoint. Keep the package directory together: copying only `ask_user.ts` is no longer supported. Reload Pi after updating the extension.

## Interaction

| Key | Action |
| --- | --- |
| Tab / Shift-Tab | Walk the focus ring: every answer option in order, then **附加说明**, then **跳过**, wrapping back to the first option; Shift-Tab reverses it. A single-question flow has no Skip, so the ring ends with **附加说明** |
| Left / Right | Switch question/preview (**预览**) tabs; no-op in a single-question flow, which has no tab bar |
| Up / Down / j / k | Move only between actual answer choices; from auxiliary controls, return to the current answer (`j`/`k` are text in free-text mode) |
| F6 / Shift+F6 | Jump straight into the auxiliary row (**附加说明** → **跳过**) without walking the options; **跳过** is omitted in a single-question flow |
| Space | Toggle a multi-select option/remove a custom value; activate an explicitly focused auxiliary control |
| Enter | Save a single/text answer and advance to the next question; on a multi-select, finish and advance; activate the focused auxiliary control; on preview, continue the first pending question or explicitly submit when eligible |
| Ctrl+N | Add/edit this question's independent supplementary note outside input mode |
| Ctrl+S | Explicitly skip this question outside input mode, without leaving it (multi-question flows only) |
| Ctrl+O | Show/hide the focused single-choice preview, when present, outside input mode |
| Esc | Discard the current editor draft and return to choices; Esc outside input cancels the whole flow |
| Alt+Up / Alt+Down or Ctrl+PageUp / Ctrl+PageDown | Page overflowing question content outside input mode |
| PageUp / PageDown | Page the question in regular mode; retain native chat scrolling in fullscreen mode |

Enter confirms an answer and moves to the next question in questionnaire order; answering the last question lands on the **回答预览** page, like Pi's demo, so the next Enter is the explicit submission. Enter never submits from a question itself, only from the review page. In a multi-question flow, a required multi-select with nothing selected asks for a selection or an explicit Skip instead of advancing; once it has been explicitly skipped, Enter moves on like any other answered question, and the skip still counts as unresolved in the result. A single-question flow has no Skip, so an empty required multi-select simply waits for a selection. Saving a note or skipping still leaves the current question in place. Use Left/Right to navigate deliberately, including to the final **预览** (answer preview) tab. If any required question has neither an answer nor an explicit Skip, **Enter 继续回答** returns to the first such question in questionnaire order, without answering, skipping, submitting, or automatically opening an editor. Existing answers, notes, skips, and default provenance are preserved. Once every required question is answered or explicitly skipped, **Enter 提交回答** submits from this tab only. Saving the last missing answer opens the review page but never submits on its own. A single-question flow has no tab bar and no **预览** page: confirming the answer submits immediately, and an explicit Skip is itself the decision, so it submits the skipped result at once. Multi-question flows keep the explicit preview submission above.

Inside an active editor, Enter saves and Esc discards the current draft. Saving a free-text or custom single-choice answer advances to the next question, or submits immediately when the flow contains only one question; saving a note or adding a custom multi-select value keeps the current question open. The editor keeps its cursor/editing keys; questionnaire shortcuts do not switch tabs, skip, or replace an active edit. Free-text answers can start with Enter or by typing. Custom input opens beneath its choice; notes expand beneath the answer list rather than replace it with another screen.

Every question has a separate, visible action row, independent of `required` and `allowCustom`: **[附加说明] [跳过]** with several questions, **[附加说明]** alone with one. Press **Tab** to walk the focus ring: each answer option first, then the note control, then Skip, wrapping back to the first option. With an auxiliary control focused, **Enter/Space** activates it and Up/Down return to the answers. **Shift+Tab** walks the ring backwards, and **F6**/**Shift+F6** jump straight to the auxiliary row. The active control uses Pi's selected background, never an answer number or `>` marker. Left/Right still switch question/preview tabs directly, not buttons; Tab and Shift+Tab never change the question. **Ctrl+N** and **Ctrl+S** remain direct alternatives outside an active edit; they return focus to the answers, so a following Enter never replays the control that was highlighted before. Notes supplement rather than replace answers: choose a fixed option and explain it, add context to a custom answer, or leave a note on a skipped question. Saving a blank note removes it; Esc discards only the active edit and preserves the previously saved answer/note. A note alone does not count as answering or skipping a required question.

Skip affects only that question and preserves other answers and that question's note. A single-question flow offers no Skip at all: with no later question for the skip to apply to, the only ways out are answering or cancelling with Esc. Required questions may be explicitly skipped, but remain **unresolved, not approved**. You can submit partial responses after explicitly skipping them; actions depending on those missing decisions must not proceed. Untouched required questions still block submission.

Multi-question flows end on the **回答预览** page (single-question flows have none; they submit from the question itself). It is a status preview, not an error report. Its pending count includes only unanswered, unskipped required questions—not explicitly skipped decisions. Rows distinguish **待回答**, gray **未填写 · 可选**, and **已跳过**; a skipped required question retains the short amber **已跳过 · 仍待确认** status. Supplementary notes appear on separate **附加说明：** lines. Repeated internal warnings are omitted from this page only: structured results, model guidance, and transcript warnings still preserve unresolved required IDs and the fact that skips/notes are not approval. The footer always leads with the correct Enter action, abbreviates it on narrow screens, and omits scroll help when it cannot fit without truncating that action.

Long labels wrap instead of losing distinguishing suffixes. The viewport adapts to terminal width and height, follows the current option or input cursor, and shows overflow indicators. Small terminals can page through labels longer than the viewport.

The questionnaire is **inline in the original input area**, not a popup, floating card, overlay, or separate screen. It temporarily replaces the main editor through `ctx.ui.custom(factory)` with no overlay options. The conversation, status, widgets, and footer remain in their native layout; the questionnaire uses the width supplied by the editor area, without a centered 96-column limit or outer margins. Closing restores the previous editor, focus, and draft.

The visual baseline is Pi 1.4.0's `examples/extensions/questionnaire.ts`: accent-colored horizontal rules above and below, padded question tabs with the active theme's `selectedBg`, and consistent indentation and blank lines. These are inline separators, not a boxed panel or an overlay. Unanswered questions show □, answered questions show ■, optional skips show – and required skips show !; in a multi-question flow the final tab is the neutral **预览**, without a ready/success checkmark. Narrow headers prioritize the actual active label and add position/navigation when space permits, without textual `[tab]` brackets. There is no generic progress banner or Next/Review/Details action train: Up/Down remain answer navigation, and the two auxiliary controls are a separate pinned row rather than fake answer options. Optional preview and ordinary navigation help remain secondary. Only the demo's visual language and Enter-to-advance are adopted: a single-question flow submits on confirmation exactly like the demo, while a multi-question flow keeps an explicit preview submission and never auto-submits from the last question.

Fixed UI actions, help, provenance markers and transcript warnings use Chinese; supplied titles, prompts, labels, values and notes are not translated. The default title is **请确认**, custom input is **自定义回答**, and source markers are **（默认）/（自填）**. Model-facing structured keys and not-approval guidance remain unchanged.

The header contains only the group `title` in the upper rule and, for multi-question flows, the question tabs below it (a single-question flow has no tab row). There is no shared subtitle, description row, width-dependent merge/fallback, or added question counter. Titles use text/bold styling between accent rule segments, are truncated by terminal display columns when necessary, and reuse the tab-label sanitizer to remove terminal/control sequences. The original title remains unchanged in results; below eight columns the upper rule may stay plain.

Top-level fields are `title` and `questions` only. Put necessary context in the relevant question's `prompt` or `description`. The global `description` field and its first-question compatibility behavior have been removed; old calls using it are rejected rather than silently rewritten.

Question descriptions and each choice's short explanation are shown directly beside the question/choice; no Details action hides essential information. Only optional single-choice previews start collapsed. Ctrl+O toggles the focused preview without changing the answer or focus; expansion is question-local. Notes show a one-line excerpt; Ctrl+N edits their full text beneath the answer list, never in a second surface.

Long content scrolls locally with **Alt+Up/Down** or **Ctrl+PageUp/PageDown**. Fullscreen Pi owns unmodified PageUp/PageDown for the conversation, so the extension deliberately does not intercept them or install global key hooks. The input editor keeps its own editing keys while active.

The form requests only its natural content height, capped at 14 rows with room reserved for native UI. The auxiliary row takes priority over ordinary help: both controls stay visible at 20 columns and in a 40×8 terminal. Narrower widths abbreviate labels together instead of truncating away Skip. An editor slot with at least two visible rows reserves one for answers and one for actions; at one row, F6 reveals the focused action group. Below two columns, full action labels cannot be displayed. During an active edit the action row is hidden and editing keys remain with the Editor; save or leave the draft to restore the controls. Whenever the actual editor allocation is at least **8 rows**, the full-width top and bottom rules stay fixed across long/short questions, previews, note editing, and review; overflow scrolls only inside that boundary. The single blank immediately after the tabs is also reserved before the body at this height, independent of question kind, option count, or content length; extra content pages instead of consuming that gap. Other optional blank lines yield before content. Below 8 allocated rows, both rules and the reserved tab gap are omitted together to protect answers, actions, and the editor cursor; existing blanks within paged body text are not removed. This threshold follows the host's allocated editor height, not total terminal height or question length. On Pi 1.4.0 (and 1.3.0), a read-only adapter measures public sibling components and reproduces the standard fullscreen dock allocation so active controls and the IME cursor fit the actual editor slot. Invisible tail padding preserves the host's intrinsic measurement without creating visible blank rows. Geometry changes invalidate the cached layout even when no question key is pressed. No host layout, widgets, or installed SDK files are modified.

**Limits:** fullscreen allocation reconstruction targets Pi 1.4.0's standard seven-root layout (identical in 1.3.0); unrecognized layouts use a compact fallback rather than an overlay. In regular mode, if below-editor widgets and the footer alone occupy the entire terminal, the inline input cannot be physically visible: enlarge the terminal or reduce those widgets. The extension does not hide unrelated UI or silently revert to a popup. Verify the layout again when upgrading Pi.
The input editor receives Pi's focus state so it can emit the hardware-cursor marker used for IME placement. Tool abort signals close the dialog, including during text input; completed/disposed dialogs clean up their abort listener.

## Parameters and constraints

- `title`: an optional concise group title, defaulting to **请确认**; the header has no shared subtitle.
- `questions`: 1–5 questions, each with an explicit unique `id`, nonempty `prompt`, and required `kind`.
- `kind: "text"`: accepts `id`, optional short `label`, `prompt`, optional `description`, and optional `required`. It must not contain `options`, `allowCustom`, or `defaultValue`.
- `kind: "single"` / `"multi"`: additionally require **2–5** fixed `options`, each with a nonempty `label` and an optional stable `value` (omit `value` and it defaults to the label). Optional `allowCustom` and `defaultValue` apply only to these question kinds.
- `questions[].description` / `options[].description`: optional explanations shown with the relevant question/choice; both remain supported.
- `options[].preview`: accepted only for `single` questions; multi-select options cannot contain this field.
- `allowCustom`: defaults to `true` for choice questions. Text questions always allow input but do not accept this setting. It controls replacement/additional answer values, not supplementary notes.
- `required`: defaults to `true`; marks whether an answer is needed to resolve the question. Skip is available in multi-question flows only. A required question must have an answer or an explicit Skip before submitting; required skips remain unresolved.
- `defaultValue`: a single string matching an existing fixed option value. Single-choice focus starts on that answer; multi-select starts with that one option checked. Arrays are not accepted.
- Question labels: at most 24 characters; option labels: at most 120 characters.
- Input objects are closed: unknown fields and wrong-kind fields are rejected. Errors include a JSON Pointer field path and an actionable reason, such as text questions forbidding `options` or `preview` being single-select only; diagnostics do not echo submitted payload values. No kind inference, missing-ID/value repair, empty-option cleanup, primitive coercion, or legacy global-description migration is performed. A pure prevalidation hook rejects invalid raw input before the host can coerce it; direct execution also checks structure. Normalization only supplies supported defaults such as Q1/Q2 labels, `required`, and choice `allowCustom`.

`ask_user` is for decisions needed to continue the task, not status updates or information discoverable with tools. It is sequential and `model-only`: the model can call it directly, but codemode/nested tool callers cannot. Non-TUI calls return an explicit error instead of attempting to open a terminal component.

## Previews and responsiveness

`options[].preview` is available with **Ctrl+O** for the focused fixed option of a single-choice question. It expands directly below that choice without changing focus or the saved answer. There is no Details control to navigate to. Plain text and fenced code excerpts are supported, without a Markdown engine.

Preview layout is bounded to the first 4,096 UTF-16 code units and at most 15 wrapped lines; small inline viewports page through that excerpt instead of cutting it to the visible height. Truncated excerpts say so; they do not calculate an exact hidden-line count by laying out the entire source. Provide short excerpts and use files/documents for full content.

Plain preview layouts are cached per option, source, width, and row budget, independently of theme colors. Unchanged boundary navigation reuses the rendered frame. Width or height changes invalidate the frame and keep the active row visible.

This bounds extension-side layout work; it does not eliminate model/network latency, host scheduling, transcript rendering, or terminal painting delays. The extension does not force full transcript redraws or warm up native/font libraries.

## Example

```ts
{
  title: "Website setup",
  questions: [
    {
      id: "deploy",
      label: "上线方式",
      prompt: "你希望网站如何上线？",
      kind: "single",
      options: [
        { value: "local", label: "暂时只想本地做出来" },
        { value: "platform", label: "部署到托管平台" },
        { value: "server", label: "部署到自己的服务器" },
      ],
      allowCustom: true,
    },
    {
      id: "notes",
      label: "补充",
      prompt: "还有什么需要提前说明的？",
      kind: "text",
      required: false,
    },
  ],
}
```

Only set a default for a reusable preference the user already stated, not to bypass a new decision.

## Result shape

- `content[0].text`: concise answer summary for the model.
- `details.title`: the group title. There is no result-level `description`.
- `details.questions`: compact snapshots containing exactly `id`, `label`, `kind`, and `required`. Prompts, descriptions, options, previews and input settings are not copied into results.
- `details.answers`: answers in the original question order, not answer-entry or default-seeding order. Preview, result metadata, model summary and transcript preserve that same order, including reanswers and cancellation snapshots. Answers retain stable values/display labels, `wasCustom`, `wasDefault`, and custom values where applicable. The internal type is a discriminated union: text/single require `value` and `label`, while multi requires `values` and `labels`; cross-kind combinations are rejected at compile time. The constant `status` and positional `index` fields have been removed; UI numbering remains internal.
- `details.skippedIds`: explicitly skipped questions, not a whole-flow cancellation.
- `details.notes`: independent saved supplementary text keyed by question ID; omitted entries have no saved note. Notes can coexist with answers or skips and do not change stable option values.
- `details.unresolvedRequiredIds`: required questions with no answer, including required skips. The model-facing summary explicitly warns about these missing decisions.
- `details.cancelled`: cancellation status. `false` means responses were submitted or the flow was rejected, not that every required question was answered or every action approved. Cancelled flows, skips, and notes by themselves must not be treated as approvals. Cancellation results carry `unresolvedRequiredIds` too, and the model summary names them instead of claiming a clean cancellation.
- `details.error`: validation/mode error, if present. Error results set `isError` and keep `cancelled: false`, so a rejected call is never read as a user cancellation.

## Development

```bash
cd extensions/ask
npm ci --ignore-scripts
npm run check
npm run benchmark
```

`check` runs strict TypeScript checks and focused tests with real Pi loading/TUI components and a fake terminal. Coverage includes cancellation races and cleanup, explicit submission, required/optional skips, independent note editing/clearing, default and custom answer preservation, prototype-like question IDs, focus transitions, narrow/short terminals, paging, preview bounds/cache, strict per-kind input contracts, rejected raw arguments without mutation/coercion, compact ordered result projections, named early-error/cancellation factories, localized UI with unchanged model guidance, and the entrypoint alias. Host integration tests use the actual inline custom-UI lifecycle, fullscreen chat layout, and native terminal-input dispatch in both modes. They assert zero overlays, the original editor container/full width, non-overlapping native UI, local-vs-chat paging, dynamic widget geometry, draft restoration, directly rendered descriptions and title-only headers across narrow/multiline layouts, answer-only navigation, pinned auxiliary controls with a live note cursor, preview submission and continuation after partial answers, and narrow paged-review action priority. Single-question submission, explicit skips, and the auxiliary controls are covered by the tool-level suite. Pure tab-bar tests cover narrow/Unicode/control-sequence labels and active-tab preservation. Pure allocation tests compare the adapter against Pi 1.4.0's actual layout engine, including fallback and reentrancy cases. Real terminal painting and IME candidate windows still require interactive testing.

`benchmark` measures warm component CPU for ordinary, snippet, long-line-list, and long-CJK previews (100 trials each). Preview scenarios explicitly open the focused preview with Ctrl+O before render timing; ordinary questions show their descriptions without a preview. This avoids mistaking hidden preview work for a rendering speedup. It excludes startup, model/network, host scheduling, and terminal painting. An alternate extension entrypoint can be passed as its first argument for a before/after comparison.

## Structure

- `index.ts`: tool registration, mode/validation guards, execution, transcript rendering.
- `ask_user.ts`: compatibility entrypoint.
- `src/schema.ts`: strict per-kind schemas, raw-input/business validation, default normalization, compact question projection, and shared types.
- `src/component.ts`: questionnaire state, keyboard interaction, focus, rendering, and lifecycle.
- `src/format.ts`: model summaries, answer formatting, and named-context early error/cancellation factories.
- `src/ui-copy.ts`: shared fixed UI text and human-facing source/warning labels; separate from model-facing result content.
- `src/viewport.ts`: inline content budget and pure line-window calculations.
- `src/inline-layout.ts`: read-only, version-pinned editor-height adaptation.
- `src/preview.ts`: bounded preview layout and cache.
- `src/tabs.ts`: sanitized, responsive question-tab rendering.
