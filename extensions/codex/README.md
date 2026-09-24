# Codex Pi 插件集合

`extensions/codex/` 统一管理 Codex 相关的 Pi 插件，注册一次即可加载全部：

| 子包 | 入口 | 功能 |
|---|---|---|
| `usage/` | `usage/index.ts` | 状态栏额度 + `/codex-usage` 用量报告 |
| `reset-credit/` | `reset-credit/index.ts` | `/codex-reset-credit` 查询/消费 reset credit |
| `fast-mode/` | `fast-mode/index.ts` | `openai-codex` 请求默认 `service_tier: priority` |
| `websearch/` | `websearch/index.ts` | Codex 模型原生 `web_search` 能力 |
| `imagegen/` | `imagegen/index.ts` | Codex OAuth 生图（默认 Flare，支持并发生成 1–4 张；`/codex-image-model` 切换模型） |

## 注册

在 `~/.pi/agent/settings.json` 的 `extensions` 中加入 `D:/code/pi-kit/extensions/codex`（或项目 `.pi/settings.json`），然后重启或 `/reload`。

## 子包开发

各子包保持独立 `package.json` 与依赖，可在子目录内单独执行：

```bash
cd extensions/codex/usage && npm run check
```

或在聚合包根目录执行全量检查：

```bash
cd extensions/codex && npm run check
```

## 事件联动

- `reset-credit` 消费成功后发出 `openai-codex:reset-credit-consumed`；
- `usage` 监听该事件并强制刷新状态栏额度。

## 注意

- 聚合包仅声明入口与脚本，不共享子包源码；子包之间通过 `pi.events` 事件通信。
- 底层 reset-credit / usage 接口是 Codex 内部接口，非公开稳定 API。
- `imagegen` 调用 Codex Images 内部接口，可能随服务端调整；详见子包 README。
