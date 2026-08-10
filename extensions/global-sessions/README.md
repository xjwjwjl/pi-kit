# global-sessions

`/sessions` is a read-only global Pi session browser. It scans the standard Pi session root (`<agent-dir>/sessions`), so sessions from all local projects can be found and resumed from any current project.

## Usage

```text
/sessions
/sessions migration
/sessions "schema.sql"
```

The optional argument pre-fills the full-text query. Search is case-insensitive and uses AND semantics; quoted text is treated as a phrase. It searches project paths, session names, first prompts, user/assistant text, and model names.

## TUI flow

1. A cancellable loader shows live file-scan progress.
2. The single-column browser groups sessions by their complete working directory. Project nodes show their session count and latest activity; session leaves show only time and title.
3. On first open, the current project and the most recently active different project are expanded. Other projects are collapsed and all project nodes are sorted by recent activity.
4. `↑`/`↓` select a project or session. `←`/`→`, Pi's configured tree keys, or `Space` collapse and expand project nodes. Search auto-expands only projects containing matches without losing the prior collapse state.
5. `Enter` on a session opens a compact preview with the full cwd, model, message count, first prompt, latest reply, and a matching snippet. `Enter` on a project does nothing.
6. `Tab` shows a scrollable transcript of the branch Pi will resume. `Tab` or `Esc` returns to the preview. `Enter` from the preview asks for confirmation before switching to the selected session.

`PgUp`/`PgDn` move through the tree or transcript; `g`/`G` navigate a transcript to its start/end.

## Safety and scope

- Scanning and previewing directly parse JSONL and never call `SessionManager.open()`, so legacy session files are not migrated or rewritten just by browsing them.
- Corrupt or incomplete files are skipped and counted instead of breaking the browser.
- Resuming uses Pi's normal `switchSession()` flow: the original working directory is restored and Pi retains its normal destination-project trust prompt.
- This extension intentionally does **not** delete, rename, export, or upload sessions.
- It scans only Pi's default global session root. Custom `sessionDir` roots are intentionally out of scope for v1.

## Install locally

This repository is the source of truth. Add the extension directory to the global Pi settings when you are ready to load it:

```json
{
  "extensions": [
    "D:/code/pi-kit/extensions/global-sessions"
  ]
}
```

For a one-off test without changing settings:

```bash
pi -e D:/code/pi-kit/extensions/global-sessions
```

## Development

```bash
npm install
npm run check
```
