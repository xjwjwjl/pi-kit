# Command Code provider for Pi

Adds Command Code as a native Pi provider.

## Usage

1. Start or reload Pi.
2. Run `/login commandcode`.
3. Complete the Command Code browser login.
4. Select a Command Code model with `/model`.
5. Run `/commandcode-usage` to view live account credits, rolling limits, billing period, and usage totals.

The provider uses Command Code's OpenAI-compatible endpoint at `https://api.commandcode.ai/provider/v1` and stores the login credential in Pi's own `~/.pi/agent/auth.json`.

The model catalog is refreshed from `GET /models` after authentication. A small fallback catalog is included so the provider remains selectable before the first refresh. Login returns immediately after the browser callback; model discovery and key validation continue in Pi's asynchronous catalog refresh.

`/commandcode-usage` uses Command Code's account endpoints for live data and does not persist usage responses or print credentials. The existing `/usage` command from `usage-info` remains the local Pi session timeline.

## Status bar quota

When a Command Code model is active, the footer shows the account's rolling quota: the short (5-hour) window preferred, falling back to the weekly window. It refreshes at 5-minute boundaries, recovers from failures with the same exponential backoff as `codex-usage`, and only shows while the active provider is `commandcode`.

Background refreshes request only `/alpha/billing/credits` to keep the status bar lightweight; `login` writes the credential into Pi's own `~/.pi/agent/auth.json`, and the controller is configured to use the same credential path.

`/commandcode-usage` runs the full live report and, on success, also updates the status bar from that same response without a second API call.

Status bar cache is persisted at `~/.pi/agent/commandcode-usage-cache.json` using a per-credential cache hash (never the API key itself) and a shared directory lock so multiple Pi processes only query once per refresh window.
