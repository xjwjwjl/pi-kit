---
name: codex-sunburst-imagegen
description: Generate or edit PNG images with the fixed Sunburst image model using the signed-in local Codex account. Use when the user explicitly asks Codex to create or edit an image.
---

# Codex Sunburst Image Generation

Use the bundled CLI script for actual image generation. It reads the current local Codex login and always sends requests to the Sunburst model; never use an API key or Pi credentials.

## Workflow

1. Generate only when the user explicitly asks for an image or image edit. Preserve the requested subject, composition, style, lighting, palette, and text. Do not add unrequested details.
2. For edits, pass only local reference images that the user provided or identified, or images generated earlier in this request. In the prompt, identify each image by order and state what to change and what to preserve.
3. Use one image by default. For multiple candidates from the same prompt, use the exact requested count (maximum 25); use four only when the user asks for multiple without a number. Distinct concepts need distinct prompts and calls.
4. Leave quality at `high` and size at `auto` unless the user asks otherwise. A requested size is a target, not a guarantee.
5. Prepare a JSON request with `prompt`, and only when needed `count`, `quality`, `size`, `reference_images`, and `output_path`. Do not include a model field; the CLI pins Sunburst.
6. Pass that JSON on stdin to the bundled Node script with a quoted heredoc, so the shell does not expand the JSON. Do not Base64-encode it and do not add extra flags. Example:

   ```bash
   node "<absolute-skill-directory>/scripts/generate.mjs" <<'JSON'
   {"prompt":"A detailed image prompt","count":1}
   JSON
   ```

7. The script saves new PNG files under `generated-images/` by default and prints their absolute paths and measured dimensions as JSON. Show the result using the absolute image path. Never overwrite an existing image; corrections use fresh filenames.
8. Allow at most one correction round for clear mismatches. Do not automatically retry login, access, rate-limit, or quota errors. Ask before further image requests if the mismatch is subjective or remains after that correction.

## Limits

- References: 1–8 PNG/JPG/JPEG/WebP files, up to 20 MiB each.
- Count: 1–25. Each candidate is a separate request and may consume Codex image quota.
- Size: `auto` or dimensions supported by the script's validation rules. The returned dimensions may differ from the requested size.
- The script needs Node.js 24 or newer. It is a single file; Bash and a wrapper script are not required. On Windows it reads the signed-in user's system HTTPS proxy from the registry when proxy use is enabled, then restarts itself once with `--use-env-proxy`.
- The script requires local Codex CLI login state. It does not work in cloud ChatGPT Work because that runtime cannot access this machine's Codex credentials.
- `node scripts/generate.mjs --check-auth` checks local login without making an image request or consuming quota.
- Failed generations report the reason directly: a missing or rejected login, an HTTP status with a redacted service message, or a network diagnostic code.
