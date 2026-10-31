# Codex Sunburst Image Generation

This is a local Codex skill backed by a small Node.js CLI (`scripts/generate.mjs`). It fixes the image model to `gpt-image-2.5-sunburst` and reads the current Codex CLI ChatGPT login from `CODEX_HOME/auth.json` (or `~/.codex/auth.json`). It does not read Pi credentials or use `OPENAI_API_KEY`.

Requests are passed as one JSON object on stdin, with no Base64 encoding and no Bash wrapper:

```bash
node scripts/generate.mjs <<'JSON'
{"prompt":"A detailed image prompt","count":1}
JSON
```

The CLI sends the access token only to `chatgpt.com`, does not print or persist it, and saves generated PNGs under the active workspace. On Windows, the CLI reads the signed-in user's system HTTPS proxy from the registry when proxy use is enabled and restarts itself once with `--use-env-proxy`; this replaces the previous Bash wrapper. Run `node scripts/generate.mjs --check-auth` to check local login without making an image request or consuming quota. Failed generations report the reason directly, so no separate connectivity probe is needed.

The image endpoint is a Codex backend interface rather than a stable public API. OpenAI may change its availability, request format, authentication requirements, supported options, or quota behavior. This package intentionally performs no live image request during installation or tests.

## Check

```bash
npm run check
```

The script needs Node.js 24 or newer and no longer requires Bash.
