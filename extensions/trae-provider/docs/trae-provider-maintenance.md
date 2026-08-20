# TRAE Provider for pi — 维护手册

> 目标读者：后续维护、升级、扩展此插件的开发者（即你自己）
> 关联：逆向学习笔记 `trae-reverse-engineering.md`（协议细节）、重构设计 `trae-provider-refactor-plan.md`（验收规格）
> 插件位置：`~/.pi/agent/extensions/trae-provider/`（本仓库是源码真相）

---

## 一、架构速览（0.2.0）

```
pi TUI
 ├─ /login trae      → Provider.auth.oauth.login: 本地回调服务器(18080) 自动捕获
 │                     → ExchangeToken → GetUserInfo → 单一 Pi credential 入库
 ├─ /model           → trae/DeepSeek-V4-Flash-Official (唯一模型)
 ├─ 对话              → streamSimple: llm_utils_chat 明文协议 + SSE 解析 + Pi 事件状态机
 ├─ /trae.usage      → 积分统计 (ide_user_ent_usage)，复用 Pi resolved auth
 ├─ /logout          → Pi 内建命令，选 TRAE CN 后删除完整 credential
 └─ token 自动刷新    → Pi 在锁内调用 auth.oauth.refresh: ExchangeToken 轮换，原子写回
```

**关键文件（0.2.0 起）**：

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口：`pi.registerProvider(createTraeProvider())` + `trae.usage` 命令 |
| `src/provider.ts` | 原生 Provider 组装（OAuth auth + `filterModels` + stream） |
| `src/model-catalog.ts` | 模型目录（`reasoning:true`，**无 thinkingLevelMap**，见 §3.3） |
| `src/auth/oauth.ts` | login / refresh / toAuth（ExchangeToken / GetUserInfo / 登录 URL） |
| `src/auth/callback-server.ts` | 回调服务器 ready/result/close 生命周期 |
| `src/auth/credential.ts` | `TraeCredential` 守卫、有效期归一化、迁移错误 |
| `src/client/trae-client.ts` | 统一 HTTP 出口（fetch 可注入、超时、onResponse） |
| `src/client/headers.ts` | header 三层合并（身份/profile/调用方）与必填校验 |
| `src/client/errors.ts` | 可辨别错误 + 错误文本脱敏 |
| `src/protocol/*` | 纯函数层：请求序列化 / SSE 解析 / wire 事件校验 / 类型 |
| `src/stream.ts` | SSE 事件 → Pi `AssistantMessageEventStream` 状态机 |
| `src/usage.ts` | 积分查询与格式化 |
| `test/` | Node built-in test runner（离线） |

**凭证分布（0.2.0 起，单一真相来源）**：
- `~/.pi/agent/auth.json` → `trae: {type:"oauth", access(JWT), refresh, expires, uid, machineId, deviceId, schemaVersion:1}`（**全部由 Pi CredentialStore 管理**）
- 扩展**不再读写** `trae-state.json`，也不直接读 `auth.json`。设备身份是 credential 的扩展字段，登录/刷新/登出一起原子更新。

**测试与检查**：
```bash
cd ~/.pi/agent/extensions/trae-provider
npm ci && npm run check   # typecheck + 离线单测（不访问 TRAE 网络）
```

---

## 二、日常使用

| 操作 | 命令 |
|---|---|
| 登录 | `/login trae`（浏览器手机号登录，自动回跳，无需复制链接） |
| 查看积分 | `/trae.usage` |
| 选模型 | `/model` → `trae/DeepSeek-V4-Flash-Official` |
| 登出 | `/logout` 后选择 `TRAE CN`（Pi 内建命令，不是扩展命令） |

**积分统计字段**：`ide_user_ent_usage` 返回权益包列表，`quota.credits_limit`=额度，`usage.credits_amount`=已用。**请求必须带 `device_id`**（body 和 X-Device-Id 头），否则 usage 为空。`req_source` 必须为 `2`。

**今日用量明细**：`query_user_usage_group_by_session`（POST api.trae.cn），body：`{start_time, end_time, page_size, page_num, usage_type:[7]}`。**关键参数**：分页字段是 `page_num`（不是 page）；**必须带 `usage_type:[7]`**，否则 total=0。返回 `user_usage_group_by_sessions[]`，含 `credits_float`（积分）、`cost_money_float`、`extra_info`（token）、`usage_time`、`user_input_preview`（用户输入）、`model_name`。该接口会记录 pi 里通过 llm_utils_chat 的用量。（当前版本未接入该明细接口。）

---

## 三、0.2.0 关键设计决策

### 3.1 单一凭证，破坏性迁移

0.1.x 把 token 放 Pi auth.json、设备字段放 `trae-state.json`。0.2.0 将 `uid/machineId/deviceId` 并入 OAuth credential 扩展字段。旧格式 credential 缺这些字段：

- `filterModels` 将其过滤为不可用（模型不显示）；
- 任何直接调用报明确中文错误：`TRAE Provider 已升级，请使用 /logout 选择 TRAE CN 后重新 /login trae。`

**升级操作顺序**：`/logout` → 选 `TRAE CN` → `/login trae`。确认新登录可用后，旧 `~/.pi/agent/trae-state.json` 可由用户自行删除（扩展不会再创建或读取它）。

### 3.2 登录流程

1. `crypto.randomBytes()` 生成新的 `machineId`/`deviceId`/`loginTraceId`。
2. `CallbackServer.waitUntilReady()` **成功后才发布 auth URL**；端口被占则回退手动粘贴并提示。
3. listener 只绑 `127.0.0.1`，只接受 `/authorize`；其他路径 404，不关闭 listener、不显示成功。
4. 浏览器回调 / 手动粘贴 / 全局 signal 三方竞争；任一先到则关闭 listener、取消另一方。
5. 回调参数 `userInfo`/`userJwt` 只解码一次；只有一次解码后不是合法 JSON 才尝试二次解码（受测 fallback）。
6. 若服务端回传 `login_trace_id`，必须与本次登录值一致，否则取消登录；不回传是已知协议限制。
7. `ExchangeToken` → `GetUserInfo` → 只有完整字段都校验通过才返回 credential。

### 3.3 未验证能力（保守降级，勿凭猜测上线）

| 能力 | 状态 | 处理 |
|---|---|---|
| 思考内容展示（`reasoning_content`） | ✅ 已验证（output 事件持续回传） | `reasoning: true`，thinking 块正常展示 |
| 思考**请求级控制**（thinking/max 字段） | ❌ 未验证 | **不声明 `thinkingLevelMap`，请求不发送任何 thinking 字段** |
| 输出长度**请求级控制**（max_tokens 字段） | ❌ 未验证 | 仅保留元数据上限，不发送 `max_tokens` |
| 图片输入 | ❌ 不支持 | text-only，明确报错；工具返回图片用确定性占位说明 |
| `done.finish_reason` 枚举 | 部分验证（`stop`；`length`/`max_tokens` 按映射处理） | 未知 reason 报协议错误，不伪造 stop |
| 权益包 `end_time` 时区 | 按中国区处理 | 显示用 `Asia/Shanghai` |

要补齐这些能力，必须先抓包/隔离实测确认「Pi level → 请求字段 → TRAE 真实行为」闭环（见 §四 检查清单第 7 条），并在 `src/model-catalog.ts` / `src/protocol/request.ts` 落证据。

---

## 四、故障排查手册

| 症状 | 原因 | 处理 |
|---|---|---|
| `/login trae` 报“自动回调捕获不可用” | 18080 端口被占 | 释放端口或等待提示后手动粘贴 |
| 浏览器“无法访问此网站 127.0.0.1” | **正常现象**（本地回调无服务），表示登录成功 | 自动捕获会接住；手动模式则复制地址栏 URL 粘贴 |
| 登录后 `/model` 无 trae 模型 | 未登录 或 **旧格式 credential** | `/logout` 选 TRAE CN 后重新 `/login trae` |
| 提示 “TRAE 未登录，请先 /login trae” | 无 credential | 重新登录 |
| 提示 “TRAE Provider 已升级…” | 0.1.x 旧 credential（缺设备字段） | 重新登录一次（见 §三.3.1） |
| JWT 过期（14 天） | refresh 为空时需手动重登 | 正常登录后 refresh 非空，Pi 自动刷新 |
| `4001 param invalid` | **模型 ID 大小写敏感** | 只能用 `DeepSeek-V4-Flash-Official`；小写不可用 |
| `/trae.usage` 显示已用积分为 0 | 请求缺 device_id | 0.2.0 从 resolved auth 的 X-Device-Id 提取；确认重新登录过 |
| 扩展改了不生效 | 扩展启动时加载 | `/reload` 或重启 pi |
| `pi --list-models` 无 trae | 未登录（oauth 未配置时模型不列出） | 登录后即有（不是 bug） |

---

## 五、TRAE 客户端升级后的失效检查清单

TRAE 是无文档私有协议，客户端升级可能破坏插件。**升级 TRAE 后按序验证**：

1. **登录**：`/login trae` 是否能走通（登录 URL 参数、ExchangeToken 端点、回调参数名可能变）
   - 关注：社区 `traework2api` 的 `login.sh` 是否更新；登录 URL 的 `login_version`/`plugin_version`
2. **对话**：发一条消息，看 `src/stream.ts` 是否正常（`llm_utils_chat` 路径、SSE 事件名 `output`/`reasoning_content`/`tool_calls`/`token_usage`/`done`）
3. **模型 ID**：`DeepSeek-V4-Flash-Official` 是否仍可用（4001 = 已变）；去 TRAE 客户端看新模型 ID
4. **积分**：`/trae.usage` 是否正常（`ide_user_ent_usage` 路径/参数）
5. **版本头**：`IDE_VERSION = "0.1.43"`、`IDE_VERSION_CODE = "20260716"` 是服务端可能校验的版本（社区项目用的值）。若被拒（401/4001），更新 `src/client/headers.ts`
6. **加密开关**：目前服务端接受明文（无 x-medusa）。若某天开始强制加密，需要重新评估（逆向笔记加密章节参考）
7. **未验证能力闸门**：思考控制 / 输出长度控制字段若有新证据，先按 §三.3.3 补证据再启用，禁止凭字段名猜测
8. **SSE 语义**：若事件改用默认 `message` 类型或分片方式变化，更新 `src/protocol/sse.ts` 与 fixture

**抓包方法**（复现逆向）：改 `ahanet/server.json` 禁用 `ttnet_quic_enabled`/`ttnet_http_dns_enabled` → 重启 TRAE → 系统代理指向 mitmproxy → 装根证书 → 即可解密。实验完恢复配置 + 删根证书（详见逆向笔记）。

---

## 六、踩坑记录（重要，避免重蹈）

1. **models.json 里给扩展 provider 加 `apiKey` 占位 → pi 永远显示 "API key configured"**，logout 无效。
   → 扩展注册的 provider 不要在 models.json 重复定义；models.json 只放无 oauth 的 provider。
2. **0.1.x 的 logout 只清 state 不清 auth.json → 登录状态残留**。
   → 0.2.0 已根治：凭证是单一 Pi credential，`/logout` 由 Pi 删除完整条目，扩展无独立登出逻辑。
3. **`registerCommand` 签名是 `(name, options)`，不是对象形式**。options = `{description, handler}`。
4. **`models.map` 容易漏传字段**（0.1.x 漏过 `thinkingLevelMap`）。
   → 0.2.0 用原生 `createProvider`，模型对象直接传，不再有 map 透传层。
5. **`llm_utils_chat` 模型 ID 大小写敏感**：`DeepSeek-V4-Flash-Official` ≠ `deepseek-v4-flash`。加模型必须实测确切 ID。
6. **`ide_user_ent_usage` 不带 device_id → usage 为空**。
7. **扩展相对 import 用 `.ts` 后缀**：tsconfig `allowImportingTsExtensions` + Node 24 原生 type stripping 可同时支持 tsc 与 `node --test`。**不要用 `enum`/命名空间/构造器参数属性**（strip-only 模式不支持）。
8. **`onPrompt` 可能返回空导致登录中断** → 循环重试 + 校验 `http://` 前缀。
9. **浏览器跳 127.0.0.1 显示拒绝访问 ≠ 失败**，是成功的标志。自动捕获靠本地 `CallbackServer(18080)`；端口被占会回退手动。
10. **QUIC/HTTPDNS 默认开启 → 标准抓包抓不到 LLM 明文**；必须先禁用。
11. **凭证分层**：access_key 是设备级长期凭证，JWT 是会话级。调试时区分“连接级/设备级/会话级”。
12. **x-medusa 加密“非必须”**：客户端加密但服务端接受明文——整个方案成立的关键。
13. **登录生成的 device/machine id 必须与后续请求一致** → 0.2.0 由 credential 扩展字段保证（单一来源）。
14. **`onAuth` 只能调用一次**，且在 `waitUntilReady` 之后（否则开两个登录页 / 服务器未就绪）。
15. **`ide_user_ent_usage` 的 `req_source` 参数影响权益包返回完整性**：必须 `2`，否则积分统计缺块。
16. **`extra_info.input_token` 已包含 `cache_read_token`**：input 是总数，cache 是命中部分，展示时勿并列重复。
17. **金额 = 接口 `cost_money_float` 字段**，`credits_float ÷ 40`（1 元 = 40 积分）是固定换算比例。
18. **llm_utils_chat 多轮工具调用回传格式（坑很深，实测验证）**：
   - assistant 工具调用必须放**顶层 `tool_calls`**：`[{id, type:"function", function_call:{name, arguments}}]`，**不能**放 content 块里。
   - toolResult 用 `{role:"tool", tool_call_id, content:[{type:"text",text}]}`，**content 必须是数组**。
   - **空 assistant 消息必须跳过**（TRAE 4001）。
   - **流式 tool_calls 的 arguments 是分片增量，必须拼接**：`rawArguments += arguments`，id/name 只在首片有。
   - **工具调用顺序按 numeric index 稳定排序**，最终消息块按 index 重排。
   - **arguments 非法 JSON / 缺 id/name 必须报协议错误**，不能回退 `{}`（0.1.x 曾回退空对象）。
19. **回调服务器：先 `waitUntilReady` 再发布 auth URL；`close()` 幂等，成功/失败/超时/取消都必须调用**。close 即使 listen 未完成也能正确回收（在 `close`/`error` 事件上 resolve）。
20. **SSE 解析必须按空行提交 record**（多 `data:` 行以 `\n` 拼接、CRLF、UTF-8 跨 chunk、EOF 冲刷），不能逐行发射 data。

---

## 七、扩展维护操作指南

### 加新模型
1. 从 TRAE 客户端/抓包确认确切模型 ID
2. 用逆向实测（`llm_utils_chat` 明文调用）确认 200 + 正常 SSE（4001 = ID 不对）
3. 在 `src/model-catalog.ts` 加条目（id 必须与实测一致）
4. 若新模型有已验证的思考/输出控制能力，先在 §三.3.3 的闸门确认再声明
5. `/reload` 验证

### 更新协议常量（客户端升级后）
1. 抓包最新请求，提取 `x-ide-version`/`x-ide-version-code`/`User-Agent` 等头
2. 更新 `src/client/headers.ts`（版本常量）与 `src/auth/oauth.ts`（登录参数）
3. 若端点/字段变化，同步 `src/protocol/*` 与 fixture

### 语法/加载验证（不启动 pi）
```bash
cd ~/.pi/agent/extensions/trae-provider
npm run check                                   # typecheck + 离线单测
pi auth check --provider trae                   # 应输出 not_ready（未登录时）
PI_CODING_AGENT_DIR=/tmp/x pi --list-models     # 临时配置目录冒烟，避免污染真实凭证
```

---

## 八、安全备忘

- `~/.mitmproxy/` 抓包数据含真实凭证（JWT/refreshToken），**用完即删，勿外传**
- 插件的 auth.json 含凭证，权限 0600（pi 已处理），勿提交到 git
- 错误文本不打印 JWT/refresh token/完整回调 URL/服务端 body；非 2xx body 最多读 4KiB 且先脱敏
- 违反 TRAE ToS，账号有封禁风险；个人自用自担
