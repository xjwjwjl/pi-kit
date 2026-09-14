# Pi Tools UI 展示优化设计草案

> 状态：MVP v0 与 Expanded v1（统一 detail rail、`bash` / `read` / `write` / `edit` expanded renderer）已实现；Expanded Bash 原始命令展示、ANSI-safe 换行与 truncation 细节已实现
> 目录：`extensions/compact-tool-ui/`  
> 目标：先用扩展覆盖内置 `bash` / `write` / `read` / `edit` 的 renderer 进行体验验证，设计稳定后再考虑 upstream patch。

## 1. 背景

pi 的内置 tools 已经支持自定义 TUI 渲染：

- 每个 tool 可以提供 `renderCall` / `renderResult`。
- `ToolExecutionComponent` 已经支持 pending / success / error 背景。
- 已有 `expanded` 状态，可通过 `app.tools.expand` 切换。
- `bash` 已支持 partial result 和耗时展示。
- `edit` 已支持 diff preview。
- `read` 已针对 skill/docs/resource 做过部分 compact 展示。

当前问题不是能力不足，而是默认信息密度偏高：频繁的 `read`、`bash`、`write` 输出容易占据大量屏幕空间，导致用户难以快速扫描 agent 到底做了哪些关键动作。

## 2. 设计原则

### 2.1 默认少打扰

默认折叠态只展示“发生了什么”和“关键结果”，不要默认铺开大段内容。

### 2.2 状态一眼可见

每个 tool 行应能快速看出：

- 正在运行 / 成功 / 失败 / 被截断。
- 操作对象是什么。
- 关键结果是什么。
- 是否可以展开查看更多。

### 2.3 失败优先诊断

失败时 collapsed 用一行 compact reason 表达错误类别（如 `test failed · exit 1`），完整错误通过 expand 查看，而不是只显示失败状态，也不是无差别展示完整输出。

### 2.4 展开保留细节

详细内容不丢失，只是从默认视图移动到 expanded 视图：

- 文件内容预览。
- 命令完整输出。
- diff。
- grep/find/ls 结果列表。
- 截断说明与 full output 路径。

### 2.5 各 tool 行为统一

不同 tool 的具体内容不同，但信息结构应统一：

```text
[状态] tool 主要对象 / 意图                         元信息
摘要 / 关键结果
预览内容，默认折叠
footer：耗时、截断、可展开提示
```

## 3. 目标视觉形态

默认 collapsed 状态：

```text
read src/index.ts
grep /renderResult/ in src                      5 matches · 2 files
edit src/tools/bash.ts                          +6 -2
bash pnpm test                                  running · 3.1s
```

展开单个 tool 后：

```text
edit src/tools/bash.ts                          +6 -2

@@ -42,7 +42,11 @@
 ...
```

失败时即使不展开，也应能判断关键错误类别：

```text
bash pnpm test                                  test failed · exit 1 · 8.4s
```

## 4. 通用信息层级

### 4.1 Header

Header 负责表达：

- 状态符号。
- tool 名称。
- 主要目标。
- 关键元信息。

示例：

```text
read src/index.ts:1-120
bash pnpm build                                 exit 1 · 9.7s
write extensions/foo/index.ts                   214L · 6.8 KB
```

### 4.2 Summary

Summary 负责表达 tool 的结果摘要：

- bash：成功 / 失败 / duration；running 时可补充已输出行数。
- edit：diff stat。
- grep：match count / file count。
- find：result count。
- ls：entry count / directory count。

### 4.3 Preview

Preview 应根据状态和 expanded 决定是否展示：

- collapsed + success：默认尽量少展示。
- collapsed + failure：默认只保留一行失败摘要（如 `test failed · exit 1`）；可通过 `failedTailPreview` 选择是否额外展示错误尾部。
- expanded：展示完整可用预览或当前内置 renderer 的完整内容。
- partial/running：MVP v0 当前只更新 header 状态与已输出行数，不展示 tail preview。

### 4.4 Footer / Hint

统一简短提示：

```text
… 42 more lines · expand
```

或：

```text
… 42 more · Ctrl+O to expand
```

具体 key 应通过 `keyHint("app.tools.expand", "to expand")` 获取。

失败态统一使用 compact reason；本扩展当前不再输出下一行 compact hint，失败只保留一行错误摘要，完整错误靠展开：

```text
read src/missing.ts                              path not found
write src/secret.ts                              permission denied
edit src/config.ts                               oldText not found
```

## 5. 各内置 tool 的展示策略

## 5.1 read

### 当前倾向

`read` 是高频 tool，默认显示文件前若干行会造成噪音；普通行数摘要本身也容易变成低价值噪音。建议普通文件默认只显示路径，重要状态再进入 metadata。

### collapsed 展示

普通文件：

```text
read src/index.ts
```

带 offset / limit：

```text
read src/index.ts:120-180
```

截断：

```text
read src/huge.ts                                2000/9000L
read src/large.ts:1-100 · 4900L more
```

MVP v0 不设置小文件例外：所有成功 `read` 在 collapsed 状态默认不展示正文；普通文本读取不显示行数，用户展开后再看正文。后续如果反馈过于安静，再讨论小文件直出阈值。

`read` 有两种提前结束的路径，两者都必须进入 collapsed metadata：内置行 / 字节上限（`details.truncation`）显示 `outputLines/totalLinesL`，比值不可用时回退为 `truncated`；用户 `limit` 在 EOF 前停止时不产生 truncation details，只留下正文里的 continuation notice，因此从 notice 中解析剩余行数并显示为 `NL more`。

### expanded 展示

沿用当前 read renderer：

- 语法高亮。
- 最多/完整展示行逻辑。
- truncation 警告。
- image fallback。

### 错误态

只显示错误原因，不额外占一行；完整错误靠展开：

```text
read src/missing.ts                              path not found
```

## 5.2 bash

### 当前倾向

`bash` 是最容易刷屏的 tool。成功时默认应该非常克制，失败时默认只用一行分类摘要表达错误（`test failed` / `tsc errors` / `command not found` / `exit <code>`），完整错误通过 expand 查看，避免失败现场长期占据会话。多行命令，尤其是 `python3 - <<'PY'` 这类 heredoc，在 collapsed 状态下也会造成大量噪音，因此命令本身也需要一行摘要化。

### running 状态

```text
bash npm test                                   running · 4.1s
bash sleep 10                                   timeout 30s · running · 4.1s
bash npm test                                   2L so far · 4.1s
bash python3 heredoc                            31 lines · 1.3 KB · 2L so far · 4.1s
```

MVP v0 默认在运行中只更新 header 状态；如果已有输出，则显示已输出行数（`NL so far`）。调用参数提供 `timeout` 时，只在运行中的 collapsed metadata 中显示 `timeout Ns`；命令结束后该字段移除，避免和真实 outcome 重复（`timeout` / `aborted` 由 result summary 表达）。tail preview 作为可选能力，可配置显示最后 N 行。多行 / heredoc / 长命令在 collapsed 状态下始终压缩为一行命令摘要。

### success collapsed

```text
bash npm test                                   38L · 12.4s
bash python3 heredoc                            110 lines · 4.1 KB · 8L · 0.8s
bash echo hi                                    hi
bash wc -l docs/tui.md                          961 docs/tui.md · 1.2s
bash git status --short                         M a.vue · 1 more line · 1.2s
bash git diff -- web/src                        no changes
# 输出被内置限制截断时：
bash npm test                                   50L · truncated · 12.4s
```

成功时默认仍不展示正文；如有输出，则在摘要中补充输出摘要，并将耗时放在 metadata 最后。

普通命令的输出摘要按信息密度分级：内容行数 ≤ 2 时直接展示首行内容（单行化、按 160 字符上限截断），行数为 2 时附加 `1 more line` 标记；行数 ≥ 3 时使用 `NL` 单位计数（`50L`），避免 `50 output lines` 这类短语吞掉命令正文的可用宽度。计数只统计非空内容行，空行不计入；`NL` 在同一行内与 command metadata 的 `N lines` 不会混淆。

内置 bash tool 截断输出时（`details.truncation.truncated`），collapsed 摘要追加 `truncated` 标记，例如 `50L · truncated`；无摘要时单独显示 `truncated`，不依赖展开才能发现。

`rg` / `grep` 显示 `N matches`（可推断时补充 `M files`）；带 `-A` / `-B` / `-C` context 的 `rg` / `grep` 显示 `N search lines`；`find` / `rg --files` 显示 `N paths`；`find ... | wc -l` 显示 `N files`；纯 `ls` 显示 `N entries`，但 `ls && ...` / `ls; ...` 等混合命令降级为普通内容摘要。语义化命令空输出时显示 `no matches` / `no paths` / `empty`；`git diff` 类命令空输出时显示 `no changes`，`git status --short` / `--porcelain` 空输出时显示 `clean`；其余普通命令无输出时保持静默，只显示耗时。用户展开后再看完整输出和完整命令。

耗时低于 1s 时不写入 collapsed metadata，避免大量亚秒级命令拖出一条无信息的 `0.1s`。

### error collapsed

```text
bash pnpm build                                 tsc errors · exit 2 · 9.7s

bash pnpm test                                  test failed · exit 1 · 4.1s
```

失败时 collapsed 只展示一行分类摘要（类型识别、退出码、耗时），不再默认贴出错误尾部；`failedTailPreview` 打开后才会追加最后 N 行（N 取 `previewLines`）。完整 output 始终通过 expand 查看。

### expanded

展示完整当前可用 output，并保留：

- truncation 信息。
- full output path。
- took / elapsed。

## 5.3 edit

### 当前倾向

`edit` 是文件变更类 tool，默认不应完全静默；但大 diff 也不应刷屏。当前策略是：64 行以内 diff collapsed 直接展示，大 diff collapsed 只保留一行摘要，展开后看完整 diff。collapsed 预览中每个逻辑 diff 行最多占一条终端行；过长内容采用中间省略，保留行首定位和行尾结果，避免软换行扰乱 diff 边界。`compactToolUi.edit.inlineDiffMaxLines` 可以调整阈值，设为 `0` 时不限制行数。

### collapsed

```text
edit src/config.ts                              +12 -4
```

小 diff 默认 inline 展示：

```text
edit src/config.ts                              +1 -1

  │ -42 timeout: 5000,
  │ +42 timeout: 10000,
  ╰─
```

大 diff 只展示 header，不额外展示 changed lines / hidden lines / expand hint：

```text
edit src/session.ts                             +93 -41
```

### error collapsed

```text
edit src/config.ts                              oldText not found
```

### expanded

委托内置 renderer，展示完整 diff。

## 5.4 write

### 当前倾向

`write` 当前默认展示前 10 行内容；创建/覆盖大文件时很容易刷屏。建议成功时默认展示摘要。

### collapsed

```text
write extensions/foo/index.ts                   214L · 6.8 KB
```

如果能区分新建与覆盖：

```text
create extensions/foo/index.ts                  214L · 6.8 KB
overwrite src/app.ts                            380L · 12.1 KB
```

### 小文件例外

MVP v0 不设置小文件例外：所有成功 `write` 在 collapsed 状态默认只展示摘要；用户展开后再看写入内容。后续如果反馈过于安静，再讨论行数 / 字节数阈值。

### error collapsed

只显示精简错误，不额外占用一行：

```text
write src/generated.ts                          permission denied
```

### expanded

展示写入内容预览，保留语法高亮。

## 5.5 grep

### collapsed

```text
grep /ToolExecutionComponent/ in dist           7 matches · 3 files
```

无匹配：

```text
grep /fooBarBaz/ in src                         no matches
```

### preview

默认可展示少量匹配，但建议比当前更结构化，按文件分组：

```text
src/a.ts
  12: ...
  48: ...

src/b.ts
  9: ...
```

### expanded

展示全部可用匹配，保留 truncation / match limit 信息。

## 5.6 find

### collapsed

```text
find **/*.ts in extensions                      42 paths
```

无结果：

```text
find **/*.spec.ts in src                        no paths
```

### preview

默认最多展示 8-10 条路径：

```text
extensions/a.ts
extensions/b.ts
… 32 more · expand
```

### expanded

展示全部可用路径，保留 result limit / truncation 信息。

## 5.7 ls

### collapsed

```text
ls extensions/web-research                      8 entries · 3 dirs
```

空目录：

```text
ls tmp/foo                                      empty
```

错误：

```text
ls tmp/foo                                      path not found
```

### expanded

展示完整目录列表。

## 6. MVP v0 已确认决策

本节记录第一阶段已经确认的最小可实施版本，后续实现优先以此为准。

### 6.1 范围

MVP v0 首先覆盖三个最容易造成噪音的内置 tool：

1. `bash`
2. `write`
3. `read`

后续已补充：

4. `edit` 小 diff inline、大 diff 摘要折叠。

暂不实现：

- `grep` 按文件分组。
- `find` / `ls` 摘要重构。
- 全局 `compact / normal / verbose` 配置。

### 6.2 已确认规则

| 决策 | 结论 |
|------|------|
| `bash` 成功时是否默认显示输出 | 不显示正文，只显示摘要 |
| `bash` 失败时是否默认展示 tail | 默认不展示，只保留一行分类摘要；`failedTailPreview` 开启后展示最后 N 行 |
| `write` 成功时是否默认显示正文 | 不显示正文，只显示摘要 |
| `read` 成功时是否默认显示正文 | 不显示正文，只显示摘要 |
| 是否加状态符号 | 不加状态符号，状态由 metadata / error reason / 颜色上下文承担 |
| Header 元信息是否右对齐 | MVP 不做右对齐，使用 inline metadata |

### 6.3 MVP v0 展示规则

#### bash

- running：显示 `bash <command summary> · running · <elapsed>`；如果已有输出，则切换为 `bash <command summary> · <n>L so far · <elapsed>`。
- running：默认不展示 tail preview；可通过配置开启最后 N 行 preview。
- timeout：调用参数提供 `timeout` 时，只在该命令处于 running / pending 时于 collapsed metadata 中显示 `timeout Ns`；命令结束后移除该字段。
- collapsed command：短单行命令原样显示；`rg` / `grep` / `find` / 纯 `ls` 使用语义 label，例如 `rg /pattern/ in path`、`find *.ts in .`、`ls src`；长单行命令截断但不额外显示字符数；多行命令压缩为 `shell script · N lines · size`；Python heredoc 压缩为 `python3 heredoc · N lines · size`。
- success collapsed：只显示摘要，例如 `bash pnpm test · 38L · 12.4s` 或 `bash git status --short · M a.vue · 1 more line`。
- success collapsed：内容行数 ≤ 2 的普通命令直接展示首行内容（单行化、160 字符上限），行数为 2 时附加 `1 more line`；行数 ≥ 3 时使用 `NL` 单位计数。计数只统计非空内容行。
- success collapsed：内置 bash tool 截断输出时（`details.truncation.truncated`）在摘要后追加 `truncated`，无摘要时单独显示 `truncated`。
- success collapsed：`rg` / `grep` 使用 `N matches`，带 context 时使用 `N search lines`，空输出使用 `no matches`；`find` / `rg --files` 使用 `N paths`，`find ... | wc -l` 使用 `N files`，空输出使用 `no paths`；纯 `ls` 使用 `N entries`，空输出使用 `empty`；`git diff` 类空输出使用 `no changes`，`git status --short` / `--porcelain` 空输出使用 `clean`。
- duration：耗时低于 1s 时不展示；命令无输出且无适用语义时只显示耗时（或什么都不显示）。
- error collapsed：显示 `bash <command summary> · <failure class> · exit <code> · <duration>`，默认不展示输出；`failedTailPreview` 打开时追加最后 N 行（N 取 `previewLines`）。
- expanded：委托原始 renderer，展示完整当前可用输出、完整命令、截断信息和 full output path。

#### write

- success collapsed：只显示摘要，例如 `write src/generated.ts · 214L · 6.8 KB`；行数使用与 `bash` 相同的 `NL` 单位。
- 不设置小文件例外。
- error collapsed：只显示 compact reason，例如 `write src/generated.ts · permission denied`；不显示下一行 compact hint，完整错误靠展开（与 read / edit 一致）。
- expanded：委托原始 renderer，展示写入内容预览和语法高亮。

#### read

- success collapsed：普通文本只显示路径，例如 `read src/index.ts`。
- 带范围时显示 `path:start-end`。
- 截断时按内置上限显示 `outputLines/totalLinesL`（例如 `2000/9000L`），比值不可用时显示 `truncated`；用户 `limit` 提前结束时显示 `NL more`（例如 `4900L more`）。
- 不设置小文件例外。
- error collapsed：只显示 compact reason，例如 `read src/missing.ts · path not found`；不显示下一行 compact hint，完整错误靠展开（与 edit 一致）。
- expanded：委托原始 renderer，展示文件内容、语法高亮和截断信息。

#### edit

- success collapsed：显示 diff stat，例如 `edit src/session.ts · +93 -41`。
- 小 diff collapsed：默认 inline 展示 64 行以内 diff；`inlineDiffMaxLines: 0` 时不限行数。
- 大 diff collapsed：只显示 header，不展示 changed lines / hidden lines / expand hint。
- error collapsed：只显示精简错误，不显示下一行 compact hint，避免错误态占用额外行。
- expanded：委托原始 renderer，展示完整 diff。

### 6.4 MVP v0 非目标

- 不改变任何 tool 的 `execute` 语义。
- 不改变返回给 LLM 的 tool result 内容。
- 不改变 session 存储结构。
- 不新增配置项。
- 不追求 header 右对齐。
- 不在第一版实现 create / overwrite 区分。

## 7. 建议优先级

### P0：文档与行为确认

- [x] 建立扩展目录。
- [x] 沉淀设计文档。
- [x] 讨论默认策略是否接受。
- [x] 确定 MVP v0 不设置小文件 / 小输出例外。

### P1：最吵的三个 tool

1. [x] `bash`
   - 成功默认摘要。
   - 失败默认一行分类摘要，tail 预览可选。
   - running 更新状态与已输出行数。
2. [x] `write`
   - 成功默认摘要。
   - expanded 再显示内容。
3. [x] `read`
   - 普通文件默认摘要。
   - expanded 再显示内容。

### P2：结构化结果类 tool

4. `grep`
   - match count / file count。
   - 可选按文件分组。
5. `find`
   - path count。
   - 默认短列表。
6. `ls`
   - entry count / dir count。
   - 默认短列表或摘要。

### P3：细节统一

7. [x] `edit`
   - [x] 小 diff inline。
   - [x] 大 diff 只显示 header。
   - [x] diff stat。
8. [x] 通用 compact error 文案统一（read / write / edit）。
9. 截断、full output、耗时格式统一。

## 8. 可能的配置项

当前 `compactToolUi` 设置只保存到全局 `~/.pi/agent/settings.json`，不再读取或写入项目级 `.pi/settings.json`。已有 `bash` 预览、`edit.inlineDiffMaxLines` 和 `renderShell` 等配置。后续可考虑：

```ts
toolsDisplay: "compact" | "normal" | "verbose"
```

或更细：

```ts
tools: {
  defaultExpanded: false,
  showSuccessfulBashOutput: false,
  showWritePreview: "small-only",
  readPreviewLines: 0,
  bashPreviewLines: 8,
}
```

建议避免一开始就引入过多配置，否则会掩盖默认体验问题。

## 9. 实现方向

当前 MVP v0 已采用扩展方式落地于 `extensions/compact-tool-ui/index.ts`：

- 覆盖内置 `bash` / `write` / `read` / `edit` 的 tool definition。
- `execute` 委托原始内置 tool，不改变执行语义。
- collapsed 状态使用 compact renderer。
- 使用 `renderShell: "self"` 去掉默认 Box 背景和内边距，降低“每个 tool 一个 cell”的视觉噪音。
- expanded 状态尽量委托原始 renderer 展示详细内容。
- 如果已有其他扩展也覆盖同名 tool，会发生 tool name conflict，需要二选一启用。

注意：当前 pi 的 `ToolExecutionComponent` 仍会为每个 tool row 无条件添加一个 `Spacer(1)`。扩展层可以去掉默认 Box/cell，但无法完全消除每个 tool 之间的空行；如果要做到真正 inline 或 turn-level grouping，需要改 pi internals。


### 9.1 扩展方式

可以通过扩展覆盖内置 tool：

- 使用 `createReadToolDefinition` / `createBashToolDefinition` 等拿到内置定义。
- `pi.registerTool({ name: "read", ... })` 覆盖内置 tool。
- `execute` 直接委托原 tool。
- 只重写 `renderCall` / `renderResult`。

优点：

- 可在当前项目中快速迭代。
- 不需要修改 pi internals。
- 可以逐 tool 落地。

注意：

- 覆盖内置 tool 时需要保持 result shape 兼容。
- Prompt metadata 不会自动继承，需要显式复制必要字段。
- 对文件变更类 tool 不应改变原 execute 行为，避免引入并发写入风险。

### 9.2 Upstream patch 方式

如果设计稳定，可以直接改 pi 内置工具 renderer：

- `core/tools/bash.ts`
- `core/tools/read.ts`
- `core/tools/write.ts`
- `core/tools/edit.ts`
- `core/tools/grep.ts`
- `core/tools/find.ts`
- `core/tools/ls.ts`

优点：

- 不需要覆盖内置 tool。
- 与原始 tool details 更紧密。
- 更容易统一主题和交互。

缺点：

- 需要维护 fork 或提交 upstream。

## 10. 当前已知实现基础

根据当前 pi 实现，以下能力已经可用：

- `ToolExecutionComponent`：
  - 支持 `expanded`。
  - 支持 `isPartial`。
  - 支持 `executionStarted` / `argsComplete`。
  - 支持 `renderShell: "self"`。
  - 支持 `context.state` 和 `lastComponent`。
- `bash`：
  - 已有 partial update。
  - 已有 startedAt / endedAt / interval。
  - 当前 collapsed preview 为有限行输出。
- `read`：
  - 已有语法高亮。
  - 已有 compact resource/docs/skill 逻辑。
- `write`：
  - 已有语法高亮和增量 highlight cache。
- `edit`：
  - 已有 diff preview。
  - 扩展层已实现小 diff inline、大 diff header-only 的 compact renderer。
- `grep/find/ls`：
  - 已有输出行数限制与 expand。

因此第一阶段主要是调整 renderer 的“默认展示策略”，不需要重写 tool execute。

## 11. 待讨论问题

1. [x] `read` 是否应该默认完全不展示正文？MVP v0：是，小文件也不例外。
2. [x] `bash` 成功但有输出时，默认是否展示最后几行？MVP v0：否，只显示摘要。
3. [x] `write` 小文件阈值用行数、字节数，还是二者结合？MVP v0：不设置阈值，小文件也只显示摘要。
4. [ ] `grep` 是否值得做按文件分组，还是先只改 header 摘要？
5. [ ] `ls` collapsed 是否只显示摘要，还是保留前几项？
6. [ ] 是否要全局增加 `compact / normal / verbose` 显示模式？
7. [ ] 最终是保持扩展形式，还是准备 upstream patch？

## 12. 验收标准草案

### 默认体验

- 连续多个 `read` 不应明显刷屏。
- 成功的 `write` 不应默认展示大段文件内容。
- 成功的 `bash` 不应默认展示大段命令输出。
- 失败的 `bash` collapsed 一行即可看出错误类别（如 `test failed · exit 1`），完整错误展开可见。

### 展开体验

- 展开后能看到原先可见的关键内容。
- 截断说明仍然可见。
- full output 路径仍然可见。

### 安全性 / 兼容性

- 不改变 tool execute 语义。
- 不改变返回给 LLM 的 tool result 内容。
- 覆盖内置 tool 时保持 details shape 兼容。
- 在非 interactive 模式下不影响执行结果。

## 13. Expanded v1 设计提案（P1 已实现，P2 待实现）

> 本节描述 Expanded v1 的目标体验与当前进度。P1 已由本扩展完整渲染 `bash` / `read`；`write` / `edit` 仍主要委托内置 renderer 作为兼容性 fallback。

### 13.1 问题与目标

当前 collapsed 视图已经形成了紧凑、低噪音的一行信息结构，但切换到 expanded 后会进入各内置 tool 不同的展示语言：有的直接展示纯文本，有的在 call 内展示内容，有的自带 Box / padding。配合扩展默认的 `renderShell: "self"`，容易出现 header、内容、间距和背景彼此不连续的问题。

Expanded v1 的目标是让展开成为 collapsed 行的自然纵向延伸：

1. **统一视觉语法**：所有 tool 都使用同一套 header、详情轨道、footer 层级。
2. **内容优先**：展开后能完整阅读、复制、诊断；不为了“紧凑”再次丢失内容。
3. **状态明确**：running、failure、truncation、用户 limit 和图片等例外状态有固定位置。
4. **无卡片堆叠**：不引入多层 Box、粗边框或大面积背景；利用终端的留白、缩进和低对比 guide 建立层级。
5. **不改变语义**：不改 execute、result shape、LLM context、session 存储和默认快捷键。

### 13.2 统一视觉语法：详情轨道（detail rail）

推荐 expanded 视图采用单根低对比左侧轨道，而不是卡片或表格。header 保持 tool 名、主要对象、状态和结果摘要；body 由命名 section 组成；footer 只承载收起提示及异常操作信息。

```text
Bash pnpm test · exit 1 · 4.2s

  ├─ command
  │  pnpm test -- --runInBand
  ├─ output · 38 lines
  │  FAIL src/foo.test.ts
  │  Expected: 1
  │  Received: 2
  ╰─ Ctrl+O collapse
```

规则：

- **header**：只出现一次 outcome / duration / diff stat，避免 footer 重复同一信息。
- **section 标题**：使用 `├─ <kind> · <metadata>`；`kind` 采用小写短词，例如 `command`、`content`、`output`、`diff`、`error`。
- **正文**：每行固定在 `│` guide 后；代码、diff 与原始输出有各自的主题语义色。
- **footer**：使用 `╰─` 收束轨道，仅显示 `Ctrl+O collapse`、truncation、continuation 或 full-output link 等下一步行动信息。
- **留白**：expanded result 在 header 后只增加一个内容间隔；`ToolExecutionComponent` 已在 self shell 外提供 tool 间留白，组件自身不能再增加无意义的顶部 spacer。
- **背景**：默认 `renderShell: "self"` 下不绘制背景色；状态通过 header 的语义色与内容中的 error / warning token 表达。`renderShell: "default"` 仍可由 Pi 的外层 shell 提供背景，不需要增加另一套样式。

### 13.3 各 tool 展开形态

#### bash

```text
Bash pnpm test · exit 1 · 4.2s

  ├─ command
  │  pnpm test -- --runInBand
  ├─ output · 38 lines
  │  FAIL src/foo.test.ts
  │  Expected: 1
  │  Received: 2
  ╰─ Ctrl+O collapse
```

- `command` 永远展示完整命令；多行命令和 heredoc 以 shell code block 呈现，而不是继续使用 collapsed command summary。
- settled success / failure 展示当前可用的完整 output；输出为空时省略 `output` section。
- running 时只显示最后约 20–30 个**视觉行**的 tail，并在 section 标题标注 `tail X/Y lines · streaming`（Y 为当前总输出行数，elapsed 保留在 header），避免长时间任务持续把 transcript 推高；settled 后替换为完整当前 output。
- truncation 时 footer 显示 warning、已显示比例和可点击的 `full output` 本地路径；不要把内置 tool 拼进正文的 truncation 文案作为普通日志渲染。
- failure 的 header 显示 exit / timeout / duration，正文保留完整诊断，不只保留 collapsed tail。

#### read

```text
Read src/router.ts:80-150 · 71 lines

  ├─ content · TypeScript
  │   80  export function registerRoutes() {
  │   81    // ...
  │   82  }
  ╰─ Ctrl+O collapse
```

- 以 `offset ?? 1` 计算真实行号；宽度不足时优先隐藏行号，保留内容和 guide。
- section 标题显示语言（可识别时）和实际读取范围；正文使用语法高亮。
- result 内的 truncation / user limit continuation notice 需要从正文中分离：前者在 footer 显示 `truncated · next offset=N`，后者显示 `N more lines · next offset=N`。
- 图片读取保留 Pi 的原生 image attachment 展示；轨道只展示图片类型、诊断和展开状态，不复制渲染 image data。

#### write

```text
Write extensions/foo/index.ts · 214L · 6.8 KB

  ├─ content · TypeScript
  │    1  import type { ExtensionAPI } from "...";
  │    2  // ...
  ╰─ Ctrl+O collapse
```

- 成功后展示完整写入内容（来自 args），并使用语言高亮和从 1 开始的行号。
- pending 时可渐进显示已到达的 arguments，但只在参数完整后做完整高亮，避免每次 token 更新重算整份文件。
- failure 时按 `error` section → `content` section 的顺序展示：先给出完整错误，再保留 attempted content 供诊断。
- 不在 Expanded v1 推断或展示 `create` / `overwrite`，避免额外文件检查带来竞态或语义变化。

#### edit

```text
Edit src/router.ts · +12 −4

  ├─ diff · 2 hunks
  │  @@ -80,7 +80,15 @@
  │  - const timeout = 5000
  │  + const timeout = 10000
  ╰─ Ctrl+O collapse
```

- 使用完整 unified diff：hunk header、added、removed、context 都使用稳定主题 token。
- expanded 状态不采用 collapsed `DiffPreviewBlock` 的中间省略策略；长行应 ANSI-safe 换行，并让 continuation 对齐内容列，保证可复制且不丢失行尾。
- pending 时可以复用已有 async preview；settled 后以 `details.diff` 为权威数据。
- error 使用 `error` section 展示完整原始错误；不再渲染成功 diff 的占位内容。

### 13.4 状态与响应式规则

| 情况 | Header | Body | Footer |
|---|---|---|---|
| pending | tool / target / preparing | 可省略，或展示已完整的 command/content | 无 |
| running | running 或 stream summary / elapsed | bash 显示 tail；其他 tool 展示稳定 preview | `streaming` 信息可放 section 标题 |
| success | 结果摘要 / duration | 完整可用内容 | `Ctrl+O collapse` |
| failure | compact reason / exit / duration | 完整 error 与可用诊断 | 收起提示 |
| truncated | 正常结果摘要 | 已保留的可用内容 | warning、比例、next offset 或 full-output path |

宽度分级：

- **≥ 96 columns**：显示 section metadata、行号和完整 footer metadata。
- **64–95 columns**：保留 section 标题，行号按可用宽度缩短或省略。
- **< 64 columns**：优先保留 guide、内容和状态；省略语言、行数等可推导 metadata，禁止横向溢出。
- 所有正文都必须经过 ANSI-safe wrapping；展开态不能因为视觉原因截断内容。只有 tool 原本的 result truncation 才能减少可用内容。

### 13.5 实现边界与组件划分

已新增并继续建议复用以下组件，而不是在四个 renderer 中拼接字符串：

```text
components/
  expanded-tool-header.ts       // expanded header，复用 compact 的状态与链接语义
  expanded-detail-rail.ts       // section / guide / footer 的布局容器
  line-numbered-code-block.ts   // ANSI-safe code wrap、可选行号、语言高亮缓存
  shell-command-block.ts        // Bash command layout、语义样式与 continuation
  expanded-diff-block.ts        // 完整 diff 的语义着色与 ANSI-safe wrapping
  tool-detail-footer.ts         // truncation、continuation、keyHint、full-output link
renderers/
  bash.ts                       // expanded Bash renderer
  read.ts                       // expanded Read renderer
  write.ts                      // expanded Write renderer
  edit.ts                       // expanded Edit renderer
```

实现原则：

1. expanded 时 `renderCall` / `renderResult` 使用插件组件，不再把内置 renderer 的组件树直接嵌入 self shell。
2. `render-expanded-result.ts` 保留为 result shape 异常、未来未知 tool 或显式 native fallback 的兼容路径。
3. 继续复用 Pi 导出的语言识别、语法高亮、key hint 和 diff 语义能力，但由本扩展负责布局、间距和 footer。
4. 通过 `context.lastComponent` 与 row-local state 缓存解析后的原始行和 width 相关 render cache；主题切换时丢弃预烘焙 ANSI 样式并从原始数据重建。
5. 保留现有 collapsed renderer 和 `DiffPreviewBlock` 行为；Expanded v1 只替换 `context.expanded === true` 分支。
6. `edit` 的 async preview 计算与内置可视组件解耦：collapsed 可以延续当前预览机制，expanded 以最终 `details.diff` 为主，避免 nested Box / padding。

### 13.6 分阶段交付

1. **P1：基础布局 + bash / read（已实现）**
   - 落地 detail rail、footer、code block、宽度处理和 truncation 分离。
   - 覆盖最常使用且最能检验内容密度的 command output 与文件正文。
2. **P2：write / edit（已实现）**
   - 接入完整写入内容、增量高亮缓存和完整 diff block。
   - expanded 状态不再嵌入内置 `edit` 可视组件。
3. **P3：稳定性与回退（基础项已实现）**
   - 对 native fallback、图片、错误、主题切换、窄终端和 streaming 做回归。
   - 依据实际体验再决定是否需要 `expandedStyle: "structured" | "native"` 配置；P1/P2 不新增设置项。

### 13.7 Expanded v1 验收标准

- 展开任一已支持 tool 后，header、内容、footer 视觉层级一致，不出现重复标题、嵌套 Box 或双重 padding。
- `bash` 的完整命令、完整可用 output、timeout / exit、truncation 和 full-output path 都可读。
- `read` / `write` 的代码高亮、行号、范围和 continuation 信息准确；图片不重复渲染。
- `edit` 的每个 diff 字符在 expanded 下可见或通过换行保留，不使用中间截断。
- 在 48、64、80、120 列宽下每一行都不超过可用 width；OSC 8 路径链接不会因截断遗留未闭合序列。
- running bash 更新不造成无界 transcript 增长；settled 后展示完整当前可用 output。
- 主题切换、session restore、`/reload` 和原生 renderer fallback 不出现旧 ANSI 颜色或 stale component state。

## 14. Expanded Bash 原始命令展示（无额外 parser，已实现）

### 14.1 决策

Expanded Bash 的 `command` section 不再尝试理解或重排 shell 语法：

- 保留 `rawCommand` 的原始字符、空白、引号、转义和物理换行。
- 只移除 ANSI 控制序列，再进行宽度感知的视觉换行。
- 不拆分 `;`、`&&`、`||`、`|`、`|&`，也不插入 shell continuation 符号。
- 展示逻辑只影响 TUI，不改写传给 execute 的 command、tool result、LLM context 或 session 内容。

这样可以删除额外的 Bash parser 依赖，并避免为展示目的维护一套 shell 语法兼容层。collapsed/header 场景继续使用现有的轻量扫描和语义摘要。

### 14.2 目标体验

原始命令：

```text
git diff --stat -- extensions/compact-tool-ui; printf '\n--- new files ---\n'; find extensions/compact-tool-ui/components -maxdepth 1 -type f -name 'expanded-*.ts' -o -name 'line-numbered-code-block.ts' -o -name 'tool-detail-footer.ts' | sort
```

在 expanded 视图中保持同一条命令，只在终端宽度不足时进行视觉换行：

```text
  ├─ command
  │  git diff --stat -- extensions/compact-tool-ui; printf '\n--- new files ---\n'; find extensions/compact-tool-ui/components -maxdepth 1 -type f -name 'expanded-*.ts' -o -name 'line-numbered-code-block.ts' -o -name 'tool-detail-footer.ts' | sort
```

展示规则：

- 不对顶层 shell operator 做结构化拆分。
- 不对参数、重定向、glob、command substitution 或 heredoc 做语义解释。
- 超宽物理行使用 ANSI-safe wrapping；换行仅是视觉换行，不改变命令文本。
- 多行命令保留原始物理行，不合并或重排 heredoc body。

### 14.3 实现架构

`format/bash-command.ts` 与 `format/bash-command-summary.ts` 继续服务 collapsed/header 场景；expanded command 直接把已 strip ANSI 的原始文本交给 `ShellCommandBlock`。

当前结构保持最小化：

```text
format/
  bash-command.ts                // collapsed / header 的 command-name 高亮
  bash-command-summary.ts        // collapsed 的语义摘要
components/
  shell-command-block.ts         // 原始命令的 ANSI-safe 视觉换行
```

`ShellCommandBlock` 不调用 shell parser，也不生成新的 command layout。`expandedBashResult()` 始终传入 `stripAnsi(rawCommand)`；Bash 的 execute 逻辑仍然委托 Pi 原始内置 tool。

### 14.4 复制、语义与渲染约束

无论 collapsed 还是 expanded，都必须满足：

- 原始字符顺序、空白、quote、escape 和物理换行不被改写。
- 不对命令参数做 unquote、重新引用、路径规范化或语义重排。
- 每个 TUI render line 不超过可用 width，且不会泄漏未闭合 ANSI / OSC 序列。
- 视觉换行不应被误解为可直接复制回 shell 的新命令；需要复制时应以后续的“复制原始 command”能力为准。

### 14.5 测试

测试重点调整为：

1. expanded Bash 保留复杂命令的原始文本。
2. 多行命令和 heredoc 保留原始物理行。
3. 48、64、80、120 列宽下 ANSI-safe wrapping 不溢出。
4. collapsed summary、运行状态、错误输出和 expanded detail rail 不依赖额外 shell parser。
