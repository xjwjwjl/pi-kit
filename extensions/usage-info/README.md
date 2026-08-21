# usage-info

`/usage` analyzes `~/.pi/agent/sessions` (recursively, `*.jsonl`) as a single integrated usage view.

- **Usage** (`/usage`) — a usage timeline over time; select a period to see that period's provider→model tree (`Tab` toggles between the selected period's tree and the whole range's tree). `←`/`→` or `1`-`4` switches the range (Yesterday / Today / 7d / 30d). Only sessions from the last 30 days are scanned.

The view shows tokens, cost, and duration per period and per provider/model. Provider/model metrics are aggregated per day, so switching ranges recomputes instantly from the cached scan.

## Install

The extension is registered in `~/.pi/agent/settings.json` under `extensions` as `D:/code/pi-kit/extensions/usage-info`, loading the repo copy directly — no copying needed. After editing `index.ts`, run `/reload` in pi to pick up changes.
