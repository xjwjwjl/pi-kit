# deepseek-websearch

A local Pi extension that provides DeepSeek-backed web research without changing Pi's active model.

## Tools

### `deepseek_websearch`

Searches the web through DeepSeek's Anthropic-compatible endpoint using fixed `deepseek-v4-flash` and server-side `web_search_20250305`.

- Retries once with a stricter prompt when no usable sources are returned.
- Caps total server-side search steps at two.
- Injects the current date and IANA time zone into relative-time requests such as “today”, “tomorrow”, and “latest”, preventing stale model-memory dates from steering the search.
- Requires time-sensitive answers to prefer primary/official sources, report an as-of date/time when available, and label freshness as unverified when it cannot be established.
- Fails closed when sources are still absent.

### `deepseek_webfetch`

Mirrors Claude Code's client-side WebFetch flow:

```text
URL + extraction prompt
→ local HTTP GET and controlled redirects
→ HTML → Markdown
→ DeepSeek Flash applies the prompt to fetched content
→ HTTP metadata + concise result
```

Behavior:

- Requires `url` and `prompt`.
- Fetches only public HTTP/HTTPS URLs explicitly present in a user message or a prior `deepseek_websearch` / `deepseek_webfetch` result.
- Upgrades HTTP to HTTPS; follows only same-host or `www` redirects (up to 10); returns a cross-host redirect for a deliberate second call.
- Uses a 15-minute, 50MB LRU page cache; limits HTTP content to 10MB and requests to 60 seconds.
- Converts HTML with Turndown, requests compact terminal-friendly Markdown (short headings and bullets, no tables by default), injects the current date and time zone for relative-time extraction prompts, and requires page publication/data/forecast dates to be checked before describing content as current; it truncates page content to 100,000 characters before Flash processing and caps returned tool output to Pi's standard 2,000 lines / 50KB.
- In Pi TUI, expanded WebFetch results use Pi's native Markdown renderer; collapsed results show a compact plain-text preview.
- Blocks credentialed, localhost, private-IP, and common intranet URLs. Authenticated pages are unsupported.
- Persists binary content such as PDFs and images under the system temp directory, then reports the saved path in the tool result.

## Usage

```powershell
pi -e ./index.ts -p "Use deepseek_websearch to find the latest Rust stable release and answer with sources."

pi -e ./index.ts -p "Read https://example.com/ with deepseek_webfetch and explain the page's purpose."
```

Project-local install:

```powershell
pi install D:\code\my-pi\extensions\websearch -l
```

## Configuration

Both tools use fixed `deepseek-v4-flash` requests. Configure the DeepSeek key in Pi's global `settings.json` (default: `~/.pi/agent/settings.json`; `PI_CODING_AGENT_DIR` is respected):

```json
{
  "deepseek-websearch": {
    "apiKey": "sk-...",
    "timeZone": "Asia/Shanghai"
  }
}
```

`deepseek-websearch.timeZone` is optional and must be an IANA time-zone name such as `Asia/Shanghai`; when omitted or invalid, the extension uses the host system time zone. The extension intentionally does not reuse Pi `models.json` or `auth.json` provider credentials, keeping these tools independent from the active Pi model configuration.

## Verification

```powershell
npm test
npm run smoke -- "latest Rust stable release"
```

The smoke script exercises Web Search and never prints the key.
