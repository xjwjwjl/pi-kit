# Herdr Agent Sidebar

Pi extension that keeps the Herdr Agent pane's second row populated with lowercase English state labels, initializing new sessions to `idle`. It shows `working`, `reply needed`, `idle`, or `unknown` as applicable; while Herdr marks a run `done`, it shows `done · MM-DD HH:mm`, `stopped`, or `failed`. Once a completion is seen and Herdr returns to `idle`, the row shows `idle`.

The extension reports display-only state labels and bridges Pi's `ask_user` tool start/end events to Herdr's `herdr:blocked` lifecycle channel, so the agent becomes blocked only while the question UI is open. It runs only in an interactive TUI session inside a Herdr-managed pane; RPC, JSON, and print sessions do not report metadata or blocked events, even when they inherit `HERDR_*` variables.

Completion labels are published only at `agent_settled`. Turn outcomes and the active attempt's abort signal cover cancellations that skip `agent_before_settle`, including cancellation during retry backoff. A new attempt or session resets the previous outcome.

Metadata is scoped to `--agent pi --applies-to-source herdr:pi` and uses the `pi-completion-time` source, so Pi labels cannot apply to other agents. This extension requires Herdr's Pi lifecycle integration (`herdr integration install pi`). On session shutdown (including reload), it balances any outstanding blocked signal and clears only its own state labels. Writes are serialized so an in-flight update cannot undo shutdown cleanup.

## Herdr sidebar setup

Herdr's default second row shows the agent name, not `state_text`. Add this Pi-only override to `~/.config/herdr/config.toml` to display the extension's state labels without changing other agents' layouts:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "machine", "workspace", "tab"],
  ["state_text"],
]
```

Validate and apply the layout without restarting panes:

```sh
herdr config check
herdr server reload-config
```
