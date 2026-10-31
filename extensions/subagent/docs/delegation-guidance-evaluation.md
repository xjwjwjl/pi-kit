# 委派提示词评测

这是 `subagent` 包内的独立 CLI，不是 Pi 扩展、自动路由器或通用评测平台。观察真实父模型如何选择 `agent`；trajectory 案例还会在 stub 子结果后继续一段轨迹。不执行真实子代理，不评价最终任务质量，也没有独立 LLM judge。

状态：脚本及离线回归已实现；当前脚本尚未运行真实模型对照。早期临时原型的真实试跑受 Bash mock 与截断影响，不能作为当前工具环境的通过记录。真实子代理端到端验收不在本脚本范围内。

## 1. 使用

在 `extensions/subagent` 内运行。命令使用原生 TypeScript stripping 和 `--use-env-proxy`，已在 Node 24.18 验证；不安装新依赖。

```bash
# 默认 dry-run：验证输入并生成计划，不初始化模型 runtime、不读认证/模型配置
npm run eval:guidance -- --model provider/modelId --case G02 --repeat 2

npm run eval:guidance -- --help
```

Dry-run 中的模型名只是计划标识，不代表已经验证其存在或认证有效。省略 `--model` 时仍可验证案例和提示词，但模型配对计划为空。

只有显式指定 `--live`、模型与总请求预算才调用真实父模型。以下是按本机配置选择模型的示例，不会自动切换供应商或型号：

```bash
npm run eval:guidance -- --model gogate/deepseek-v4-flash-vision-exp --case G02 --repeat 2 --max-case-requests 8 --max-requests 32 --live
```

可重复 `--model` 和 `--case`。默认案例为 G01/G02/G07/G08/G09、重复 1 次、单 case 最多 8 次请求、请求超时 60 秒、case 超时 180 秒、thinking 为 `low`、请求的输出上限 8192。`--help` 列出所有参数。

- 每个模型/案例运行 baseline 与 candidate；第二次重复反转顺序，降低固定顺序影响。
- 同供应商串行，最多两个供应商并行。每个 case 使用独立内存会话。
- 请求数是 SDK 模型启动尝试，不是完整任务数；初始化/认证失败可能尚未到达服务端。
- 默认输出到系统临时目录；`--output PATH` 指定父目录，每次创建唯一新子目录，不覆盖旧记录。
- `--agent-dir PATH` 选择本地配置来源；默认使用 Pi agent 目录，遵循 `PI_CODING_AGENT_DIR`。
- 命令继承已有 HTTP(S) proxy 环境变量，不修改系统网络设置、全局配置、凭据或依赖。

## 2. 版本化输入与工具环境

- [baseline.json](../scripts/eval-guidance/baseline.json)：历史触发策略，仅保存描述与 Guidelines，不依赖临时目录的旧源码副本。
- candidate：从当前 `index.ts` 实际注册定义读取；两版使用同一参数 schema。可用 Agent 类型统一为默认通用类型，避免个人 roster 差异。当前 candidate 鼓励对可分离、非平凡工作尽早主动委派，优先考虑能减少父端大量独立探索或验证工作的任务；工具调用轮数本身不是委派标准。它也支持独立问题同批并行、尊重用户显式禁止委派，并保留快速查找、小修、紧耦合工作直接完成，以及实施委派的清晰写入范围和并行/上下文收益门槛。与历史 baseline 对照的仍是整套提示词元数据（含权限和共享状态等修订），不能把差异单独归因于某一条触发句；离线契约检查不证明实际触发率或提速效果。
- [fixture.json](../scripts/eval-guidance/fixture.json)：18 个合成项目文件及 G01/G02/G07/G08/G09。可用 `--fixture` 指定同结构 JSON，`--baseline` 指定基线 JSON；只读数据，不执行输入文件中的代码。

夹具格式：

```json
{
  "name": "example-v1",
  "cases": [{ "id": "overview", "prompt": "概括 README，不修改文件。", "expected": "direct" }],
  "files": { "README.md": ["# Example", "Project introduction."] }
}
```

`expected` 为 `direct` 或 `delegate`，只是案例作者设定的路由目标，不是任务质量金标准。文件名为相对路径，内容为字符串行数组；路径遍历、非法路径、规范化冲突及文件/目录冲突会被拒绝。

模型只得到四个工具：

- `read` / `ls`：精确读取构造时复制的内存项目，不访问宿主文件。复用 SDK 参数 schema，但执行与描述明确是受限纯文本语义，不宣称完整原生 read；offset/limit 必须是正安全整数，正文有 2000 行/50 KiB 上限。
- `codemode`：真实 QuickJS 沙箱，仅可调用上述工具和 `agent`；非 LLM 模型能力关闭。
- `agent`：记录调用与交接参数。decision 案例在首次调用后停止；trajectory 案例返回一个 stub 子结果并继续到单 case 请求预算，用于观察多次调用、交接参数和委派后的读取。两种模式都不创建子会话、不验证子任务实际授权或产出。调用不等于真实执行成功。

不提供 Bash、写工具、MCP、宿主文件或业务网络接口；不使用正则猜测任意 Shell 的输出。公共 SDK 文档提示替换为受限项目说明，仍由 SDK 组装工具 Guidelines；此环境不是日常完整 Pi 提示词/工具集的重放，也不构成操作系统沙箱。

## 3. 案例范围

| ID | 场景 | 脚本覆盖与路由目标 |
| --- | --- | --- |
| G01 | 快速概括目录、入口与检查命令，不深挖 | 内置；direct |
| G02 | 深入三个独立模块，提供调用链与源码证据，再综合比较 | 内置；delegate，不要求每模块恰好一次调用 |
| G07 | G02 加上用户明确禁止委派 | 内置；direct，尊重用户限制 |
| G08 | 单问题、两个紧邻文件的只读核对 | 内置；direct，过度委派哨兵 |
| G09 | G02 的 trajectory 版本，子代理返回后核对源码 | 内置；delegate，记录多次调用与委派后读取 |
| G03 | 已定位小函数修复及针对性验证 | 待独立实施环境验证；通常直接做，不为并行硬拆 |
| G04 | 实施后独立于实施者的权限/凭据风险复核 | 待端到端验证；定向只读复核，不把复核授权解释为修复授权 |
| G05 | 两项功能共享接口、依赖或测试产物 | 待可写协作环境验证；不得重叠并行写入，不以调用次数判定 |
| G06 | 普通改动后的例行检查与自查 | 待对应工具环境验证；不机械追加 reviewer，也不省略验收 |

G02 不用“请调用 agent”等工具选择提示。G08 是过度委派哨兵：任务规模中等，但问题单一、文件紧邻，默认应直接完成。G09 复用 G02 的意图但启用 trajectory，用于观察调用粒度、交接参数和委派后读取；它不是额外的路由金标准。未来扩充应加入同意图改写，防止只测关键词；不要用空目录充当深入调查夹具。当前 `--case` 只接受所选 fixture 中存在的 ID。

## 4. 记录和判定

一次 live run 生成：

- `manifest.json`、`fixture.json`：完整提示词变体、公共 schema、计划、SDK/执行器/夹具哈希及限制；dry-run 只生成这两类输入记录。
- `selected-models.json`：实际型号、API、thinking 映射、安全采样参数、目录费率及配置哈希，不复制认证文件。
- `requests.jsonl`：预算内的模型启动尝试。
- `cases/*.json`：公开模型响应、实际 mock agent 入口（含 codemode 嵌套调用）、参数、访问记录、usage 和停止原因；不保存 thinking 正文或请求认证。
- `summary.json` / `report.md`：规则统计与逐项结果，包括 agent 调用次数与委派后读取；初始化异常另有 `failure.json`。

结果分三层：

1. **观察**：`delegated`、`direct_stop`、`unresolved`；`direct_stop` 只是模型结束，不证明正确完整地完成任务。
2. **有效性**：观察点完成、模型结束、预算/时间耗尽、取消、输出截断、服务失败、环境异常、未运行。trajectory 若已观察到 agent 调用，`request_budget` 仍用于判定委派路由；未完成的只是后续轨迹指标。
3. **路由匹配**：只有有效观察点或正常结束才比较 `expected`；其他情况为 `null` / inconclusive，不当作零调用失败。

不把字面“我将委派”当调用；在实际 agent mock 入口记录，直接与嵌套调用均可观察。交接质量仍需另行复核，规则计数不是语义评分。

观察字段包括 `agentCallCount`、`agentInvocations`、`postDelegationAccesses` 与 `duplicatePostDelegationAccesses`：后两者是委派后 read/ls 的次数，以及其中与委派前相同 tool 与规范化 fixture 路径的重复读取。它们是描述性指标，不是任务质量或“是否该验证”的判定；交接参数质量仍需人工复核 case JSON。

退出码：`0` 为 dry-run/help 或所有已观察路由匹配；`1` 为存在路由不匹配；`2` 为异常或存在不可判定/未运行案例。遇服务/认证/环境失败，停止该供应商剩余案例，不重试、不自动换模型。达到总预算后不启动后续请求。

## 5. 安全与验证边界

- Live 只读使用指定模型的配置和凭据，禁止执行命令型 key/header/env 配置；拒绝刷新/修改回调，过期认证需另行处理，不自动登录或更新文件。
- 额外 sampling 只允许有限数值统计参数；不能覆盖模型、工具、storage、输出上限、输入或 reasoning。最终 adapter payload 再检查型号、四个本地工具与 storage/background 边界，防止目录配置绕过控制。
- SDK 缓存刷新网络关闭，API 重试关闭，强制 SSE，后台 cache warming/自动压缩关闭。不运行其他模型工具或真实子代理。
- 请求与 case 超时是合作取消，不是强杀保证；Codex 等 adapter 可能不执行输出 token 上限。请求预算不是金额硬上限，目录 cost=0 或失败 usage=0 也不能解释为免费。
- 已知认证秘密与 Bearer token 脱敏后再 JSON 转义，但日志仍可能包含用户提供的夹具/公开响应，应按本地会话数据管理。
- 不将小样本当普遍成功率，不跨型号/SDK/工具环境直接比较。若提示词、协议或工具环境变化，应重新配对，而非只追加有利样本。Trajectory 使用固定 stub 子结果，不能代表真实子代理产出；`duplicatePostDelegationAccesses` 只是路径级启发式，不能区分必要复核与重复劳动。
- 只读、权限与并发条款是模型行为指导，不新增生产沙箱、资源锁或授权模式。此脚本不运行真实子代理，不能用路由结果验收子代理强制只读、继承上下文安全性或工作区隔离；对应离线测试仅验证序列化结构、提示词契约及既有工具级约束。

默认 `npm run check` 保持离线。测试包括虚拟路径/内容精确性、无宿主 fs 探测、SDK 假流与真实 codemode、预算/超时/取消、服务失败、认证写入拒绝、采样/最终 payload 边界及脱敏。API adapter 检查在发送前主动停止，或使用假流，不产生真实模型请求。
