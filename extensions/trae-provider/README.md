# trae-provider

用你的 **TRAE CN 账号**在 pi 里直接使用 TRAE 模型（走 `llm_utils_chat` 明文通道，扣 TRAE 积分）。

无代理、无中间层，pi 原生 provider（`createProvider` + OAuth + `streamSimple`），凭证生命周期（登录/自动刷新/登出）全部由 Pi 管理。

## 使用

| 命令 | 说明 |
|---|---|
| `/login trae` | 浏览器手机号登录（自动回跳捕获，无需复制链接；失败可手动粘贴） |
| `/model` | 选 `trae/DeepSeek-V4-Flash-Official` |
| `/trae.usage` | 查看 TRAE 积分统计（额度/已用/剩余） |
| `/logout` | 内建命令，选择 `TRAE CN` 后登出（清完整 credential） |

- JWT 约 14 天，refreshToken 由 Pi 自动刷新（`ExchangeToken` 轮换）免维护
- 唯一模型：`DeepSeek-V4-Flash-Official`（1M 上下文 / 384K 输出元数据上限，展示思考块）
- **思考控制**：对齐用户 deepseek provider 配置，仅 `max` 受支持（请求发 `reasoning.effort=max`）；`xhigh`/`off` 等不支持时不发送。**输出长度控制未验证**，不发送 `max_tokens`

## 目录

```
index.ts               入口（原生 Provider 注册 + trae.usage 命令）
src/
  provider.ts          createTraeProvider()：模型目录 + OAuth auth + filterModels
  model-catalog.ts     TRAE 模型目录
  auth/
    credential.ts      TraeCredential（token + 设备身份同存一份）、守卫、有效期归一化
    oauth.ts           login / refresh / toAuth（ExchangeToken / GetUserInfo）
    callback-server.ts localhost 回调服务器的 ready/result/close 生命周期
  client/
    trae-client.ts     统一 HTTP 出口（fetch 可注入、超时、onResponse）
    headers.ts         endpoint profile 与大小写无关的 header 合并
    errors.ts          可辨别错误类型 + 错误文本脱敏
  protocol/
    request.ts         Context -> TRAE 请求体（纯函数）
    sse.ts             SSE bytes -> frame（标准 SSE 语义）
    events.ts          frame -> 已验证领域事件（严格校验）
    types.ts           TRAE wire schema 类型
  stream.ts            领域事件 -> Pi AssistantMessageEventStream 状态机
  usage.ts             积分查询（复用 Pi resolved auth）+ 格式化
test/                  Node built-in test runner（离线，不访问 TRAE 网络）
docs/                  逆向学习笔记 + 维护手册 + 重构设计
```

## 文档

- `docs/trae-reverse-engineering.md` — TRAE 协议逆向全记录（14 章节）
- `docs/trae-provider-maintenance.md` — **维护/升级/踩坑手册**（必读）
- `docs/trae-provider-refactor-plan.md` — 0.2.0 重构实施设计与验收规格

## 开发

```bash
npm ci && npm run check   # typecheck + 离线单元测试
```

## ⚠️ 风险

违反 TRAE 服务条款、账号有封禁风险；私有协议无文档、可能随客户端升级失效（见维护手册第 4 节检查清单）。个人自用自担。
