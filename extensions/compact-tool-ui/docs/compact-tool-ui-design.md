# Compact Tool UI 展示规范

本文描述当前本地实现的展示行为和关键边界，不保留已替代的 tool override / 原始 renderer 布局方案或施工阶段表。用法、设置面板按键与 JSON 示例见 [README](../README.md)。目标宿主与开发依赖为 **Pi 1.3.0**。

## 1. 范围与不可改变的语义

当前只定制 `bash` / `read` / `write` / `edit` 与顶层内置 `codemode`：

- 五个工具均在扩展加载阶段通过 `pi.registerToolRenderer()` 接入。不构造或注册同名 tool definition，不调用 `pi.registerTool()`，不包装 `execute`，不重新注册或启用工具。
- 保留工具 schema、description、exposure / loadout、默认激活集合、宿主 `shellPath` / `shellCommandPrefix`、图片缩放设置和其他扩展的执行定义。
- 不改变返回给模型的 content / details、LLM context、会话存储结构、Codemode sandbox / store，或默认快捷键；所有摘要、清理与换行仅作用于显示副本。
- 不与 access-control、sandbox、remote execution/filesystem、audit 类扩展争抢执行。未匹配的工具继续交给 resolver 链；其他扩展也定制同名 renderer 时遵循 Pi 的链顺序。
- 设置命令只在 `ctx.mode === "tui"` 时打开 `ctx.ui.custom()`。print / JSON / RPC 等模式不打开终端自定义组件，也不因本扩展改变执行结果。
- 不保证补回工具已截断的内容。原始 image content 由宿主按 `showImages`、终端能力及图片设置展示，轨道只放摘要，不复制图片数据。

独立 `grep` / `find` / `ls` renderer 不在当前范围；Bash 中这些命令的语义摘要不是同名工具支持。

## 2. 通用信息结构

### 折叠态

以单行 header 表达操作对象和关键结果，不做右对齐，不额外加状态符号。状态通过 metadata、错误类别和主题色表达。`read` / `write` 没有小文件直出例外；Bash 的 pending / running / success / failure 均不显示正文预览；只有 Edit 的小 diff 可额外内联。

```text
read src/index.ts
write src/generated.ts · 214L · 6.8 KB
edit src/config.ts · +12 -4
bash pnpm test · test failed · exit 1 · 4.2s
codemode read ×2 · bash ×1 · done · 1 failed
```

- 命令摘要与文件路径使用约 64 字符的行内预算和中间省略。命令尽量保留命令名与尾部参数；路径先缩短 home，再尽量保留头部目录与末尾文件名，邻近 `/` 或 `\` 时吸附边界，无合适边界则普通中间裁剪。
- 这只是摘要预算，不代替终端可见列测宽。窄行通过 `CompactToolRow` / `ExpandedToolHeader` 的宽度策略保留目标和关键状态，必要时降级 metadata。
- 文件工具路径用 muted 目录与加粗的 `mdLink` 文件名，范围数字用 `syntaxNumber`；错误用 error，diff stat 用 added / removed 语义色。OSC 8 链接指向未省略的真实路径：按原生文件工具规则处理 `@`、`~`、Unicode 空格及 file URL，相对路径基于当前 renderer context 的 cwd，缺失时使用注册时 cwd；不把显示摘要当链接目标。
- 行数摘要使用 `NL`（例如 `50L`）。Bash 耗时位于 metadata 最后，低于 1s 不显示；Codemode 父行同样隐藏亚秒耗时，子调用可以显示毫秒。
- `read` / `write` / `edit` 失败只保留一行 compact reason，例如 `path not found`、`permission denied`、`oldText not found`，不另加 hint 行。完整错误靠展开。

### 展开态：shared detail rail

五个工具都使用共享 header、命名 section 和低对比左侧轨道，不直接嵌入原生 renderer 的 Box / padding：

```text
Bash pnpm test · test failed · exit 1 · 4.2s
  ├─ command
  │ pnpm test
  ├─ output · 38 lines
  │ FAIL src/foo.test.ts
  │ Expected: 1
  │ Received: 2
  ╰─ Ctrl+O collapse
```

- header 只表达一次 outcome、耗时或 diff stat；section 使用 `command` / `content` / `output` / `diff` / `error` 等小写短词，正文置于 `│` guide 后。
- footer 用 `╰─` 收束，只放截断、continuation、完整输出路径和收起等操作信息，不重复结果摘要。快捷键通过 `keyHint("app.tools.expand", "collapse")` 生成，不能硬编码实际键位。
- 默认无背景、不叠加卡片；不重复增加顶部 spacer。宿主仍提供 tool 间留白，扩展无法通过去掉 Box 完全消除该空行。
- 展开显示完整**当前可用**内容；仅运行中 Bash 为有界 tail。正文进行 ANSI-safe 视觉换行，不能沿用 collapsed 的中间省略丢弃行尾。

## 3. 各工具展示

### Bash

**折叠命令**使用轻量扫描生成一行摘要，不引入外部 shell parser：

- 短单行保留命令文本；可识别的简单 `rg` / `grep` / `find` / `ls` 用语义 label；长行中间省略。
- 多行 / heredoc 压缩为 `shell script`、`python3 heredoc` 等，并附原命令行数、大小；不在 header 铺开脚本。
- running 显示 `running` 或 `NL so far` 与可用耗时。stream 的行数是当前输出逻辑行数，不套用成功摘要的非空行过滤。
- 参数提供 `timeout` 时，仅 pending / running metadata 显示 `timeout Ns`；settled 后移除，真实 timeout / aborted 由失败结果表达。

**成功输出摘要**始终开启，且只进入 header：

| 可识别输出 | 摘要 |
| --- | --- |
| 普通输出 1–2 个非空内容行 | 首行单行化，最多 160 字符；两行时加 `1 more line` |
| 普通输出 ≥ 3 个非空内容行 | `NL`，空行不计 |
| `rg` / `grep` | `N matches`，可推断时附 `M files`；context 查询为 `N search lines`，文件列表模式为 `N files` |
| `find` / `rg --files` | `N paths`；可识别的 `find … \| wc -l` 为 `N files` |
| 纯 `ls` | `N entries`，忽略 `total` 行 |
| 对应命令的空输出 | `no matches` / `no paths` / `empty`；`git diff` 为 `no changes`，short / porcelain status 为 `clean` |

不适用语义摘要的空输出保持静默。Shell 混合链和一般 pipeline 保守降级为普通输出摘要，不把 `ls && …` 等当纯目录列表；这些计数是对已有输出的启发式解释，不是额外查询。成功结果的 `details.truncation.truncated` 会追加 `truncated`，即使没有其他输出摘要也可见。

**失败**只在 header 显示分类、退出码和可用耗时，例如 `tsc errors · exit 2`、`test failed · exit 1`、`command not found`、`timeout Ns`、`aborted`；不展示 collapsed tail。

**展开命令与输出**：

- `command` 展示调用参数原文的显示副本：清理 ANSI / 不安全控制序列，将 Tab 展开为 3 个空格，再按宽度视觉换行。保留字符顺序、引号、escape 和物理换行，不做 unquote、重新引用、路径规范化或语义重排。
- 不拆分 `;`、`&&`、`||`、`|`、`|&`，不插入 continuation 字符，不重排 heredoc。轻量 collapsed 摘要扫描不用于 expanded command。
- 运行中输出先取最后 **28 个逻辑行**，ANSI-safe 换行后再取最后 **28 个视觉行**。section metadata 按逻辑行标 `tail X/Y lines · streaming`，未裁逻辑行时标 `X lines · streaming`；无输出时 footer 标 streaming。
- settled success / failure 展示完整当前可用输出，不再套用 28 行限制；空输出省略 output section。footer 显示可用的截断比例、字节 cap 和 `fullOutputPath` 本地链接。
- 仅最终失败结果中精确匹配的原生 trailer 可从显示正文剥离：`Command exited with code N`、`Command timed out after N seconds`、`Command aborted`。匹配在显示清理之前进行，大小写、空白或控制序列不同就不删除；经过规范化的文本只可用于失败分类。成功或流式输出即使形似状态行也必须保留；失败 partial 可分类失败，但不能删除流式正文。
- 视觉换行与 guide 不等于可直接执行的 Shell 文本；当前没有专门的“复制原始 command”能力，不能承诺从终端选择文本可无损回贴。

**计时**不进入执行路径：

- 仅已渲染且确实运行中的行创建每秒刷新的计时器，以首次观察到的开始时间为实时依据；headless 和未渲染的嵌套调用不建记录。
- settled 优先使用有效的 `context.durationMs`；缺失时只可使用该行真实观察到的起止时间。重挂载可接续已观察到的 live start，不能把历史重放时间当执行开始。
- 无 metadata、也未观察运行过程的旧历史不显示耗时。结束、错误和 `session_shutdown` 清理定时器，不能留下刷新或无界记录。

### Read

- 折叠普通文本只显示路径及可选 `offset` / `limit` 范围，不增加普通行数摘要或正文。
- 内置行 / 字节上限触发 `details.truncation` 时显示 `outputLines/totalLinesL`；比例不可用则回退 `truncated`。
- 用户 `limit` 在 EOF 前结束可能没有 truncation details，需从原生 continuation notice 提取剩余行数，显示 `NL more`；不能因此静默隐藏文件仍有后续内容。
- 图片显示 MIME 或多图数量，原始附件仍由宿主渲染。
- 展开文本使用语言高亮，从 `offset ?? 1` 开始编号；header 表达范围和当前内容行数，section 标题显示可识别语言或行数。
- 原生 truncation / continuation notice 从普通正文分离至 footer，表达可用的 `truncated`、`N more lines`、`next offset=N`。错误用 error section 保留完整诊断；图片 rail 只放类型与说明。

### Write

- 折叠显示路径、来自 `args.content` 的行数和 UTF-8 字节数，不推断 `create` / `overwrite`，也不为展示额外检查文件存在性，避免竞态。
- 展开显示写入参数中的完整可用内容，从 1 编号并高亮；显示层统一换行 / Tab，尾部空行作展示裁整，不影响参数。
- 参数未完整时不进行完整源码高亮；参数完整后缓存高亮结果。
- 失败时按 error → content 顺序显示完整错误和 attempted content，不能把后者误称为已成功写入的文件。

### Edit

- 折叠显示路径和 `+N -M` diff stat。默认 **64 个 diff 逻辑行以内**内联，阈值统计整份 diff（包括上下文等），不只是增删行数；尾部空行不计。
- `edit.inlineDiffMaxLines: 0` 不限行数，`-1`（面板 `never`）从不内联。超限只保留 header，不另加 hidden lines / expand hint。
- 内联 `DiffPreviewBlock` 每个逻辑行只占一个终端行；长行中间省略以保留头尾，并预留右缘安全空间，避免终端自动折行扰乱 diff。
- 展开 `ExpandedDiffBlock` 展示完整可用 diff，用 added / removed / context / hunk 语义色与 ANSI-safe 换行，不中间省略。
- resolver 解析时通过 `next()` 获取下游（通常为原生）renderer，在隔离 state 中调用其 `renderCall` 以继续计算异步 preview，但不嵌入其 Box / 组件树，不新建执行工具。
- pending 可以显示 preview / previewing；settled 以原生 `details.diff` 为权威，缺失时才回退已有 preview。失败显示完整原始错误，不用成功 diff 占位。

### Codemode

只定制顶层父行，不生成内部工具的独立 transcript 行，不负责启用 Codemode。

- 折叠根据 `details.calls` 中**实际观测**到的工具名统计次数，不从 JavaScript 静态猜测未来调用或总数。
- 父脚本 preparing / running / done / failed 与子调用 done / running / failed / cancelled / unknown 分开表达。子调用失败可能被 `try/catch` 或 `Promise.allSettled()` 捕获，不能直接判父脚本失败。
- 按可用数据补最终耗时、模型费用、图片数量、截断标记。父行不增加实时 elapsed timer；最终耗时优先有效原生 metadata，缺失时仅从第一个独立 text block 严格匹配 `Script completed` / `Script failed`、`Wall time N seconds`、`Output:` 的完整原生头部回退提取，不误剥用户输出中形似头部的文本。
- 展开使用 shared rail，展示 calls（参数预览、状态、耗时、错误及可用费用）、高亮 JavaScript、脚本 output / error、images 摘要及可用 `fullOutputPath`。不新增设置，沿用 `renderShell`。
- 缺失 / 部分 / 旧 details 保守处理：没有调用摘要不等于确定零次调用，未知状态显式标 unknown；费用与耗时没有可信来源就不编造。

**数据边界**：`details.calls` 只有可能已截断的参数预览、状态、耗时、错误和可选费用，不含子工具完整结果或 Edit diff。参数预览不是完整 JSON 契约，解析失败应仍可读。父脚本主动 `text()` / `return` / console 输出可见，但不等于自动采集子结果；不复用子工具完整 renderer，不监听嵌套事件，不缓存或持久化子输出。恢复会话只用原生已保存的摘要、参数与脚本结果，不能补回缺失子结果。

## 4. 稳定 shell、历史重放与组件边界

Pi 在 `ToolExecutionComponent` 构造时选择实际挂载的 shell。之后动态改变宿主 `renderShell` getter 会指向未挂载容器；项目设置还可能晚于历史行重建加载。因此宿主 `renderShell` **始终固定为 `self`**，不能依赖重载时的一次快照解决布局切换。

`renderers/render-shell.ts` 与 `CompactToolShell` 在 call / result 两个 slot 之间协调同一布局：

- 配置 `self`：无外框 call / result，但两个 slot 都按宿主 `outputPad` 做左右缩进（与内置工具对齐）；配置 `default`：两者共用一个 Box，沿用宿主 `outputPad`、pending / error / success 背景，只有一组顶部 / 底部 padding。未传 `outputPad` 时按 0 处理，与 subagent / linear-todo 一致。
- 共享组件读取最新 options ref，既有行、新行及恢复的历史行均能在设置加载 / 保存后热切换，展开和收起不能失效。
- 两个 slot 保持各自的组件及 `lastComponent` 契约；仅解包本扩展 shell，不替换 renderer state。图片继续由宿主处理。
- 布局 cache 按宽度、模式、`outputPad` 和实际 `theme.colors` palette 失效。Read / Write / Codemode 高亮缓存同时包含原始内容、语言 / 路径（适用时）、theme 和实际 palette；不能仅凭稳定的 theme proxy identity 判断颜色未变。
- 正常 expanded 分支使用本扩展组件，不委托原生可视树；`render-expanded-result.ts` 留有隔离原生 state / slot 的辅助函数，但不代表当前五工具会自动从异常 result 形状恢复出缺失内容。

主要职责：

| 文件 / 组件 | 边界 |
| --- | --- |
| `index.ts` | 加载期注册 renderer 与 lazy 设置命令；session_start 更新可信项目 options |
| `CompactToolRow` / `ExpandedToolHeader` | 目标、摘要与宽度感知的 metadata |
| `ExpandedDetailRail` / `ToolDetailFooter` | section / guide / 收束及行动信息 |
| `LineNumberedCodeBlock` | 可选行号、Tab 归一化、视觉换行与可选 tail 限制 |
| `ShellCommandBlock` | 不解析 shell 的原始命令显示副本 |
| `DiffPreviewBlock` / `ExpandedDiffBlock` | 折叠中间省略与展开完整换行，不能混用 |
| `settings/` / `commands/compact-tool-ui-settings.ts` | 配置规范化、逐字段叠加、按层编辑与保存 |

### Expanded Bash 缓存

- 每个 tool row 的 renderer state 只保留一份临时 command / output / view cache，不进入会话存储，不收集子调用结果，不增加设置或改变执行。
- command 按清理后的显示源复用；output 按当前显示源及 partial / settled 阶段复用。因此 streaming tail 未变时可以复用正文，但总行数等 section metadata 仍须更新。
- view 只在 command、output、section metadata 与 footer 都一致时复用。footer 每次按当前截断信息、快捷键、cwd 与 full-output link 重新生成；这些变化若改变可见内容或链接目标，就必须替换旧 view。
- Theme identity 或实际 `theme.colors` palette 变化时重建 Bash 内容缓存；不能只检查稳定的 theme proxy。header / 状态 / 耗时仍按当前上下文更新，不因正文复用冻结。
- `ShellCommandBlock` / `LineNumberedCodeBlock` 各只缓存最近一次宽度与 palette 对应的布局，宽度或 palette 改变即重排，显式 `invalidate()` 清空布局缓存。
- 复用减少重复组件构造和布局，不代表 header-only 更新省掉所有结果提取、清理、计数或摘要解析；本文不作性能基准声明。

## 5. ANSI、宽度与 Tab

- Bash 原始命令 / 输出、Codemode 源码 / 输出 / 调用摘要、路径与 compact error 等使用 `stripAnsi` / inline sanitization 清理控制序列后再施加主题样式。扩展生成的本地路径链接单独处理 OSC 8 的宽度和闭合；ANSI-safe wrapping 本身不是通用终端安全沙箱，不能据此承诺所有来源的文本都已过滤。
- 所有测宽、换行和裁剪使用 Pi TUI 的 visible-column / ANSI-safe API，不以字符串长度推断终端宽度；覆盖中文、emoji、组合字符与超长路径。
- Bash command、output（含 streaming tail）以及代码 / diff 的 Tab 在显示层固定展开为 **3 个空格**，避免真实 terminal tab stop 与库测宽不同。原始 command、输出和会话记录不变。
- `LineNumberedCodeBlock` 只在传入的**正文可用宽度至少 64 列**且足够容纳前缀时显示行号。轨道和 Box 会先占宽，不能把它写成“终端 64 列就显示行号”。
- section / footer metadata 按可用宽度换行；当前没有 96 / 64 列分档隐藏 metadata 的固定布局协议。窄宽优先可读，展开不得为追求紧凑沿用摘要裁剪。
- 验收宽度为 48 / 64 / 80 / 120 列：行不越界，OSC 8 不遗留未闭合序列，resize / 主题切换不能保留 stale ANSI 或错位缓存。

## 6. 配置层、信任与保存

仅支持 `compactToolUi.renderShell` 和 `compactToolUi.edit.inlineDiffMaxLines`。默认分别是 `self` 与 `64`。有限数值向下取整，负数统一为 `-1`；`0` 不限，`-1` 从不内联。无效字段不覆盖有效继承值；面板保留手写的非预设值。

**加载**：

- 全局文件为 `getAgentDir()/settings.json`，默认 agent 目录可由 `PI_CODING_AGENT_DIR` 覆盖；项目文件为 `<cwd>/<CONFIG_DIR_NAME>/settings.json`。
- 按 **内置默认值 ← 全局 ← 项目**逐字段覆盖，`edit` 内字段也逐项合并，不整块替换。
- 扩展加载时仅叠加全局，renderer 注册仍在加载阶段完成；`session_start` 后依据 `ctx.isProjectTrusted()` 叠加项目并刷新共享 options ref。
- 未信任项目不读取其配置作为有效值，存在被忽略的有效设置且有 UI 时提示；面板锁定 global，不能写项目层。
- 文件读取支持 UTF-8 BOM；两层独立报告路径与错误，坏层按空层参与有效值计算，但绝不能据此覆盖原文件。面板将坏层标记为 unavailable 并禁止编辑，正常层仍可编辑；修复文件后重开面板。

**编辑与落盘**：

- 编辑行保留所选层原值；说明区显示已提交的 effective 值及 global / project / built-in 来源，并提示待保存与项目覆盖。global 的 `unset` / project 的 `inherit` 删除该层键以回退；支持循环取值、清键与切层，不做模糊搜索，完整按键见 README。
- 切换 scope 只是导航，不创建文件。Esc 关闭面板，不撤销已经落盘的编辑。
- 每层独立记录 dirty fields，通过串行 flush 合并编辑；每批捕获不可变字段 patch，不能被后续切层或新输入重定向。patch 缺字段表示不修改，`null` 表示删键恢复继承（不把 `null` 写进 JSON）。
- `lastSaved` 来自成功读取或真实提交层。保存返回锁内最新值，未编辑字段同步至面板，保存期间的新输入重放到待提交层；仅用已提交两层热应用，不能让排队编辑提前生效。
- 失败时提示错误，回滚**失败层及其尚未落盘的后续编辑**到真正保存的快照；另一层排队保存继续，不能整体回滚或丢弃它的改动。
- 存储使用与宿主一致的 `proper-lockfile` / `realpath: false` 协议；锁内重读，仅 patch 本批编辑字段并清理已移除的 Bash 键。保留其他 Pi 设置、扩展及未知键；空 block 可移除，删除键必须真实落盘。该保护要求其他写入者也遵守同一锁协议。
- 取得锁后同步完成读 / 修改 / 唯一临时文件写入 / rename / 解锁，不在持锁期间 await，避免同进程原生同步写入者阻塞；锁争用在锁外异步重试。Windows 替换冲突有限重试，每轮解锁并重读，不降级为截断原文件的原地覆写；替换失败时清理临时文件并保留原文件。
- 面板不监听外部文件变化，也不提供跨两个文件的事务；重开 / reload 或本层下次保存时读取最新值。同字段冲突按实际持锁提交顺序后写优先。

### 兼容说明

不支持缺少 `registerToolRenderer` 的旧宿主，不回退到同名工具 override。旧 Bash 配置在读取时均忽略，成功输出摘要恒开；只有用户通过面板**显式保存的层**才清理以下键：

- `compactToolUi.bash.tailPreview` / `previewLines`。
- 更早的 `compactToolUi.bash.runningTailPreview` / `successfulTailPreview` / `failedTailPreview` / `successfulOutputSummary` / `settledTailPreview`。

不在加载时自动迁移，不自动修改全局 / 项目 settings 或已安装副本；未知键仍保留。Bash collapsed 正文预览已移除，不能因旧配置而重新出现。

## 7. 回归与验证边界

以下是应持续满足的回归约束，不是施工阶段或此次测试通过声明：

- 连续 Read / Write 不铺开正文；Bash 所有 collapsed 状态只有一条 header，更新不增长 transcript 或挤动 viewport；Edit 阈值与失败摘要准确。
- 五工具 shared rail 无重复标题、Box 或 padding；完整可用命令、文件内容、diff、错误、truncation / continuation 和 full-output path 可读，图片不重复渲染。
- Bash 手动展开能经历 streaming → settled，再收起；tail 有界、最终内容恢复完整当前可用输出；状态形似正文不误删，旧历史无可信时间不编造耗时，定时器正确清理。
- 使用实际 Pi SDK 时默认工具集合、执行配置及安全扩展定义不变；两种 shell、主题热切换、历史重放、session restore、`/reload` 和缺失 metadata 不导致 stale state。
- Edit 保留下游异步 preview，最终 diff 不被预览覆盖；配置覆盖旧面板 / 原生写入者互操作、BOM、坏层隔离、字段继承、跨层排队、失败回滚、最新未编辑字段、未知键保留与未信任项目门禁。
- 中文 / emoji / Tab、长行 / 路径和 OSC 8 在 48 / 64 / 80 / 120 列下符合宽度规则；缓存须覆盖同宽复用、resize、palette 替换、partial → settled、metadata / footer / 链接变化及显式 invalidate。

在扩展目录运行 `npm run check`（typecheck + tests）。`test/` 包含 focused tests、Pi **1.3.0** 实际 `ToolExecutionComponent` / SDK 用例，以及注入内存 fake terminal 的原生 80×24 fullscreen / viewport 回归；后者检查 collapsed 高度、屏幕差异、固定 dock 和手动展开状态，不是实际终端人工验收。用例存在或通过都不代表所有终端的显示、选择复制、主题与外框切换已人工确认。历史方案只留在 Git，不维护文档归档树。
