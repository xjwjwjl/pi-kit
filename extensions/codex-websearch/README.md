# codex-websearch

Enables Codex's native server-side `web_search` tool in Pi for the active `openai-codex` model.

## Behavior

- Default: adds `{"type":"web_search"}` to every Codex Responses request, while leaving `tool_choice` as automatic.
- Non-Codex providers are unchanged.
- Pi currently does not render Codex web-search event details or citation annotations, so this extension asks Codex to include full source URLs only when it uses native web search.
- The extension does not call DeepSeek or any local search backend.
- Search availability and usage limits are determined by the active ChatGPT/Codex account and the selected Codex model.

## Commands

```text
/codex-websearch status             # Show whether automatic search is on or off
/codex-websearch on                 # Enable automatic native search
/codex-websearch off                # Disable automatic native search for this session
/codex-websearch <question>         # Immediately submit one required native web-search query
```

`off` is session-scoped. Manual `/codex-websearch <question>` queries still work while automatic mode is off. A new or reloaded session returns to automatic mode.

## Verification

```bash
npm run check
npm test
```

Use `/codex-websearch <question>` with an `openai-codex` model for a deterministic manual-search smoke test.
