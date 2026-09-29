# codex-imagegen

Experimental model-callable image generation for Pi sessions using the `openai-codex` provider.

## Behavior

- Registers `codex_image_gen` for `openai-codex` / `openai-codex-responses` sessions only.
- Uses Pi's request-time provider authentication; no API key or token is stored by this extension.
- Sends one prompt to Codex's Images generation endpoint using `gpt-image-2.5-sunburst` by default, `size: auto`, and `quality` defaulting to `high`; decoded output is capped at 20 MiB per image.
- Accepts `count` from 1 to 25 (default 1). It sends one `n: 1` request per image and starts all requested calls concurrently, then returns all successful images and paths.
- Accepts `quality` as `low`, `medium`, or `high` (default `high`); the model passes it only when the user asks for a specific fidelity level. Higher quality produces more detail but takes longer and can cost more quota.
- Accepts `size` as `auto` (default) or a custom `WIDTHxHEIGHT`. Custom dimensions must use multiples of 16, have no edge over 3840 px, an aspect ratio no wider/taller than 3:1, and contain 655,360–8,294,400 pixels. For example, `1536x1024` and `1024x1536` are valid; standard `1920x1080` is rejected because 1080 is not divisible by 16. `auto` or a custom request does not guarantee every returned image will match the requested size exactly; the expanded TUI shows measured PNG dimensions, not the requested size.
- Accepts `reference_images`, up to 8 existing local `.png` / `.jpg` / `.jpeg` / `.webp` files (20 MiB each) that condition generation on references the user provided or explicitly identified. Relative paths (including `./`) and absolute paths may point anywhere on the local filesystem; symlink targets are also allowed. Missing files, unsupported extensions, and oversized files are rejected before any request is sent. Reference calls post to Codex's `/codex/images/edits` endpoint with data-URL images; text-only calls use `/codex/images/generations`.
- For partial failures, successful images are kept and the tool reports which calls failed; it does not retry automatically.
- The model-callable `model` parameter accepts `flare` or `sunburst`; omitted, it uses Sunburst by default or the current `/codex-image-model` selection. The `/codex-image-model flare|sunburst` command and `/codex-image-model status` remain available; command selection lasts for the current Pi process and resets to Sunburst after restart or reload.
- Saves each PNG to `generated-images/` under the current working directory by default and returns it as an image tool result.
- If the user explicitly requests a destination, the model may pass a workspace-relative PNG file path through `output_path`. For batches, numbered suffixes (`-01`, `-02`, etc.) are inserted before `.png`. Absolute paths, parent traversal, and non-PNG extensions are rejected.
- TUI display is custom-rendered: collapsed, the call shows only `codex_image_gen ×N`, plus `· N ref(s)` when references are used and muted `· Generating…` while running; after completion, that status is replaced by elapsed time. The prompt is hidden while collapsed and appears when expanded (up to 12 lines). A successful result adds no collapsed status line (a `⚠ n/N images` line appears only when some requests failed). Expanding the result adds a blank separator, an aligned field block (`refs` when used, `model` with the full model id and quality), and one clickable (when the terminal supports OSC 8 links) `├`/`└  <relative path>  [<W×H>]` line per image, plus failure reasons. Elapsed time covers the whole tool call from entry through batch completion, including auth resolution and output saving. The model still receives the full path list in the tool result text. Generated images are not shown as inline TUI previews yet.
- Creates new renders, and can condition them on reference images; in-place editing of an existing file, output options, and streaming previews are not included in this MVP.

## Important

Codex's image endpoint is an implementation-specific backend interface, not a stable public API contract. Availability, model support, reference-image support, and quota are controlled by the signed-in OpenAI/Codex account and may change. Each generated image is a separate request and can consume quota; large counts may be rate-limited. The tool instructions limit calls to explicit image-generation requests; use `count` only when the user asks for multiple options.

## TODO

- [ ] Add inline previews of generated images to the custom TUI result renderer. Until implemented, results show status and file details only; generated files are still saved normally.

## Verification

```bash
npm run check
```

For a live smoke test, load the Codex extension package and explicitly ask the `openai-codex` model to create an image. This sends a real image-generation request and may consume account quota. Check the generated file under `generated-images/` (or the explicitly requested workspace-relative path) and the tool result summary; inline TUI previews are a future TODO.
