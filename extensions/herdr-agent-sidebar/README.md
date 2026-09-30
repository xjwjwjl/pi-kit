# Herdr Agent Sidebar

Pi extension that keeps the Herdr Agent pane's second row populated with lowercase English state labels, initializing new sessions to `idle`. It shows `working`, `reply needed`, `idle`, or `unknown` as applicable; while Herdr marks a run `done`, it shows `done · MM-DD HH:mm`, `stopped`, or `failed`. Once a completion is seen and Herdr returns to `idle`, the row shows `idle`.

The extension reports display-only state labels and bridges Pi's `ask_user` tool start/end events to Herdr's `herdr:blocked` lifecycle channel, so the agent becomes blocked only while the question UI is open. It does nothing outside a Herdr-managed pane.
