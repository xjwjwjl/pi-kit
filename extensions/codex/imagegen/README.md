# codex-imagegen

Experimental model-callable image generation for Pi sessions using the `openai-codex` provider.

## Behavior

- Registers `codex_image_gen` for `openai-codex` / `openai-codex-responses` sessions only.
- Uses Pi's request-time provider authentication; no API key or token is stored by this extension.
- Sends one prompt to Codex's Images generation endpoint using `gpt-image-2.5-flare` by default, `quality: medium`, and `size: auto`.
- Accepts `count` from 1 to 4 (default 1). It sends one `n: 1` request per image and starts all requested calls concurrently, then returns all successful images and paths.
- For partial failures, successful images are kept and the tool reports which calls failed; it does not retry automatically.
- Switch the model with `/codex-image-model flare|sunburst`; use `/codex-image-model status` (or omit the argument) to see the current choice. The selection lasts for the current Pi process and resets to Flare after restart or reload.
- Saves each PNG to `generated-images/` under the current working directory by default and returns it as an image tool result.
- If the user explicitly requests a destination, the model may pass a workspace-relative PNG file path through `output_path`. For batches, numbered suffixes (`-01`, `-02`, etc.) are inserted before `.png`. Absolute paths, parent traversal, and non-PNG extensions are rejected.
- Only creates new images. Reference-image editing, output options, and streaming previews are not included in this MVP.

## Important

Codex's image endpoint is an implementation-specific backend interface, not a stable public API contract. Availability, model support, and quota are controlled by the signed-in OpenAI/Codex account and may change. Each generated image is a separate request and can consume quota. The tool instructions limit calls to explicit image-generation requests; use `count` only when the user asks for multiple options.

## Verification

```bash
npm run check
```

For a live smoke test, load the Codex extension package and explicitly ask the `openai-codex` model to create an image. This sends a real image-generation request and may consume account quota. Check the generated file under `generated-images/` (or the explicitly requested workspace-relative path) and the tool result preview in a terminal that supports inline images.
