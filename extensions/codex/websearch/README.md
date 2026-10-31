# codex-websearch

Provides two web-search paths in Pi:

- **Codex native search:** injects `{"type":"web_search"}` into `openai-codex` Responses requests and leaves tool choice automatic.
- **`openai_web_search` Pi tool:** a normal model-callable Pi tool that works with other providers. It performs a separate OpenAI `web_search` request through either the public Responses API or Pi's OpenAI Codex Responses provider, then returns the answer and source URLs to the active model.

## Credentials and behavior

- The Pi tool runs every search through `ctx.modelRegistry.complete()`, so it works with any `openai` credential Pi resolves — an API key or "Sign in with ChatGPT" OAuth — and prefers that provider. It falls back to an `openai-codex` model when `openai` has no matching model. If the selected provider fails with an authentication or transport error before any search output arrives, the tool retries once with the other available credential; it does not retry after search output starts, to avoid duplicate searches. Pi supplies the credential; the extension never reads `auth.json` and never sends a token anywhere itself.
- Because both transports stream, the answer is rebuilt from `response.output_item.done` events merged into the final `response.completed` payload (whose own `output` array can be empty). The public `openai` path runs at `thinkingLevel: "low"` with `search_context_size: "medium"`; the Codex path keeps the bare `{"type":"web_search"}` tool.
- The calling model can choose the internal Responses API model per tool call: `gpt-6-luna` for routine lookups, or `gpt-6.1-sol` for deeper or conflicting research. Omitting `model` defaults to `gpt-6-luna`.
- The request forces the only configured tool (`web_search`), requests the source URLs, and does not store the response (`store: false`). It only returns success when the Responses object and a search action both report `completed` and at least one source is present; incomplete, failed, or unsourced results are errors. The `openai` transport sends `store: false` itself.
- The public `openai` path requires valid HTTP(S) source URLs. The Codex fallback also accepts named provider sources such as `{"type":"api","name":"oai-weather"}` because the Codex backend streams output items separately from the final response and may answer from internal APIs without citing URLs.
- The result declares an `outputSchema` and returns matching `structuredContent` (`{ model, answer, sources }`), so codemode scripts receive structured data instead of parsing the text; the model still receives the text content.
- Search queries are sent to OpenAI and are subject to the selected provider/account's access limits and billing. The tool returns a model-generated answer plus sources, not just raw search-engine snippets.
- If every available credential fails, the error names the provider and model, preserves the provider's original message, and adds an actionable hint: `/login <provider>` for authentication failures, or a network/proxy check for transport failures. A provider error is never reported as a missing Responses payload.
- `openai_web_search` is registered at extension load with `exposure: "hidden"` so the TUI can resolve its definition while replaying the transcript (after `/reload`, the chat is rebuilt before `session_start` runs). It is exposed for non-Codex models and hidden again when switching to Codex, which keeps Codex's native search path separate. Pi cannot physically unregister tools, so the extension re-registers it with the target exposure.
- In the interactive transcript the call line stays on one compact line: `openai_web_search <query> · <model> · <searching…|duration|failed>`, truncating the query first so the model and status stay visible. Successful results are hidden while the row is collapsed; expand it with ctrl+o or a click to read the full answer and sources. Failures stay visible because they carry the actionable reason.

## Verification

```bash
npm run check
npm test
```

With a non-Codex model that supports tools, ask a current or source-backed question and verify that `openai_web_search` returns a concise answer and source URLs.
