# gogate-failover

Pi extension that automatically switches to another `gogate` model when the current model returns a quota-like failure.

## Observed failure covered

The extension handles the failure seen in session `01a036f9-6954-7b30-9550-15c01a80f66a`:

```text
OpenAI API error (429): 429 status code (no body)
```

Pi's built-in retry would otherwise retry the same model repeatedly. The extension changes the model, hides the failed assistant turn, queues an internal continuation, and shows one Warning notification instead of an Error.

## Behavior

- Only handles the configured provider, `gogate` by default.
- Uses `enabledModels`/`scopedModels` as the default failover pool.
- If an explicit model list is configured, only that list is used.
- Avoids a failed model for 30 minutes in the current Pi runtime.
- Tries each model at most once per high-level user prompt.
- Keeps the successful fallback model selected for subsequent turns.
- Uses a hidden continuation message so failover is shown as a Warning, not an Error.
- Preserves the active thinking level and normalizes unsigned reasoning text back into Pi's thinking channel when needed.
- Does not automatically add `gogate/glm/glm-5.2` unless it is enabled or explicitly configured.

## Installation

Add the repository extension path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "D:/code/pi-kit/extensions/gogate-failover"
  ]
}
```

Then restart Pi or run `/reload`.

For a one-off test:

```bash
pi -e D:/code/pi-kit/extensions/gogate-failover
```

## Optional configuration

Create `~/.pi/agent/gogate-failover.json`:

```json
{
  "enabled": true,
  "provider": "gogate",
  "models": [
    "gogate/deepseek-v4-flash",
    "gogate/deepseek-v4-flash-vision-exp"
  ],
  "cooldownMs": 1800000,
  "maxSwitchesPerRun": 1
}
```

`models` accepts full model keys or model IDs. Omit it to follow Pi's current `enabledModels` scope.

## Commands

```text
/gogate-failover status
/gogate-failover reset
```

`reset` clears the current runtime's failed-model cooldowns. It does not change the selected model.
