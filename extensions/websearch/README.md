# deepseek-websearch

Register a local Pi tool named `deepseek_websearch` that always uses a fixed DeepSeek Web Search backend, regardless of the model currently driving Pi.

## What it does

This extension does not change Pi's active model.

Instead, it adds one local tool:

- `deepseek_websearch`

When any Pi model calls that tool, the extension:

1. sends the search request to DeepSeek's Anthropic-compatible endpoint
2. uses the fixed DeepSeek model `deepseek-v4-flash`
3. enables DeepSeek server-side `web_search_20250305`
4. returns the final answer and source list back to the current Pi model as a tool result

If DeepSeek answers without any web-search sources, the extension retries once with a stricter force-search prompt. If sources are still missing, the tool fails instead of returning an unsourced answer.

That means your main Pi model can be `gpt-5`, `gemini`, normal `deepseek`, or anything else, while web search is always handled by this extension's DeepSeek backend.

## Usage

Quick test:

```powershell
pi -e ./index.ts --provider ve-openai --model gpt-5.5 -p "Use deepseek_websearch to find the latest Rust stable release and answer with sources."
```

Real network smoke test:

```powershell
npm run smoke -- "latest Rust stable release"
```

Project-local install:

```powershell
pi install D:\code\my-pi\extensions\websearch -l
```

## Configuration

This extension does not expose a model setting anymore.

It always uses:

- search model: `deepseek-v4-flash`
- finalizer model: `deepseek-v4-flash`

Configure the DeepSeek Web Search API key in `~/.pi/agent/settings.json`:

```json
{
  "deepseek-websearch": {
    "apiKey": "sk-..."
  }
}
```

Only `deepseek-websearch.apiKey` in `~/.pi/agent/settings.json` is used. The extension intentionally does not read Pi's `models.json` or `auth.json` DeepSeek provider credentials, so the web search backend stays independent from the active Pi model configuration.

The smoke test prints whether the key was found in settings, but never prints the key itself.

## Notes

- This extension is now a local Pi tool implementation, not a custom provider.
- The active Pi model does not need to be DeepSeek.
- The internal DeepSeek Web Search request uses a fixed `max_uses: 2`, so each tool call can perform up to two server-side web search steps when the DeepSeek backend decides it is useful.
- If DeepSeek returns an incomplete intermediate output such as DSML tool-call markup instead of a final answer, the extension attempts one extra no-tool finalization pass using `deepseek-v4-flash`. If that still does not produce a clean answer, the extension returns a brief fallback note plus the gathered sources instead of leaking intermediate markup.
- If DeepSeek does not return any web-search sources, the extension retries once with a stricter prompt and then fails closed instead of returning an unsourced answer.
