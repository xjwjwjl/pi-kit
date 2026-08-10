# token-monitor

`/token-monitor` is an offline TUI for analyzing token and cost usage recorded in Pi session JSONL files.

The extension intentionally uses strict attribution:

- Only persisted `assistant` messages are included.
- The message must contain a provider and model (`responseModel ?? model`).
- Tool, compaction, branch-summary, and otherwise unattributed usage is excluded.
- No runtime hooks, sidecar files, or price lookup are used.
- Forked sessions are de-duplicated by assistant entry id.

The default range is `Last 24h`. Use `t` to change the range, `r` to rescan sessions, `/` to search provider/model/scope, `s` to change sorting, `1`-`5` to switch tabs, and `q` or `Esc` to close.
