# websearch-deepseek

Pure Pi tools for DeepSeek's Search and Fetch APIs. The tools make HTTP requests only: they do not call a model, synthesize answers, extract page content, or parse HTML locally.

## Tools

### `deepseek_websearch`

Calls `POST https://api.deepseek.com/v1/tools/search` and returns ranked sources.

- `query` is required and must be 1-128 Unicode characters. Supports `site:`, `-site:`, `lang:`, `after:`, `before:`, quoted phrases, and other DeepSeek search syntax.
- `count` is optional, 1-50, default 8. Requests use `need_content: false`.
- Results include title, URL, summary, site name, publication date, authority (`-1` means unknown), and rerank score.
- The result text starts with the current date and time zone, so relative-time answers can be judged against publication dates. Dates are UTC RFC 3339; missing dates are reported as unknown.
- URLs are deduplicated and all returned URLs are listed, so `deepseek_webfetch` can read any of them.
- No results is a successful result, not a tool failure. The current model should refine the query if needed.
- The tool returns sources only. Synthesize the answer with the current session model and cite the returned URLs.

### `deepseek_webfetch`

Calls `POST https://api.deepseek.com/v1/tools/fetch` and returns the page title and Markdown content.

- `url` is required. It must be a public HTTP/HTTPS URL with a host, no embedded credentials, and at most 8,192 characters.
- The URL must appear in a user message or a prior `deepseek_websearch`/`deepseek_webfetch` result.
- The tool does not extract or summarize. Read the returned Markdown with the current session model.
- The model-facing output is capped at Pi's standard 2,000 lines / 50 KB. The structured result keeps up to 200,000 characters and reports whether it was truncated.
- Binary content such as PDFs and images is not supported by DeepSeek Fetch; the API may return `403` or `404`.
- Responses are not cached.

## Structured results

Both tools declare an `outputSchema` and return matching `structuredContent`, so codemode scripts receive JSON while the model receives readable text. They also declare `readOnlyHint` and `openWorldHint` annotations, and provide compact collapsed renderers with expanded Markdown/text views.

## Configuration

Set the key in Pi's global `settings.json` (located through `getAgentDir()`):

```json
{
  "websearch-deepseek": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.deepseek.com",
    "timeZone": "Asia/Shanghai"
  }
}
```

- `apiKey` can also be supplied with `DEEPSEEK_API_KEY`; the settings value takes precedence.
- `baseUrl` is optional. It defaults to `https://api.deepseek.com`; a trailing `/v1` is removed.
- `timeZone` is optional and must be an IANA name such as `Asia/Shanghai`. Invalid values fall back to the host system time zone.
- The extension intentionally does not reuse Pi `models.json` or `auth.json` provider credentials.

## Errors and limits

- `408`, `429`, and `5xx` responses are retried up to two times. `Retry-After` is honored.
- `401` means an invalid or missing key; `402` means insufficient balance; `403` means the Fetch request was refused by DeepSeek's security policy; `404` means Fetch found no usable content.
- Search and Fetch are billed by DeepSeek per successful request (5 CNY per 1,000 requests at the time of writing), with account-level QPS limits of 100 for Search and 25 for Fetch.

## Usage

```powershell
pi -e ./index.ts -p "Use deepseek_websearch to find the latest DeepSeek API release notes and cite the URLs."

pi -e ./index.ts -p "Use deepseek_webfetch on https://api-docs.deepseek.com/zh-cn/guides/search/ and summarize it."
```

Project-local install:

```powershell
pi install D:\code\pi-kit\extensions\websearch-deepseek -l
```

## Verification

```powershell
npm test
npm run check
npm run smoke -- "latest DeepSeek API news"
```

The smoke script performs a real Search request and never prints the key.
