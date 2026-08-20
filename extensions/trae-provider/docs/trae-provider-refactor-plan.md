# TRAE Provider 重构实施设计

**状态：** 待实施  
**目标版本：** `0.2.0`（包含一次需要重新登录的凭证迁移）  
**适用 Pi 基线：** `@earendil-works/pi-coding-agent@0.84.2` / `@earendil-works/pi-ai@0.84.2`

本文是给实现者的设计与验收规格，不是运行代码。实现前应先阅读：

- `README.md`
- `docs/trae-provider-maintenance.md`
- `docs/trae-reverse-engineering.md`
- Pi 的 `docs/custom-provider.md`、`docs/extensions.md`

## 1. 背景与目标

该扩展的总体方向正确：直接注册 Pi Provider，由 Pi 负责模型选择、OAuth 生命周期和会话运行，扩展只负责 TRAE 私有协议的认证、请求转换与 SSE 流适配。不应退回本地 OpenAI 代理，也不应把调用逻辑放进一个普通工具。

当前实现的主要问题不是协议能力不足，而是边界不清：Pi 和扩展同时管理认证状态；流式响应把“不完整/无效”当作成功；登录回调、HTTP 请求、协议转换和状态文件耦合在少数大文件中。这次重构的目标是：

1. 让 Pi 成为唯一的凭证持久化与刷新协调者。
2. 把 TRAE 私有协议限制在可测试的纯转换层和 transport 层。
3. 确保任何网络、协议或认证异常都以 Pi 标准的流错误事件结束，绝不悬挂或伪造成功。
4. 保留已验证的文本、多轮工具调用和积分查询能力；未验证的协议字段不得猜测后上线。
5. 建立离线测试与可重复的 `npm run check`，避免每次 TRAE 客户端升级只能手工试错。

## 2. 范围与非目标

### 本次范围

- 将 `registerProvider("trae", config)` 的兼容层注册改为完整的原生 `Provider` 注册。
- 将 `uid`、`machineId`、`deviceId` 和 OAuth token 存入同一份 Pi OAuth credential。
- 删除扩展对 `~/.pi/agent/auth.json` 的直接读取，以及对 `trae-state.json` 的运行时依赖。
- 重写登录回调生命周期、请求 transport、SSE 解析和 Pi 事件投影。
- 用严格校验替代静默降级，尤其是流终态和工具参数 JSON。
- 重构积分查询，使其复用 Pi 已解析、必要时已刷新过的 Provider auth。
- 补单元测试、协议 fixture、构建脚本和文档。

### 明确非目标

- 不增加未实测的模型、图像输入、签到、账号轮换、代理服务或后台定时任务。
- 不自动重试聊天请求。聊天可能计费且服务端是否幂等未知，重试应交给 Pi 的上层策略或用户重发。
- 不根据猜测发送 `max_tokens`、思考等级或其他私有字段。
- 不读写 TRAE 桌面客户端的数据目录，也不修改 Pi 核心代码。
- 不把 JWT、refresh token、回调 URL 或请求正文写入日志、测试 fixture 或错误消息。

## 3. 当前缺陷与对应处理

| 现状 | 风险 | 重构要求 |
|---|---|---|
| `streamTrae()` 在 `try/catch` 前读取认证状态 | `getSession()` 抛错时异步流没有 `error/end`，Pi 可能持续等待 | 从创建 `AssistantMessage` 开始，整个异步流程都在同一个 `try/catch/finally` 内；所有失败发送标准 `error` 事件 |
| SSE EOF 默认被映射为 `stop` | 网络中断、网关截断会显示为正常回答 | 仅接收到且校验通过 `done` 事件后才能发送 `done`；缺少终态必须报 `TraeStreamIncompleteError` |
| 工具 arguments 解析失败后使用 `{}` | 可能对无参工具执行错误动作，或让模型陷入参数校验循环 | 工具 id、name、JSON object 都必须完整；任何缺失或非法 JSON 都使当前 Provider 响应失败 |
| 直接读取硬编码 `~/.pi/agent/auth.json` | 忽略 `PI_CODING_AGENT_DIR`、Pi CredentialStore 锁、自动刷新和存储格式演进 | 从 `SimpleStreamOptions` 和 `ctx.modelRegistry.getProviderAuth("trae")` 消费 Pi 已解析的 auth |
| `trae-state.json` 与 Pi OAuth credential 分开存储 | 登录/刷新/登出无法原子地更新完整身份，状态容易不一致 | 将设备身份字段放在 OAuth credential 扩展字段中；不再创建新 state 文件 |
| README 声明 `/trae.logout`，实现中不存在 | 用户按文档操作失败 | 使用 Pi 内建 `/logout` 选择 `TRAE CN`；移除虚构的扩展命令 |
| `auth.ts` 混合 OAuth、回调服务、文件状态、headers、HTTP 请求 | 难以测试且改一处容易影响所有路径 | 按 credential、OAuth、callback、client、protocol 拆分 |
| 自定义 SSE reader 逐行发射 `data` | 不符合标准 SSE 的多 `data:` 行记录语义，对分块/UTF-8 边界不稳健 | 使用按空行提交记录的 parser，保留 UTF-8 decoder 尾部并支持 CRLF |
| 请求忽略 `options.fetch`、`headers`、`onResponse`、`timeoutMs` | 无法注入测试 transport，也丢失 Pi 的请求级配置与观测 | client 必须透传和合并这些选项 |
| 模型宣称支持 max 思考，但请求体未使用 `options.reasoning` | Pi UI 与实际请求行为不一致 | 先验证 TRAE 控制字段；不能验证时不暴露该 thinking capability |
| 用量查询的空/非 JSON 成功响应被显示为 0 | 网络或上游异常会伪装成余额为零 | 响应 schema 不符合预期时显示明确错误，不能生成零余额表 |

## 4. 推荐架构

推荐使用 Pi 原生 `createProvider()` 构建完整 Provider，再通过 `pi.registerProvider(provider)` 注册。这样 OAuth 的刷新、跨请求锁、CredentialStore 写入与 `/logout` 全部由 Pi 管理，扩展只定义 TRAE 特有的 credential 字段和协议行为。

```text
Pi CredentialStore
  |
  | TraeCredential
  | access / refresh / expires / uid / machineId / deviceId
  v
Trae Provider.auth.oauth
  |- login()       浏览器与 localhost 回调，返回完整 credential
  |- refresh()     ExchangeToken，保留设备字段
  `- toAuth()      生成 JWT 与基础认证 headers
  |
  +--> streamSimple()
  |      Context -> TRAE request -> TraeClient -> SSE parser
  |      -> protocol events -> Pi AssistantMessageEventStream
  |
  `--> /trae.usage
         ctx.modelRegistry.getProviderAuth("trae")
         -> TraeClient JSON request -> Usage formatter
```

### 4.1 架构原则

1. **一个真相来源：** 凭证只由 Pi CredentialStore 持久化。扩展不得直接读写 `auth.json`，不得再维护第二份设备状态。
2. **纯函数优先：** Context 到 TRAE request、SSE frame 到领域事件、权益包到显示文本，均应是无 I/O 的纯函数。
3. **边界严格：** 私有协议异常应尽快以明确错误失败，不能以空文本、空对象或正常 `stop` 掩盖。
4. **I/O 可注入：** 所有 HTTP 调用经一个 client；client 使用 `options.fetch ?? globalThis.fetch`，因此测试不需要真实 TRAE 账号。
5. **不猜测协议：** 只有抓包或实际验证过的字段才能发送；保留原始证据的脱敏 fixture。
6. **最小兼容面：** 不为旧的双文件 credential 结构保留长期兼容层。新版本要求重新登录，避免不可靠的迁移写入。

## 5. 目标目录与职责

以下是推荐目录，不要求为极小函数单独建文件，但不得回到单个 `auth.ts`/`stream.ts` 承担全部职责的状态。

```text
index.ts                         # 仅注册 Provider 和 trae.usage 命令
src/
  provider.ts                    # createTraeProvider()、模型目录、Provider auth 组装
  model-catalog.ts               # 静态 Model<TraeApi>[] 定义
  auth/
    credential.ts                # TraeCredential、类型守卫、迁移错误
    oauth.ts                     # login、refresh、ExchangeToken、GetUserInfo
    callback-server.ts           # localhost listener 的 ready/result/close 生命周期
  client/
    trae-client.ts               # requestJson/requestStream、超时、headers、错误归一化
    headers.ts                   # endpoint profile 与大小写无关的 header 合并
    errors.ts                    # TraeHttpError、TraeProtocolError 等
  protocol/
    request.ts                   # Context -> llm_utils_chat 请求体
    sse.ts                       # SSE bytes -> SseFrame
    events.ts                    # SseFrame -> 已验证的 TRAE 领域事件
    types.ts                     # 仅 TRAE wire schema 类型
  stream.ts                      # 领域事件 -> Pi AssistantMessageEventStream
  usage.ts                       # 权益包请求和格式化
test/
  fixtures/                      # 脱敏的 SSE/JSON fixture
  auth.test.ts
  callback-server.test.ts
  headers.test.ts
  request.test.ts
  sse.test.ts
  stream.test.ts
  usage.test.ts
```

现有文件的迁移关系：

| 当前文件 | 目标处理 |
|---|---|
| `index.ts` | 保留，但收缩为注册与命令 wiring |
| `constants.ts` | 拆入 `model-catalog.ts` 与对应协议/client 模块 |
| `auth.ts` | 拆为 `auth/credential.ts`、`auth/oauth.ts`、`auth/callback-server.ts`、`client/*` |
| `state.ts` | 删除；不再创建或读取 `trae-state.json` |
| `stream.ts` | 拆为 `protocol/request.ts`、`protocol/sse.ts`、`protocol/events.ts`、`stream.ts` |
| `types.ts` | 移至 `protocol/types.ts`；使用精确的可选字段类型 |
| `usage.ts` | 保留领域职责，但改为接受 Pi resolved auth，而不是自行取 session |

## 6. 凭证与认证设计

### 6.1 Credential 数据模型

```ts
interface TraeCredential extends OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number; // Unix epoch milliseconds
  uid: string;
  machineId: string;
  deviceId: string;
  schemaVersion: 1;
}
```

要求：

- `uid`、`machineId`、`deviceId` 均为非空字符串。
- 只在成功完成 token exchange 和 user info 校验后返回 credential。
- `refresh()` 必须返回 `{ ...credential, access, refresh, expires }`，不能丢失设备字段和 `schemaVersion`。
- token 有效期归一化函数只接受明确的秒/毫秒输入，测试应覆盖 duration fallback、秒、毫秒和异常过去时间。
- 所有错误文本均不得插入 refresh token、JWT、完整 callback URL 或完整服务端 body。

### 6.2 原生 Provider 骨架

实现应使用 Pi 当前文档推荐的完整 Provider API，而不是 legacy config 的 `oauth` adapter。逻辑形态如下，字段名以已安装的 `pi-ai` 类型定义为准：

```ts
export function createTraeProvider(): Provider<TraeApi> {
  return createProvider({
    id: "trae",
    name: "TRAE CN",
    baseUrl: AGENT_HOST,
    auth: {
      oauth: {
        name: "TRAE 账号登录",
        login: loginTrae,
        refresh: refreshTrae,
        toAuth: toTraeAuth,
      },
    },
    models: TRAE_MODELS,
    filterModels: (models, credential) =>
      isTraeCredential(credential) ? models : [],
    api: {
      stream: streamTrae,
      streamSimple: streamTrae,
    },
  });
}
```

说明：

- `filterModels` 用于拒绝旧 credential。旧格式缺失设备字段时，不应让模型看似可选、实际首个请求才失败。
- `toTraeAuth()` 返回 `apiKey: credential.access` 和 TRAE 所需的基础认证 headers。端点专属 headers 由 `TraeClient` 的 profile 补充。
- Pi 负责 OAuth token 即将过期时的跨请求加锁刷新，并将刷新结果原子写回 CredentialStore；扩展不得自行绕过该机制。

### 6.3 登录流程

目标流程：

1. 使用 `crypto.randomBytes()` 生成新的 `machineId`、`deviceId`、`loginTraceId`。
2. 创建 `CallbackServer`，**等待 `listening` 成功**后才调用 `interaction.notify({ type: "auth_url", ... })`。
3. listener 只绑定 `127.0.0.1`，只接受预期的 `/authorize` 路径。其他路径返回 404，不能关闭 listener，也不能显示“登录成功”。
4. 监听器、手动粘贴输入和全局 OAuth `interaction.signal` 组成一个 race：
   - 浏览器 callback 先到：关闭 listener，abort 手动输入，继续 token exchange。
   - 用户粘贴有效 URL 先到：关闭 listener，继续 token exchange。
   - 用户取消或超时：关闭 listener，抛出 abort/cancel 错误。
5. 回调 URL 使用 `new URL()` 解析。`URLSearchParams` 已完成一次 percent decode，禁止无条件再次 `decodeURIComponent()`；仅当有确证的遗留双编码输入时采用受测的 fallback。
6. 如果服务端实际回传 `login_trace_id` 或等价 nonce，必须与本次登录的值比对；若协议不回传，则记录为已知协议限制，不伪造安全保证。
7. 通过 `ExchangeToken` 获取 access/refresh/expiry；再调用 `GetUserInfo` 获取 `uid`。只有完整字段均通过校验才返回 credential。

`CallbackServer` 建议接口：

```ts
interface CallbackServer {
  readonly callbackUrl: string;
  waitUntilReady(signal: AbortSignal): Promise<void>;
  waitForCallback(signal: AbortSignal): Promise<URL>;
  close(): Promise<void>;
}
```

无论成功、失败、超时或取消，`close()` 都必须在 `finally` 中调用，并且可重复调用。

### 6.4 刷新与登出

- `refreshTrae(credential, signal)` 只调用 ExchangeToken，并完整保留设备身份字段。
- refresh 的网络请求必须使用传入 `signal`；不要另起不受控请求。
- 不新增 `/trae.logout`。Pi 的内建 `/logout` 已经调用 CredentialStore 删除该 Provider 的完整 credential。
- README 和维护手册统一改为：`/logout` 后选择 `TRAE CN`。

### 6.5 旧状态迁移策略

旧版本将 token 放在 Pi auth.json、设备字段放在 `trae-state.json`。扩展 API 无法安全地在 `toAuth()` 中原子写回升级后的 credential，因此本次采用明确的破坏性迁移：

1. 新 Provider 检测旧 OAuth credential 缺少 `uid/machineId/deviceId/schemaVersion` 时，将模型过滤为不可用。
2. 任何直接调用尝试返回明确中文错误：`TRAE Provider 已升级，请使用 /logout 选择 TRAE CN 后重新 /login trae。`
3. 不再读取旧 `trae-state.json` 作为运行时 fallback。
4. 用户成功重新登录后，旧 state 文件成为无害遗留文件；不自动删除，避免 Pi 登录持久化失败时删除旧状态。发布说明可说明用户确认新登录正常后自行删除该文件。

这比“悄悄读取旧文件并在某次 refresh 时尝试迁移”更可预测，也避免两份状态重新出现。

## 7. HTTP Client 设计

### 7.1 单一出口

所有网络调用经 `TraeClient`：

```ts
interface TraeClient {
  requestJson<T>(request: TraeJsonRequest): Promise<T>;
  requestStream(request: TraeStreamRequest): Promise<Response>;
}
```

`request` 至少包含 `url/path`、`body`、`auth`、endpoint profile、`AbortSignal` 和 Pi request options。OAuth exchange 与 GetUserInfo 也应复用同一套“超时、错误截断、脱敏”基础设施，但它们使用不同的无 session profile。

### 7.2 Header 分层

headers 分三层合并，后者覆盖前者，比较时必须忽略 header 名大小写：

1. Pi 已解析的 Provider auth headers：JWT、uid、device id、machine id 等。
2. endpoint profile：`chat`、`usage`、`oauth` 的固定协议头，如 Content-Type、Accept、User-Agent、版本头。
3. `SimpleStreamOptions.headers` 或调用方额外 headers。

如果上层 headers 中某项为 `null`，按 Pi 语义删除该 header。最终发送前必须校验 chat/usage 所需认证字段存在，且不得在错误日志中打印它们。

### 7.3 Pi request options

`streamTrae()` 与 client 必须正确使用：

- `options.fetch ?? globalThis.fetch`：测试可注入 mock fetch，也允许 Pi 的请求 hook/transport 生效。
- `options.signal`：用户按 Escape 时立即取消 fetch 与 body reader。
- `options.headers`：合并到请求。
- `options.onResponse`：收到 HTTP response 后、读取 body 前调用一次，并传递 status 与 headers。
- `options.timeoutMs`：若调用方给出总请求超时，组合到 abort signal 中。

扩展自定义 watchdog 的建议：连接建连超时默认 30 秒；收到 response 后使用“空闲超时”而非粗暴的短总时长，以免长输出被误杀。idle timeout 每收到 SSE 字节重置，默认值和是否启用必须集中配置；所有 timer 在 `finally` 清理。若实现复杂度过高，第一版至少可靠支持调用方 `options.timeoutMs`，不要保留现有的无限等待行为。

### 7.4 错误模型与脱敏

定义可辨别的错误类型：

```ts
TraeAuthError              // 缺 credential 或认证字段不完整
TraeHttpError              // 包含 status、有限且已脱敏的 body summary
TraeProtocolError          // 不符合已知 wire schema
TraeStreamIncompleteError  // EOF 前未收到 done
TraeUnsupportedInputError  // 当前模型无法表达的 Pi content
```

规则：

- 非 2xx HTTP body 最多读取 4 KiB 用于诊断，先运行 token/authorization/query 参数脱敏。
- 401/403 返回“登录状态失效，请重新登录”的操作性提示；不在扩展内自动 refresh/retry。
- 429、5xx、网络错误必须保留可判断类型/status，但不自动重发可能计费的聊天。
- Provider error 只向 Pi 发送 `errorMessage`，不附带原始敏感 request/response。

## 8. Context 到 TRAE 请求的转换

`protocol/request.ts` 必须是纯函数，例如：

```ts
function buildTraeChatRequest(
  model: Model<TraeApi>,
  context: Context,
  options?: SimpleStreamOptions,
): TraeChatRequest;
```

### 8.1 消息映射规则

| Pi 消息 | TRAE 请求映射 | 规则 |
|---|---|---|
| `context.systemPrompt` | `{ role: "system", content: [{ type: "text", text }] }` | 只在非空时发送 |
| user text | `{ role: "user", content: [{ type: "text", text }] }` | 保留文本顺序 |
| user image | 不支持 | 当前模型声明 text-only，抛出明确错误，不生成未经验证的 `url` 字段 |
| assistant text | assistant `content` text block | 保留 |
| assistant thinking | 按已验证的历史回放格式序列化 | 不得通过 `any` 隐式丢弃；若上游只接受 text，写为具名 policy 并测试 |
| assistant toolCall | assistant 顶层 `tool_calls`，使用已验证的 `function_call` 格式 | 每个调用保持 id/name/arguments |
| 空 assistant | 不发送 | TRAE 已知会报参数错误 |
| toolResult text | `{ role: "tool", tool_call_id, name, content: [...] }` | content 必须为数组 |
| toolResult image | 不得静默丢失 | 当前 text-only 模型下生成确定性的不可读取说明，或在协议验证后改为支持；两种策略必须有测试 |
| toolResult `isError` | 采用 TRAE 已验证的错误表达 | 若上游无错误字段，在 text 前加稳定、可识别前缀，不能无声当成功 |

禁止在 protocol 模块中使用 `as any`。应导入 Pi 的 `UserMessage`、`AssistantMessage`、`ToolResultMessage`、`TextContent`、`ImageContent` 类型，使用角色分支完成窄化。

### 8.2 工具定义与工具结果

- `context.tools` 映射为 TRAE 已验证的 function schema；`parameters` 使用 JSON string 的现有协议格式。
- 不修改 tool name、description 或 schema，除非有正式兼容规则。
- 多个 tool result 保持 Pi 原始顺序。
- 与前一轮 assistant tool call 不匹配的 tool result 必须在本地报协议错误，而不是向上游发送损坏历史。

### 8.3 思考和输出 token 控制

当前实现的 `thinkingLevelMap` 宣称 `max` 可用，但请求体没有读取 `options.reasoning`；`maxTokens` 也没有被映射。这是上线前的协议验证闸门：

1. 用脱敏抓包或隔离的手工验证确认 TRAE 接受的思考控制字段、允许值和关闭行为。
2. 只有确认“Pi level -> 请求字段 -> TRAE 真实行为”完整闭环，才在 model catalog 暴露对应 `reasoning` 和 `thinkingLevelMap`。
3. 如果上游只会自动思考或控制字段未验证，则将模型标为不支持 Pi 可控 reasoning，不能为了 UI 展示保留虚假的 `max`。
4. 对 `maxTokens` 采用相同原则：验证字段后才发送；不能验证时只保留安全的模型元数据上限，不声称请求级控制生效。

实现者不得凭名称猜测 `thinking`, `reasoning`, `enable_thinking`, `max_tokens` 等私有字段。

## 9. SSE 与 Pi Event Stream 设计

### 9.1 SSE parser

`protocol/sse.ts` 接收 `ReadableStream<Uint8Array>`，输出：

```ts
interface SseFrame {
  event: string;
  data: string;
}
```

要求：

- `TextDecoder` 以 streaming mode 解码，EOF 时调用一次无参数 `decode()` flush 尾部字节。
- 支持 `\n`、`\r\n`、任意 HTTP chunk 边界和多行 `data:`。
- 一个 SSE record 在空行时提交；多个 `data:` 行以 `\n` 拼接。
- 忽略注释、`id:`、`retry:` 等未使用字段，但不能把它们当 data。
- EOF 可 flush 最后一个未以空行结束的 record；不过上层仍必须要求 TRAE `done` 终态。
- 已知的 `output`、`token_usage`、`done`、`error` event 若 JSON 非法，必须报 `TraeProtocolError`，不能静默跳过。
- 其他未认识的命名事件可以忽略以保持前向兼容，但应有可测试的“忽略未知 telemetry event”策略。

### 9.2 Wire event 校验

在 `protocol/events.ts` 将 frame 转为 discriminated union：

```ts
type TraeEvent =
  | { type: "output"; response?: string; reasoningContent?: string; toolCalls?: TraeToolCallDelta[] }
  | { type: "usage"; promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number }
  | { type: "done"; finishReason: string }
  | { type: "error"; code?: number; message: string }
  | { type: "ignored"; event: string };
```

不要把 wire JSON 直接 `as LLMOutputEvent` 后信任。最小校验包括对象类型、字符串字段、数值字段为有限非负数、工具调用 index 为非负整数。

### 9.3 Pi 事件投影状态机

`src/stream.ts` 应维护一个显式的 stream session state：

```text
created
  -> started
  -> receiving(output/usage)*
  -> terminal-done
  -> finalized

任何异常/abort -> terminal-error -> finalized
EOF 且没有 terminal-done -> terminal-error -> finalized
```

执行顺序：

1. 先创建零 usage 的 `AssistantMessage`。
2. 进入 `try` 后立即发送一次 `start`。认证、HTTP、body reader、parser、终态校验均在 `try` 内。
3. 收到 reasoning/text delta 时创建对应 Pi content block，依次发送 `*_start`、`*_delta`，在终态前发送 `*_end`。
4. 每次 usage event 更新 `input`、`output`、`cacheRead`、`cacheWrite`、`reasoning`、`totalTokens`，并调用 `calculateCost(model, usage)`。
5. 只有收到合法 `done` frame 才允许正常结束。`length`/`max_tokens` 映射 `length`；工具调用存在时映射 `toolUse`；明确已验证的 normal stop 映射 `stop`。未知 finish reason 应报协议错误，并保留经过脱敏的原始 reason 供诊断。
6. `catch` 根据 parent signal 是否 aborted 设置 `aborted` 或 `error`，填充安全错误文本，发送单一 `error` 事件并结束流。
7. `finally` 释放 reader lock、关闭 watchdog/timer，确保不会留下网络读取或 timer。

### 9.4 工具调用流规则

TRAE 的工具 arguments 可能分片，后续分片不再包含 id/name。实现必须按 `index` 维护 `ToolAccumulator`：

```ts
interface ToolAccumulator {
  index: number;
  id?: string;
  name?: string;
  rawArguments: string;
  contentIndex?: number;
}
```

规则：

- 先到 arguments、后到 id/name 时先缓存；获得 id/name 后再创建 Pi `toolCall` block，并补发此前缓存的 delta。
- 完成前必须验证 id、name、arguments 都存在。
- `rawArguments` 必须 `JSON.parse()` 成 plain object；数组、`null`、标量和非法 JSON 都报协议错误。
- 成功时将解析对象写入 Pi `ToolCall.arguments`，再发送 `toolcall_end`。
- 按 numeric `index` 排序结束，确保并行工具调用的稳定顺序。
- 禁止使用空 `{}` 作为解析失败 fallback。

## 10. 积分查询与命令设计

`/trae.usage` 仍是扩展命令，但认证获取方式改为：

```ts
const resolved = await ctx.modelRegistry.getProviderAuth("trae");
if (!resolved?.auth.apiKey) {
  throw new TraeAuthError("TRAE 未登录，请先运行 /login trae");
}
const text = await getTraeUsageText(client, resolved.auth, signal);
```

这保证命令与聊天共享同一份、必要时已被 Pi 自动刷新的 credential。不得再调用 `getSession()` 或读取磁盘。

格式化规则：

- `user_entitlement_pack_list` 缺失或不是数组时抛协议错误，不能显示总额 0。
- 空数组显示“未返回权益包，无法判定余额”，与真实零额度区分。
- 使用 `Intl.NumberFormat("zh-CN")` 格式化数字；不要依赖“Unicode code point 大于 0xff 就宽度为 2”的手工表格对齐算法。
- 有效期显示应使用明确时区。若产品语义为中国区权益，采用 `Asia/Shanghai`，避免 `toISOString()` 造成日期向前偏移。
- `req_source: 2` 和 `device_id` 保留为已验证的协议要求，并写入测试断言。

## 11. 实施阶段

实施模型应按阶段提交小而可验证的改动。私有协议验证失败时停在对应阶段，报告证据与阻塞项，不要通过猜测绕过。

### Phase 0: 固化基线与协议证据

- [ ] 在不包含任何真实 token/用户输入的前提下，制作正常 text、thinking、tool call、usage、done、error 的脱敏 SSE fixtures。
- [ ] 记录已确认的聊天 headers、usage headers、OAuth endpoints、tool call 字段及响应 finish reason。
- [ ] 以真实但最小的手工调用确认“当前模型思考控制”和“max output 控制”是否存在；没有确认前将其标记为待定。
- [ ] 记录当前行为基线：简单文本、多轮工具、积分查询、刷新后的调用。

### Phase 1: 工程与测试基线

- [ ] 将源文件迁至 `src/`，不改变外部 Provider ID、模型 ID、聊天 endpoint。
- [ ] 添加 `test/` 与 Node built-in test runner。
- [ ] 安装本扩展自身 dev dependencies，并提交 lockfile，使 `npm ci && npm run check` 可复现。
- [ ] `package.json` 的 `check` 改为 `npm run typecheck && npm test`。
- [ ] peer dependency 明确兼容窗口，例如 `>=0.84.2 <0.85.0`；升级 Pi minor 版本时重新跑兼容测试。

### Phase 2: 纯协议模块

- [ ] 先实现并测试 request serializer、header merger、SSE parser、wire event validator。
- [ ] 将所有 `any` 从请求转换和 SSE 解析路径移除。
- [ ] 使用 fixtures 验证多轮工具历史、分片 tool arguments、CRLF、多 data line 和 UTF-8 分片。
- [ ] 此阶段不连接真实网络。

### Phase 3: Stream adapter 与 client

- [ ] 实现可注入 fetch 的 `TraeClient`、HTTP 错误脱敏、response callback、abort/timeout 清理。
- [ ] 用 mock fetch 实现 stream state machine 测试。
- [ ] 确保所有分支都发出 `start` 后恰好一个 `done` 或 `error`，并最终 `end()`。
- [ ] 修复 usage 的 cache write 与 cost 计算。

### Phase 4: 原生 OAuth Provider

- [ ] 实现 `TraeCredential`、完整 `createProvider()` 和 `filterModels()`。
- [ ] 实现 callback server 的 ready/race/abort/close 行为。
- [ ] 完成 login、refresh、toAuth；refresh 必须保留所有扩展字段。
- [ ] 移除对 `auth.json` 和 `trae-state.json` 的生产代码访问，删除 `state.ts`。
- [ ] 实现旧 credential 的明确重新登录提示和文档迁移说明。

### Phase 5: 命令与文档

- [ ] 将 usage 命令改为 `ctx.modelRegistry.getProviderAuth("trae")`。
- [ ] 删除 README/维护手册中的 `/trae.logout`，改为 Pi 内建 `/logout`。
- [ ] 更新目录图、凭证说明、故障排查、升级检查清单和验证命令。
- [ ] 仅在有确认的 provider-specific context overflow 文案时，增加严格作用域的 `message_end` 规范化；没有证据不要添加宽泛正则。

### Phase 6: 验证与发布准备

- [ ] 执行完整离线测试和 `npm run check`。
- [ ] 使用临时 Pi 配置目录进行 extension load smoke test，避免污染真实 credential。
- [ ] 手工执行最小真实验收流程，不将敏感输出保存入仓库。
- [ ] 审查 diff，确认没有 token、用户输入、抓包原文或 `auth.json` 被提交。

## 12. 测试矩阵

### 12.1 纯函数测试

| 模块 | 必测场景 |
|---|---|
| credential/expiry | 秒、毫秒、duration fallback、已过期值、refresh 保留 device 字段 |
| headers | profile 合并、大小写冲突、`null` 删除、缺少必填身份 header、无敏感值出现在 error 中 |
| request serializer | system/user/assistant/tool/tool result、空 assistant、文本顺序、image 拒绝、多工具调用 |
| SSE parser | 单 chunk、多 chunk、UTF-8 跨 chunk、CRLF、多 `data:`、注释、EOF 未空行 |
| wire validator | 正常 output/usage/done/error、非法 JSON、错误字段类型、负 token、非法 tool index |
| usage formatter | 完整 packs、空数组、schema 缺失、负剩余、时区日期、金额精度 |

### 12.2 Stream adapter 测试

| 场景 | 期望 |
|---|---|
| 正常文本 | `start -> text_start -> delta* -> text_end -> done(stop)` |
| reasoning 后文本 | thinking 与 text block 生命周期完整且顺序正确 |
| 分片工具调用 | raw JSON 累积后产生正确 `ToolCall.arguments` |
| 多工具调用 | 按 index 稳定排序，均有 end |
| tool JSON 非法 | 单一 `error`，不发 `done`，不产生 `{}` 调用 |
| 服务器 error event | 单一 `error`，错误文本已脱敏 |
| HTTP 401/500 | `start` 后 `error`，status 可诊断 |
| 缺少 response body | `start` 后 `error` |
| EOF 无 done | `TraeStreamIncompleteError` -> `error` |
| parent signal abort | `aborted`，reader/timer 被清理 |
| token usage | input/output/cacheRead/cacheWrite/reasoning/total/cost 正确 |

### 12.3 Callback server 测试

- listener 在 `waitUntilReady()` 前不允许发布 auth URL。
- 非 `/authorize` 请求不完成登录。
- 合法 callback 只 resolve 一次。
- 手工粘贴成功会关闭 listener。
- browser callback 成功会 abort 手工输入。
- cancel、timeout、监听端口冲突和 exchange 失败都会关闭 listener。
- callback 的 JSON 参数不会因为二次 decode 被破坏。

### 12.4 手工集成验收

只由拥有账号的操作者手工执行，不在自动化测试中使用真实认证信息：

1. 新环境 `/login trae`，浏览器回调成功且重启 Pi 后仍能调用。
2. 简单文本请求有正确 streaming、usage 和 stop reason。
3. 至少一次完整工具循环：模型 tool call -> Pi 执行工具 -> tool result 回传 -> 模型继续回答。
4. 将 credential expiry 调至接近过期后验证 Pi 自动 refresh，确认 device headers 没有丢失。
5. `/trae.usage` 与 TRAE 客户端可见权益包总额一致。
6. `/logout` 选择 TRAE 后，模型不可用、usage 命令要求重新登录。

## 13. 验收标准

只有同时满足以下条件才可认为重构完成：

- [ ] `rg "auth.json|trae-state.json|readFileSync"` 在生产源码中无直接凭证读取逻辑。
- [ ] `state.ts` 已删除，且新登录不再创建 `trae-state.json`。
- [ ] 原生 `Provider` 通过 `pi.registerProvider(provider)` 注册，Pi 能负责 OAuth refresh 和内建 logout。
- [ ] 所有 stream 初始化错误、HTTP 错误、SSE 错误、EOF 缺终态、abort 都以标准 Pi `error` 事件收尾。
- [ ] 没有“缺 done 仍 stop”或“工具 JSON 错误变 `{}`”的路径。
- [ ] 传入的 `fetch`、headers、signal、response callback、timeout 被正确使用或明确记录未支持原因。
- [ ] tool-call 历史与多轮 tool-result 测试通过。
- [ ] text-only 模型不会伪装支持 image input。
- [ ] reasoning/max-token capability 的声明与真实请求映射一致；未验证则不暴露。
- [ ] `/trae.usage` 与聊天复用同一份 Pi resolved auth，空/坏响应不显示为 0。
- [ ] README、维护手册、代码注册命令三者一致，不再提及不存在的 `/trae.logout`。
- [ ] `npm ci && npm run check` 成功；离线 unit tests 不访问 TRAE 网络。
- [ ] git diff 中不存在 credential、完整 callback URL、真实用户内容或未经脱敏的抓包。

## 14. 发布、回滚与运维

### 发布说明必须包含

- `0.2.0` 将 OAuth credential 合并为单一 Pi credential，升级后需重新登录一次。
- 操作顺序：`/logout` -> 选择 `TRAE CN` -> `/login trae`。
- 确认新登录可用后，旧 `~/.pi/agent/trae-state.json` 可由用户自行删除。
- 该扩展仍依赖无文档私有协议；TRAE 客户端升级后需按维护手册的协议验证清单复测。

### 回滚边界

- 新版登录后的 credential 具有额外字段，旧版会忽略未知字段但仍依赖旧 state 文件；因此直接回滚不保证可用。
- 发布前应保留旧扩展目录的 git revision，而不是创建 archive tree。
- 若线上发现协议字段变更，优先禁用受影响 capability（例如 thinking）或明确报错，不能用宽松解析伪造成功。

## 15. 实现约束清单

实现者必须遵守以下约束：

1. 不要恢复 `auth.json` 的手工读写，也不要新增另一个 credential 文件。
2. 不要为了“兼容”吞掉 JSON、HTTP 或 SSE 解析错误。
3. 不要自动重发可能计费的 chat request。
4. 不要将真实 JWT/refresh token 放进测试 fixture、snapshot、错误或日志。
5. 不要凭命名推断私有 API 的 reasoning/max token 字段；缺少抓包/实测证据时停下来提问。
6. 不要为了小功能加入第三方 runtime dependency；Node 标准库、Pi API 和现有依赖足够完成本次重构。
7. 每完成一个阶段运行相关测试，不要等到最后一次性排错。

## 16. 实现前待确认项

以下问题会直接影响 model metadata，必须在 Phase 0 给出证据或采取保守行为：

1. `DeepSeek-V4-Flash-Official` 的实际思考控制请求字段、支持的等级和值，以及是否允许关闭思考。
2. 上游是否接受并执行请求级 output token 上限；若接受，字段名和取值范围是什么。
3. `done.finish_reason` 的完整枚举，特别是 tool use、length、content filter 或 server abort 的实际值。
4. tool result 出错时上游是否有结构化错误字段；没有时使用哪一种已验证的文本表示。
5. callback 中是否稳定回传 `login_trace_id` 或其他可用于关联本次登录的 nonce。
6. 权益包 `end_time` 的时区语义是否确为中国区本地时间。

这些项没有确认前，保守降级优先于“看似完整”的 UI 能力。
