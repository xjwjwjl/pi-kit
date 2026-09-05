# Codex Usage 设计

## 决策

将状态栏/用量查询与 reset-credit 消费拆成两个独立 Pi 包：

- `extensions/codex/usage/`：状态栏额度与 `/codex-usage` 用量报告；
- `extensions/codex/reset-credit/`：`/codex-reset-credit` reset-credit 查询与消费。
- 两个包都保持自包含，不引入仓库级 `shared/` 依赖。
- `codex-reset-credit` 消费成功后发出 `openai-codex:reset-credit-consumed` 事件，`codex-usage` 监听该事件并强制刷新状态栏。
- 不修改 `~/.pi/agent/settings.json`：该文件不属于仓库，由部署者分别注册需要的包。

## 必须保留的用户能力

1. 状态栏显示当前 `openai-codex` OAuth 账号的短周期额度；短周期不存在时回退长周期。
2. 状态栏在会话启动、5 分钟边界、凭据切换后更新；失败使用现有退避重试策略。
3. 多个 Pi 进程共享缓存和目录锁，后台额度刷新在一个刷新窗口内最多请求一次。
4. `/codex-usage` 显示账号、套餐、可用状态、真实额度窗口、重置时间和对应窗口内的 Pi session token/cost 统计。
5. `cpa-manager` 发出 `openai-codex:credential-changed` 后，状态栏切换到新账号的缓存并更新。
6. 监听独立 `codex-reset-credit` 包发出的 `openai-codex:reset-credit-consumed` 事件，消费成功后强制刷新状态栏额度。

## 关键行为：命令实时请求，随后显式更新状态栏

`/codex-usage` 不能复用 quota 缓存，也不能因为本 5 分钟窗口已有后台刷新而跳过网络请求。

每一次命令调用必须遵循下面的顺序：

```text
/codex-usage
  1. 从 Pi 凭据存储读取当前 OAuth 凭据
  2. 直接请求 wham/usage（强制实时请求，不读缓存）
  3. 以本次请求的 observedAt 计算窗口范围，扫描 session 并渲染报告
  4. 将本次请求的成功或失败结果显式提交给 QuotaController
  5. QuotaController 在同一把目录锁下持久化状态、更新退避状态、刷新状态栏
```

因此：

- 命令报告永远使用**本次命令请求的响应**，不使用缓存值，也不被后台刷新结果替换。
- 命令成功后，状态栏立即显示这次响应对应的额度，并清除该凭据已有的失败退避状态。
- 命令失败后，报告按现有失败路径显示 `UNAVAILABLE`；同时将失败提交给 QuotaController，使状态栏显示不可用并按既有规则安排退避重试。
- 命令的请求不参与“一个刷新窗口只请求一次”的后台去重规则。用户显式执行命令即明确要求一次实时请求。
- 命令不触发第二次 quota API 请求：它把自己已取得的结果交给 QuotaController。

## 并发与时间语义

### 两条刷新路径

| 路径 | 是否读取缓存 | 是否请求 API | 用途 |
|---|---:|---:|---|
| `QuotaController.refreshIfDue()` | 是 | 仅缓存不新鲜、重试到期或切换账号后需要时 | session 生命周期和 5 分钟边界后台刷新 |
| `/codex-usage` 命令 | 否 | 每次都请求 | 生成实时报告，并将结果推送给 QuotaController |

### 目录锁规则

两条路径必须复用同一把锁和同一套原子缓存写入逻辑。

- 后台路径在**获取锁后**重新读取磁盘缓存，再判定是否已在当前窗口成功刷新，避免多 Pi 进程重复请求。
- 命令路径不以缓存决定是否发请求；它可以在锁外完成实时请求，但提交结果时必须取得同一把锁，以安全合并缓存和退避状态。
- 缓存合并必须按 `lastAttemptAt` / `observedAt` 保留较新的结果。一个较早完成的命令不能覆盖已由另一进程写入的较新刷新结果。
- 只有结果所属凭据仍是当前凭据时，才允许更新当前会话的状态栏。
- `reset_after_seconds` 相对于请求观测时刻计算；命令报告必须使用命令的 `observedAt`，缓存展示使用对应缓存条目的观测时刻，不能使用渲染时的 `new Date()` 代替。

## 目标文件结构

```text
extensions/codex/usage/
  index.ts
  README.md
  DESIGN.md
  package.json
  package-lock.json
  tsconfig.json
  src/
    types.ts
    usage-api.ts
    quota-controller.ts
    quota-cache.ts
    file-lock.ts
    quota.ts
    quota-status.ts
    session-scanner.ts
    format.ts
  test/
    ...
```

### `index.ts`

入口应保持轻薄，只做装配：

1. 创建一个 `QuotaController` 实例。
2. 注册 `session_start`：启动控制器（先展示缓存，再调用后台 `refreshIfDue`）。
3. 注册 `model_select`：模型切换时刷新状态栏，仅当前供应商为 `openai-codex` 时展示额度。
4. 注册 `session_shutdown`：停止控制器、取消请求、清理定时器和状态栏。
5. 监听 `pi.events.on("openai-codex:credential-changed", ...)`：通知控制器展示新凭据缓存并进行按需刷新。
6. 监听 `pi.events.on("openai-codex:reset-credit-consumed", ...)`：消费成功后通知控制器强制刷新状态栏。
7. 注册 `/codex-usage`：执行实时请求、session 扫描、报告渲染，并调用 `controller.applyCommandResult(...)`。

`index.ts` 不应再包含 curl、缓存序列化、锁、重试或 session JSONL 解析细节。

### `src/types.ts`

统一定义两边现有的领域类型：

- `CodexCredential`：`access` 与可选 `expires`。
- `UsageWindow`：包含 `used_percent`、`limit_window_seconds`、`reset_at`、`reset_after_seconds`。
- `UsageResponse`：同时包含报告所需的 `email`、`plan_type`、`allowed`、`limit_reached` 和额度窗口。
- `UsageResult`：成功、token 过期、请求失败、取消等状态。
- `CacheEntry` / `PersistentCache`：观测时间、最后成功时间、最后尝试时间、过期/失败标记和重试状态。
- 现有报告及 session 扫描类型。

### `src/usage-api.ts`

唯一负责凭据和 API 请求：

- 使用 `readStoredCredential("openai-codex")`，不要直接读取 `auth.json`；这必须与 Pi 运行时凭据及 `cpa-manager` 的切换方式一致。
- 请求仍通过 `curl` 配置 stdin 传递 Bearer token，避免 token 出现在进程参数中，并保留代理环境兼容性。
- 保留 `--http1.1`、连接/总超时、`AbortSignal` 取消和子进程清理能力。
- 先检查 OAuth `expires`；过期时返回 `expired`，不发送网络请求。

### `src/quota-cache.ts` 与 `src/file-lock.ts`

从原 `codex-quota` 迁入并整理：

- 使用 token 的 SHA-256 哈希作为缓存键，绝不持久化 access token。
- 保存最近有限数量的凭据缓存，并采用临时文件 + 快照策略进行原子持久化。
- 新文件名固定为 `codex-usage-cache.json`；不加载、不复制、不删除任何 `codex-quota-cache.json` 文件。
- `file-lock.ts` 维持目录锁、陈旧锁回收、owner token 校验及可取消等待的行为。

### `src/quota.ts`

将窗口逻辑统一为通用术语，而不是固定“5h / 7d”：

- `selectQuotaWindows()` 返回最短的短周期窗口和最短的长周期窗口。
- 状态栏选择短周期优先、长周期回退。
- 报告使用实际 `limit_window_seconds` 格式化窗口名。
- 提供剩余百分比、重置时间和对应的 session 扫描时间范围计算。

保留现有阈值：状态栏剩余 `< 10%` 为 error，`<= 50%` 为 warning，其余为 success。

### `src/quota-status.ts`

只负责把 `UsageResult` 渲染成状态栏字符串，沿用：

- `Codex·5h 28%` 这类紧凑格式；
- token 过期、额度不可用等显示；
- `ctx.hasUI` 守卫和安全主题着色；状态栏仅在当前供应商为 `openai-codex` 时写入。

### `src/quota-controller.ts`

这是状态栏后台能力的唯一所有者，负责：

- 内存缓存和磁盘缓存读取；
- session 生命周期；
- 5 分钟边界定时器；
- 失败指数退避定时器；
- 后台 `refreshIfDue()`；
- `applyCommandResult()`；
- 当前 `ExtensionContext`、AbortController 与 `ctx.ui.setStatus()` 的安全调用。

建议对外只暴露小接口：

```ts
interface QuotaController {
  start(ctx: ExtensionContext): void;
  stop(ctx: ExtensionContext): void;
  handleCredentialChanged(): void;
  applyCommandResult(
    credential: CodexCredential,
    result: UsageResult,
    observedAt: Date,
  ): Promise<void>;
}
```

实现可补充私有方法，但 `/codex-usage` 不得绕过 `applyCommandResult()` 直接写 quota 缓存或状态栏。

### `src/session-scanner.ts` 与 `src/format.ts`

保留现有的可靠能力：

- 递归扫描 session JSONL；
- 按 entry id 去重 fork 内容；
- 统计跳过文件、坏行和去重条目；
- 兼容已存在的 usage 字段变体；
- 按模型汇总 token/cost；
- 报告显示真实窗口长度，而非硬编码 5h/7d。

只有 `/codex-usage` 执行 session 扫描；后台状态栏刷新绝不能扫描 session 文件。

## 包边界与配置

1. `extensions/codex/usage/` 只负责状态栏额度和 `/codex-usage` 报告。
2. `extensions/codex/reset-credit/` 独立负责 `/codex-reset-credit` reset-credit 查询与消费。
3. 两个包分别声明自己的 `package.json`、`tsconfig.json`、依赖和测试；不得通过相对路径导入对方源码。
4. `codex-reset-credit` 通过 `pi.events.emit("openai-codex:reset-credit-consumed")` 通知 `codex-usage` 刷新状态栏。
5. 不编辑 `~/.pi/agent/settings.json`；部署者按需分别注册两个包。

## 测试与验收

在 `extensions/codex/usage/` 中执行：

```bash
npm run check
```

除现有 quota 与 session-scanner 测试外，必须覆盖以下场景：

1. **命令不读缓存**：即使当前 token 在缓存中有新鲜结果，执行 `/codex-usage` 仍发起一次 API 请求。
2. **命令更新状态栏**：命令成功后，状态栏立刻显示本次返回的额度，而不是旧缓存。
3. **命令不二次请求**：命令提交结果给 QuotaController 后，不会为更新状态栏再次请求 API。
4. **命令失败同步 quota 状态**：命令请求失败后，报告为 unavailable，状态栏为 unavailable，并正确安排退避。
5. **命令成功清除退避**：已有失败重试状态时，命令成功会重置 retryCount/nextRetryAt。
6. **后台去重保持有效**：两个 Pi 进程在同一 5 分钟窗口执行后台刷新，只有一次 API 请求。
7. **命令与后台并发写入安全**：不会生成临时残留文件，不会丢失较新的缓存条目，也不会让旧结果覆盖新结果。
8. **凭据切换**：`openai-codex:credential-changed` 后使用新 token 对应缓存并按需刷新。
9. **取消与退出**：session shutdown 会取消进行中的后台 curl，清理刷新和退避定时器。
10. **旧缓存不参与**：存在 `codex-quota-cache.json` 时，新控制器不读取它，也不写入它。
11. **报告正确性**：命令报告中的窗口范围以本次请求 `observedAt` 推算；扫描只发生在命令路径。
12. **跨包刷新**：收到 `openai-codex:reset-credit-consumed` 后，状态栏发起一次强制额度刷新。

## 实施顺序

1. 在 `codex-usage` 保持状态栏与用量报告能力，并监听 `openai-codex:reset-credit-consumed`。
2. 在独立 `codex-reset-credit` 包中实现 reset-credit API、确认流程和命令测试。
3. 分别运行两个包的 `npm run check`。
4. 按需将两个包分别注册到 Pi 的全局或项目设置中。