# codex-fast-mode

为 `openai-codex` 请求提供默认开启、可切换的 `service_tier: "priority"`。

## 使用

```text
/fast          # toggle
/fast on       # enable
/fast off      # disable
/fast status   # 查看状态
```

也可以在启动时启用：

```bash
pi --fast
```

Fast Mode 只作用于 `openai-codex`。当请求已经显式设置合法的 `service_tier` 时，扩展不会覆盖它。

## 配置

配置集成在 Pi 的 `settings.json` 中，使用 `codex-fast-mode` 节：

```json
{
  "codex-fast-mode": {
    "enabled": true,
    "blacklist": ["gpt-5.4-mini"]
  }
}
```

全局配置位于 `~/.pi/agent/settings.json`（或 `PI_CODING_AGENT_DIR/settings.json`）。项目配置位于 `<project>/.pi/settings.json`，项目配置字段覆盖全局配置字段。项目配置只在项目受信时读取。

`blacklist` 是精确匹配的 Codex model id；默认所有 `openai-codex` 模型都启用，黑名单模型除外。
