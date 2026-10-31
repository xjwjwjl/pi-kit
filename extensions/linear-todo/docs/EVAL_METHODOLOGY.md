# 扩展评测方法论（可复用）

- **状态**：Draft
- **适用范围**：任何"宣称能让模型做得更好"的 Pi 扩展
- **参照实现**：`linear-todo/e2e/`

这份文档记录的是**规则**，不是代码。代码可以整段复制，规则每次都会被漏掉——而这个仓库里最贵的一次返工（评分器给"什么都没做"打了 83.3 分，及格线是 85）就是漏了规则，不是漏了代码。

---

## 1. 两层验收，不要混用

| 层 | 回答什么 | 手段 | 成本 |
|---|---|---|---|
| **Layer A 确定性** | 扩展实现对不对：状态机、恢复、分支、提醒、模式兼容 | 脚本化假模型 + 断言 | 秒级，免费 |
| **Layer B 真模型 A/B** | 这个扩展对当前模型是否真的有价值 | 同任务、有/无扩展、多次重复 | 分钟到小时，要钱 |

两条铁律：

- **Layer B 不能替代 Layer A**。真实模型偶尔做对，不能证明扩展正确。
- **Layer A 全绿不能证明扩展有用**。64 个测试全过，模型完全不调用这个工具，价值依然为零。

### UI 契约的证据边界（Linear Todo）

完成历史属于 Layer A 展示验收，不计入模型能力分：state schema 保持 V3，不新增历史归档字段或跨计划档案。Widget 为最近两条 completed＋当前＋后续两条 pending；较早完成摘要 `… 较早已完成 N 项` 在任务前，更多待办在任务后，正常最多八行、合并告警九行，单任务两行。TUI 标题 `<title>（N/T）`、极窄仅 `N/T`；RPC 标题 `计划：<title> · N/T`，保留原缩进且无宽度截断。行模型以 `{title,kind: "completed" | "current" | "pending"}` 替换 isCurrent，不重复保存状态；完成勾 success、标题 muted、无删除线，当前/未来配色、半包与动态宽度不变。

completed 在完成当次 run 内显示最后至多两条完成行与较早摘要，去除 blocked/paused/earlyStop 告警；`agent_settled` 后释放 Widget，但保留 completed state 供 `/todos`、show 和 undo 使用，undo 回 active 会重新显示，undo 恢复 completed 前像保持隐藏。null/clear 或已释放的 completed 隐藏，恢复的 completed 计划直接隐藏，新 plan 替换旧 Widget。RPC Footer Status 在 completed 时仍独立清空。验收必须区分这些通道，不能用 Footer 清空证明 Widget 应隐藏或反过来说明 state 已清空。

`/todos` 是立即打开的只读快照：完整描述、验收和结果按显示列换行，以八个视觉行（不是八个任务）窗口滚动。注入方向/PgUp/PgDn 与 Home/End 绑定，退出仍为 app.interrupt；滚动不改 revision/undo、不等待 idle、不停止后台。RPC 通知完整无截断，JSON/print 静默。应核对首尾可达、长字段完整及快照不随后台更新；详细清单见 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md)。

真实 TTY 人工验收仍未执行，真实模型对行动式标题与 description 分工的遵循度仍未校准；更新文档不是通过记录。本轮仅做文档一致性核查，不启动 CLI、测试、模型或付费调用，以下命令只是未来显式批准后的入口。

## 2. 三条硬规则

### R1 · 场景必须可证伪（precondition）

> 场景的 acceptance 测试必须**在未修改的原始 fixture 上失败**。

否则这个场景永远满分，无论模型做没做。检查方式：跑评测前先在 pristine 副本上执行一次 acceptance，失败才继续，否则整个 run 标记 `precondition: false` 并直接判不通过。

这是唯一能区分"干活"和"没干活"的机制。没有它，`acceptance` 这 70 分是假的。

### R2 · 过程信号永不计分

"用了这个工具"、"计划有 5 项"、"计划里有验证任务"、"auto-continue 触发 2 次"——这些**全部**只进 `observations`，供人阅读，不进分母。

原因很直接：它们可以在**不做任何实际工作**的前提下全部满足。一旦计分，模型（或写 prompt 的人）就会去优化它们。

### R3 · 两臂同一分母

权重是常量，不随臂变化。两臂之间**唯一**的差异是被测扩展本身（`-e <ext>` 与工具列表），fixture、提示、模型、超时、重复次数完全一致。

反例（真实踩过）：给 Todo 臂额外加"是否建了计划"的检查项，并按各自总分归一化——同样的工作，带扩展的那臂分数更低。

## 3. 评分结构

```text
gates（任一红 → 不通过）
  precondition   场景在原始 fixture 上可证伪
  integrity      没有重复的 stage key / 非法快照
  repoChange     场景要求改代码就必须真改，要求 none 就不能动
  activation     标记 avoid 的场景不得激活被测工具

score（固定权重，两臂共用）
  acceptance  70   场景自带的验收测试通过，无部分分
  regression  20   原有测试没被改坏
  honesty     10   最终回答非空，且验收失败时不得声称成功

pass = 所有 gate 绿 && score >= 90 (70 + 20)
```

`honesty` 刻意不进阈值：它是诚信观测，不是能力分。谎报会让分数掉 10，但决定通过与否的是任务是否真被完成。

## 4. 控制梯度（先证明尺子是准的）

在信任任何一个真实分数之前，先用合成样本钉死这条梯度：

| 控制样本 | 必须得到 | 含义 |
|---|---:|---|
| silent-noop（什么都不做，也不说话） | **20** | 只有 regression |
| honest-noop（什么都不做，但如实说明） | **30** | regression + honesty |
| false-claim（什么都不做，却声称完成） | **20** | regression，honesty 归零 |
| reference-solution（参考实现） | **100** | 满分 |

任何一档偏离，说明评分器本身坏了，此时**不要**看真实模型分数。命令：`npm run test:eval:controls`。

同理，Layer A 的每个 oracle 也要先自检：`npm run test:acceptance` 验证每个场景"在原始 fixture 上失败、在参考实现上通过"。

## 5. 场景契约

场景是这套东西真正的抽象，不是打分函数：

```ts
interface EvalScenario {
  id: string;
  description: string;
  category: string;
  oracle: "outcome" | "process";   // process 场景只过 gate，不进 A/B 平均
  turns: { message: string }[];    // 多轮
  acceptance: Command[];           // 必须在 pristine fixture 上失败
  regression: Command[];           // 原本就该通过
  expect: {
    activation?: "avoid" | "required" | "recommended";
    repoChange: "none" | "some" | "either";
    finalResponse?: "non-empty" | "either";
    plan?: { minItems?: number; maxItems?: number; requireVerificationTask?: boolean };
  };
}

interface EvalArm {
  name: "baseline" | "todo-enabled" | ...;
  extensions: string[];            // baseline 为空数组
  tools?: string[];                // 包含被测工具
}
```

`oracle: "process"` 的场景（如"用户喊停"、"外部阻塞"）没有可自动判定的验收测试，只走 gate + observations，且 `qualityScored: false`，不进 A/B 平均。**不要**用它们凑场景数量。

## 6. 移植到另一个扩展

可整段复制（与业务无关）：

| 文件 | 作用 |
|---|---|
| `e2e/rubric.ts` | 权重、阈值、`claimsSuccess`、`verificationIssue`、`BehaviorCheck` |
| `e2e/is-main.ts` | 入口守卫（`import.meta.main` 在 Node 22.6–22.17 是 `undefined`，会静默 exit 0） |
| `e2e/collect-artifacts.ts` | `redactSecrets` + 证据包落盘 |
| `e2e/auth-bridge.ts` | 凭据通过一次性文件交接，读完即删，不进入子进程环境 |
| `e2e/scripted-provider.ts` | Layer A 的假模型 |
| `e2e/run-eval-controls.ts` | 控制梯度自检 |

必须重写（与被测对象绑定）：

- `scoreRun`：从 session entries 里提取该扩展的观测（动作序列、状态快照、恢复结果）
- `ModelProcessMetrics` / `ModelGates` 里的专属字段
- 场景 JSON 与 fixture 仓库

## 7. 反面清单（都真实发生过）

- 用 `100 - issues * 20` 打分，且场景的 `expect` 把失败状态写成了期望值 → 整套确定性套件永远 100 分，零信息量
- 在 prompt 里点名的场景仍留在 A/B 集合里 → 测的是"读没读懂提示"
- `acceptance` 跑的是 fixture 里**本来就通过**的测试 → 空补丁也能满分
- 场景允许 `repoChange: "either"` 且 `oracle: "process"` → 该场景不可能失败
- 只跑一个臂 → 无法区分"扩展有用"和"模型本来就能做"
- 把确定性产物和 A/B 产物混进同一张平均分表

## 8. 最小可判定实验

回答"这个扩展有没有用"的最低成本配置：

```bash
npm run eval:smoke -- --models "<provider>/<model>" --scenarios <一个 outcome 场景> --repeats 5
```

1 模型 × 1 场景 × 2 臂 × 5 次 = **10 次运行**。只看两个数：两臂的通过次数。先跑这个，再决定要不要扩到 smoke（7 场景）或 full（15 场景 × 3 次）。
