# pi-draw

pi-native diagram generation, saving, and preview.

This extension intentionally does not manage LLM provider configuration. It uses
the current pi session/model and only provides:

- Excalidraw generation guidance for freeform diagram requests
- Native Mermaid scene saving and SVG preview for Mermaid requests
- `pi_draw_save_scene` for saving, repairing, and optimizing generated skeleton JSON
- `pi_draw_save_mermaid_scene` for saving Mermaid DSL without converting it to Excalidraw
- `/draw-excalidraw`, `/draw-mermaid`, `/draw-preview`, and `/draw-status` helper commands
- Hono + React/Vite render-only preview for saved `.pi-draw.json` scenes
- SSE live preview events while `pi_draw_save_scene` arguments stream from Pi

## Install

```powershell
pi install D:\code\my-pi\extensions\pi-draw -l
```

## Usage

Ask pi for a diagram:

```text
画一个 pi-coding-agents extension 的架构图
```

For explicit prompt preparation:

```text
/draw-excalidraw 画一个登录流程图，包含成功、失败和重试
/draw-mermaid 画一个登录流程图，包含成功、失败和重试
```

`/draw-excalidraw <request>` always creates an Excalidraw canvas scene with
`pi_draw_save_scene`. `/draw-mermaid <request>` always creates a native Mermaid
SVG scene with `pi_draw_save_mermaid_scene`. The preview opens only after the
scene is saved. If a preview page is already open, later saves update that page
instead of opening another browser tab.

Open the local preview:

```text
/draw-preview
/draw-preview .pi/draw/login-flow.pi-draw.json
/draw-status
```

The preview page is render-only: it does not contain chat input, conversation
history, or browser-to-Pi message APIs. Continue the conversation in Pi. While
Pi streams a `pi_draw_save_scene` tool call, the page progressively renders
parsable elements; after save succeeds, it reloads the final scene file.
Mermaid scenes render as native Mermaid SVG in a separate preview surface, not
as Excalidraw canvas elements.

Scene files are saved under:

```text
.pi/draw/*.pi-draw.json
```

## Development

```powershell
npm install
npm run verify
```

`npm run verify` builds the React preview and runs TypeScript type checks.
