# codex-websearch

Enables Codex's native server-side `web_search` tool in Pi for the active `openai-codex` model.

## Behavior

- Always adds `{"type":"web_search"}` to every Codex Responses request, while leaving `tool_choice` as automatic.
- Non-Codex providers are unchanged.
- There is no toggle command: native search is enabled consistently for the session.
- Pi currently does not render Codex web-search event details or citation annotations, so this extension asks Codex to include full source URLs when it uses native web search.
- The extension does not call DeepSeek or any local search backend.
- Search availability and usage limits are determined by the active ChatGPT/Codex account and the selected Codex model.

## Verification

```bash
npm run check
npm test
```

Use a normal prompt with an `openai-codex` model to verify that current or source-backed questions use native web search and include source URLs.
