# Pi Task Router (experimental)

A task router for Pi sessions using DeepSeek V4 Pro or Flash.

It adapts the operational idea behind `dsh-router-standard`—make the work style
explicit and user-controllable—without importing its DSH/Cordis runtime or
claiming that prompt wording can prove or control a model's internal reasoning
mechanism. Its **strict Flash first-turn profile** is an experimental interface
profile selected for measured first-thinking-prefix behavior.

## What it does

- On the first request made with a `deepseek-v4-pro` or `deepseek-v4-flash`
  model ID, classifies the task as `inspect`, `act`, or `neutral`.
- Locks that automatic classification for the active session branch.
- For the first non-neutral Flash request only, replaces the system prompt with
  the minimal `You are a helpful software engineer assistant.` persona and
  limits the tool surface to the already-active `bash` and `edit` tools.
- Restores the original tool surface after the first tool-call decision (or
  when that first run settles without one); later requests use Pi's normal
  system prompt plus short advisory route guidance.
- Uses short **advisory** system-prompt guidance for Pro and post-first-turn
  Flash requests.
- Exposes a session-persistent `/router` command for status and manual override.
- Restores the route when a session is resumed or when `/tree` changes branch.

The model ID is checked rather than the provider name, so direct DeepSeek and
proxy routes such as `gogate/deepseek-v4-pro` are covered.

## Safety and non-goals

This extension deliberately **does not**:

- alter provider transport payload fields, thinking level, sampling, or model selection;
- use Pi's provider-request hook;
- activate a tool that was not already active before the strict Flash profile;
- make claims about DeepSeek's hidden architecture or reasoning modes.

**Strict-profile trade-off:** the first qualifying Flash request intentionally
replaces Pi's normal system prompt and temporarily removes other active tools.
The profile is skipped rather than enabling missing tools. It is experimental,
may affect first-turn behavior beyond the `We need` / `Let me` prefix, and does
not guarantee either prefix. Pi's user message and runtime tool/safety controls
remain in effect, but Pi's normal **prompt-level** instructions, project context,
and tool guidance are intentionally absent from that strict first request.
Classification remains a transparent keyword heuristic.

## Routes

| Route | Automatic signals | First qualifying Flash request | Later / Pro behavior |
| --- | --- | --- | --- |
| `inspect` | Fix, debug, review, refactor, migration, analysis | Strict minimal persona + `bash/edit` | Gather evidence first, make focused compatible changes, then verify. |
| `act` | Build, create, develop, implement, deploy | Strict minimal persona + `bash/edit` | Make a brief design decision, implement using local patterns, then verify. |
| `neutral` | Tied, unmatched, or non-coding prompt | Strict profile is skipped | Adds no routing prompt. |

The first DeepSeek V4 request locks `autoMode` for the session branch. A later
model switch does not recalculate it. If the session starts on another model,
the first request after switching to DeepSeek V4 establishes the automatic mode.

For a fresh Flash branch with both `bash` and `edit` already enabled, that first
non-neutral request consumes the strict profile. The extension records the prior
tool set in a custom session entry, restores it after the first tool-call
decision or final settlement, and treats reload/resume during that run as a safe
restore rather than trying to resume the restricted state.

## Commands

```text
/router                 Show router status
/router inspect         Force inspect mode for this session branch
/router act             Force act mode for this session branch
/router neutral         Force neutral mode for this session branch
/router auto            Remove the manual override and restore the initial auto mode
```

Manual overrides and strict-profile recovery data survive `/reload`, resume, and
`/tree` branch navigation because they are stored in Pi custom session entries.
Those entries never enter the LLM context.

## Observed first-prefix check

On **2026-08-17 (Asia/Shanghai)**, using direct
`deepseek/deepseek-v4-flash` at Pi thinking level `max`, fresh isolated
sessions, and a fixed maintenance prompt:

- Baseline Pi request: `We need` **0/10**, `Let me` **10/10**.
- Earlier advisory-only router: `We need` **0/10**, `Let me` **10/10**.
- Strict first-turn profile: `We need` **9/10**, `Let me` **1/10**.

A follow-up replication on **2026-08-18 (Asia/Shanghai)** used the actual
extension with the same model, task, `max` level, clean sessions, and original
`read/bash/edit/write` surface. Its strict first request again yielded
`We need` **9/10**, `Let me` **1/10**. The two matching 10-run batches are
therefore descriptively **18/20** for that fixed task, not a `We need`
guarantee.

That replication also isolated the tool-surface variable: the same minimal
persona and task with **only `bash`** available on the first request yielded
`We need` **0/10**, `Let me` **10/10**. It was intentionally run as a direct
interface ablation rather than through this extension, because the extension
correctly skips strict mode when either `bash` or `edit` is absent. Aborting
each sample after the captured prefix makes the expected provider stream-end
error non-diagnostic; no task-completion claim is made.

### Prompt-only first-prefix check

A later candidate profile was tested on **2026-08-18 (Asia/Shanghai)** with the
same direct Flash model, `max` thinking level, fixed task, fresh sessions, and
no extension:

```text
You are a helpful software engineer assistant.when you thought,thought in ENGLISH, start with "We need.."
```

Pi sends that exact text at the **start** of its system prompt, followed only by
its normal current-working-directory line. A local wire check confirmed that it
does not remove the normal `read/bash/edit/write` tool definitions.

- With **no tools**, the short persona alone and the candidate profile both
  yielded `We need` **10/10**. That condition therefore cannot attribute the
  result specifically to the added anchor sentence.
- With normal **`read/bash/edit/write`** tools, the short-persona control yielded
  `We need` **0/10**, `Let me` **9/10**, `other` **1/10**; the candidate profile
  yielded `We need` **10/10**.

This demonstrates a prompt-only way to control this fixed task's observed first
prefix without DSH/Cordis or first-turn tool reduction. A second candidate test
then prepended the same anchor to Pi's assembled `event.systemPrompt` rather
than replacing it: with full tools and the original Pi prompt retained, normal
Pi yielded `Let me` **10/10** and the candidate yielded `We need` **10/10**.

It is not implemented by this extension yet.

### Preserved-prompt task-quality check

On **2026-08-18 (Asia/Shanghai)**, the preserved-prompt candidate was evaluated
against normal Pi in a fresh, complete-task A/B: three isolated fixtures
(login-regression maintenance, pagination API boundaries, and a health-endpoint
feature), five independent samples per fixture and condition, all direct Flash
at `max` with full `read/bash/edit/write` tools. Each completion then faced
visible and post-run hidden tests, while hashes protected non-target source,
tests, and package metadata.

- Normal Pi: `Let me` **15/15**, task success **15/15**.
- Preserved-prompt candidate: `We need` **15/15**, task success **15/15**.
- Both conditions changed their intended target files and preserved all protected
  files in every sample. No response or transport errors occurred in the formal
  batch.
- The candidate averaged **16.0 s** and **$0.0196** per sample; normal Pi
  averaged **15.1 s** and **$0.0185**. This is roughly **6%** higher time and
  cost for the candidate, with no observed correctness gain or loss.

This is evidence that the candidate can control this fixed task suite's prefix
while preserving basic completion quality. It does not show that `We need` is a
better reasoning mode, and its isolated setup deliberately disabled project
context files such as `AGENTS.md`; a project-context and safety regression test
is still required before adoption.

### Preliminary task-quality check

On **2026-08-18 (Asia/Shanghai)**, a separate full-completion A/B used an
isolated Node login-regression fixture with a visible failing test, post-run
hidden contract tests, and hashes protecting tests, metadata, and unrelated auth
modules. It used the same direct Flash model and `max` thinking level, with ten
fresh baseline runs and ten fresh actual-extension strict runs in alternating
order. Only the category `We need`, `Let me`, `other`, or no thinking was
retained; no thinking text was stored.

- Baseline: `Let me` **10/10**, task success **10/10**.
- Strict: `We need` **7/10**, `Let me` **3/10**, task success **9/10**. The
  failure began a `bash` call but did not settle before the benchmark's original
  300-second cap; it did not modify protected files.
- By observed prefix across both conditions: `We need` task success **6/7**;
  `Let me` task success **13/13**.
- Among successful samples, strict runs averaged **19.0 s** and **$0.0429**;
  baseline runs averaged **11.4 s** and **$0.0149**.

This single, easy task does **not** show that `We need` reasoning is better. The
prefix is an observed consequence of a different first-request interface, not a
randomized treatment, and the sample is too small for a general quality claim.
It does show that a `We need` prefix is not a valid quality proxy and may carry
higher cost or latency under this profile. A separate three-run build prompt
check also began with other wording rather than either target prefix, so this
profile must not be treated as a universal `We need` guarantee. Test task
quality, tool selection, completion, cost, and latency independently before
promotion.

## Experimental use

Keep it isolated while evaluating behavior:

```bash
pi --no-extensions -e D:/code/pi-kit/extensions/_experimental/pi-task-router
```

To test alongside the normally configured global extensions:

```bash
pi -e D:/code/pi-kit/extensions/_experimental/pi-task-router
```

It intentionally does **not** update `~/.pi/agent/settings.json`. Promote it to
`extensions/pi-task-router/` and add it to settings only after successful manual
A/B testing. At minimum, compare fresh Flash sessions with and without the
extension on representative maintenance and build tasks; record the first
thinking prefix, first tool call, completion quality, and unintended changes.

## Development

```bash
cd D:/code/pi-kit/extensions/_experimental/pi-task-router
npm run check
```
