# outline

`/outline` is a user-turn session navigator for Pi. It collapses assistant/tool chains into one row per user turn, prioritizes the active branch, and shows the final reply plus turn activity.

## Highlights

- Opens on the latest user turn in the active path; active turns use a `•` marker.
- Session rollup header: total turns, branch forks, cost, tokens, files touched, and the current model.
- Per-turn status glyphs: `!` errors, `$` costly, `+` wrote files, `~` read-only, `★` labeled.
- Shows model, elapsed time, request tokens, cost, tool/error count, and read/write file count.
- Search supports plain AND terms, quoted phrases, and facets: `model:`, `file:`, `tool:`, `label:`, `cost:>N`, `branch:active`.
- Drill into a turn (`z`) to see its internal chain (user message → tool calls → final reply) and jump to any entry.
- Uses Pi's configured selection, paging, branch, label, and filter keybindings while retaining Vim-style aliases.

## Usage

- `↑` / `↓` or `j` / `k`: select a user turn
- `PageUp` / `PageDown`: move by one page
- `g` then `g` / `G`: jump to the first / last visible turn
- `Enter`: navigate Pi to the selected turn's final reply (continue after the answer); falls back to the user message when the turn has no final reply
- `f`: navigate to the user message to re-edit and re-ask the question
- `z`: drill into the selected turn; then `↑`/`↓` to pick an entry and `Enter` to jump to it
- `Tab`: view the complete final assistant reply, activity, and file/tool summary
- `Space`: collapse or expand the selected branch
- `h` / `l` or configured Pi branch keys: collapse/expand or move between branch segments
- `/`: search; press `Enter` or `Esc` to finish editing the query
- `Ctrl+O` / `Shift+Ctrl+O`: cycle `all → active → labeled → branches` filters
- `t` or Pi's configured label key: edit the selected message label
- `q` / `Esc`: close the outline; in reply view or drill view, return to the tree

### Search

Terms are AND-combined across user prompts, final replies, labels, model names, tools, and file paths. Quoted phrases match literally, e.g. `checkpoint "tests pass"`.

Facets narrow by structured fields:

- `model:sonnet` — turn used a model whose id contains `sonnet`
- `file:schema` — a read/written path contains `schema`
- `tool:edit` — a tool named `edit` was called
- `label:checkpoint` — turn label contains `checkpoint`
- `cost:>0.05` / `cost:<0.05` — total turn cost above/below a threshold
- `branch:active` / `branch:inactive` — turn is on / off the active path

Facets combine with plain terms and each other, e.g. `file:schema model:sonnet`.

Pi changes session position only after `Enter`/`f`/drill-`Enter` and the normal branch-summary choice. Token values are cumulative request usage for the selected turn, not the size of newly added context.
