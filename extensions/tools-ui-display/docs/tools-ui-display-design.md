# Pi Tools UI 展示优化设计草案

> 状态：MVP v0 已实现为扩展初版，后续已加入 `edit` compact renderer，并统一 `read` / `write` / `edit` 的 compact error/hint  
> 目录：`extensions/tools-ui-display/`  
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

失败时默认展示足够有用的错误尾部或错误原因，而不是只显示失败状态，也不是无差别展示完整输出。

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

失败时即使不展开，也应能看到关键错误：

```text
bash pnpm test                                  exit 1 · 8.4s
FAIL src/foo.test.ts
Expected: 1
Received: 2
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
write extensions/foo/index.ts                   214 lines · 6.8 KB
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
- collapsed + failure：展示关键错误尾部。
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

失败态统一使用 compact reason；如果存在明确、低噪音、可执行的修复建议，则在下一行显示 compact hint：

```text
read src/missing.ts                              path not found
  ╰─ check file path
write src/secret.ts                              permission denied
  ╰─ check file permissions
edit src/config.ts                               oldText not found
```

hint 文案使用动词短语，不加句号；无法给出明确行动建议时不显示 hint。

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
read src/large.ts                                truncated
```

MVP v0 不设置小文件例外：所有成功 `read` 在 collapsed 状态默认不展示正文；普通文本读取不显示行数，用户展开后再看正文。后续如果反馈过于安静，再讨论小文件直出阈值。

### expanded 展示

沿用当前 read renderer：

- 语法高亮。
- 最多/完整展示行逻辑。
- truncation 警告。
- image fallback。

### 错误态

显示错误原因：

```text
read src/missing.ts                              path not found
  ╰─ check file path
```

## 5.2 bash

### 当前倾向

`bash` 是最容易刷屏的 tool。成功时默认应该非常克制，失败时默认展示关键错误。多行命令，尤其是 `python3 - <<'PY'` 这类 heredoc，在 collapsed 状态下也会造成大量噪音，因此命令本身也需要一行摘要化。

### running 状态

```text
bash npm test                                   running · 4.1s
bash sleep 10                                   timeout 30s · running · 4.1s
bash npm test                                   2 lines so far · 4.1s
bash python3 heredoc                            31 lines · 1.3 KB · 2 lines so far · 4.1s
```

MVP v0 默认在运行中只更新 header 状态；如果已有输出，则显示已输出行数。调用参数提供 `timeout` 时，在 collapsed metadata 中显示 `timeout Ns`。tail preview 作为可选能力，可配置显示最后 N 行。多行 / heredoc / 长命令在 collapsed 状态下始终压缩为一行命令摘要。

### success collapsed

```text
bash npm test                                   38 output lines · 12.4s
bash python3 heredoc                            110 lines · 4.1 KB · 8 output lines · 0.8s
bash shell script with python heredoc           62 lines · 2.0 KB · 0.3s
```

成功时默认仍不展示正文；如有输出，则在摘要中补充输出摘要，并将耗时放在 metadata 最后。普通命令显示 `N output lines`；`rg` / `grep` 显示 `N matches`（可推断时补充 `M files`）；带 `-A` / `-B` / `-C` context 的 `rg` / `grep` 显示 `N search lines`；`find` / `rg --files` 显示 `N paths`；`find ... | wc -l` 显示 `N files`；纯 `ls` 显示 `N entries`，但 `ls && ...` / `ls; ...` 等混合命令降级为普通 output lines。语义化命令空输出时显示 `no matches` / `no paths` / `empty`；普通命令无输出时只显示耗时。用户展开后再看完整输出和完整命令。

### error collapsed

```text
bash pnpm build                                 exit 1 · 9.7s
src/app.ts:42:13 - error TS2322: ...

bash python3 heredoc                            73 lines · 2.8 KB · exit 1 · 0.4s
Traceback (most recent call last):
...
```

失败时默认展示最后 8-12 行，优先展示错误尾部；命令仍保持一行摘要。

### expanded

展示完整当前可用 output，并保留：

- truncation 信息。
- full output path。
- took / elapsed。

## 5.3 edit

### 当前倾向

`edit` 是文件变更类 tool，默认不应完全静默；但大 diff 也不应刷屏。当前策略是：64 行以内 diff collapsed 直接展示，大 diff collapsed 只保留一行摘要，展开后看完整 diff。`toolsUiDisplay.edit.inlineDiffMaxLines` 可以调整阈值，设为 `0` 时不限制行数。

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
write extensions/foo/index.ts                   214 lines · 6.8 KB
```

如果能区分新建与覆盖：

```text
create extensions/foo/index.ts                  214 lines · 6.8 KB
overwrite src/app.ts                            380 lines · 12.1 KB
```

### 小文件例外

MVP v0 不设置小文件例外：所有成功 `write` 在 collapsed 状态默认只展示摘要；用户展开后再看写入内容。后续如果反馈过于安静，再讨论行数 / 字节数阈值。

### error collapsed

显示精简错误；有明确修复方向时显示一行 compact hint：

```text
write src/generated.ts                          permission denied
  ╰─ check file permissions
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
| `bash` 失败时默认展示多少行 tail | 10 行 |
| `write` 成功时是否默认显示正文 | 不显示正文，只显示摘要 |
| `read` 成功时是否默认显示正文 | 不显示正文，只显示摘要 |
| 是否加状态符号 | 不加状态符号，状态由 metadata / error reason / 颜色上下文承担 |
| Header 元信息是否右对齐 | MVP 不做右对齐，使用 inline metadata |

### 6.3 MVP v0 展示规则

#### bash

- running：显示 `bash <command summary> · running · <elapsed>`；如果已有输出，则切换为 `bash <command summary> · <n> lines so far · <elapsed>`。
- running：默认不展示 tail preview；可通过配置开启最后 N 行 preview。
- timeout：调用参数提供 `timeout` 时，在 collapsed metadata 中显示 `timeout Ns`。
- collapsed command：短单行命令原样显示；`rg` / `grep` / `find` / 纯 `ls` 使用语义 label，例如 `rg /pattern/ in path`、`find *.ts in .`、`ls src`；长单行命令截断但不额外显示字符数；多行命令压缩为 `shell script · N lines · size`；Python heredoc 压缩为 `python3 heredoc · N lines · size`。
- success collapsed：只显示摘要，例如 `bash pnpm test · 38 output lines · 12.4s` 或 `bash python3 heredoc · 110 lines · 4.1 KB · 0.8s`。
- success collapsed：普通命令无输出时只显示耗时；有输出时补充摘要并将耗时放在最后。普通命令使用 `N output lines`；`rg` / `grep` 使用 `N matches`，带 context 时使用 `N search lines`，空输出使用 `no matches`；`find` / `rg --files` 使用 `N paths`，`find ... | wc -l` 使用 `N files`，空输出使用 `no paths`；纯 `ls` 使用 `N entries`，空输出使用 `empty`，混合 `ls` 命令降级为普通 output lines。
- error collapsed：显示 `bash <command summary> · exit <code> · <duration>`，并展示最后 10 行输出。
- expanded：委托原始 renderer，展示完整当前可用输出、完整命令、截断信息和 full output path。

#### write

- success collapsed：只显示摘要，例如 `write src/generated.ts · 214 lines · 6.8 KB`。
- 不设置小文件例外。
- error collapsed：显示 compact reason；有明确修复方向时显示 compact hint，例如 `write src/generated.ts · permission denied` + `check file permissions`。
- expanded：委托原始 renderer，展示写入内容预览和语法高亮。

#### read

- success collapsed：普通文本只显示路径，例如 `read src/index.ts`。
- 带范围时显示 `path:start-end`；截断时显示 `truncated`。
- 不设置小文件例外。
- error collapsed：显示 compact reason；有明确修复方向时显示 compact hint，例如 `read src/missing.ts · path not found` + `check file path`。
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
   - 失败默认 tail。
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
8. [x] 通用 compact error / hint 文案统一（read / write / edit）。
9. 截断、full output、耗时格式统一。

## 8. 可能的配置项

当前 `toolsUiDisplay` 设置只保存到全局 `~/.pi/agent/settings.json`，不再读取或写入项目级 `.pi/settings.json`。已有 `bash` 预览、`edit.inlineDiffMaxLines` 和 `renderShell` 等配置。后续可考虑：

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

当前 MVP v0 已采用扩展方式落地于 `extensions/tools-ui-display/index.ts`：

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
- 失败的 `bash` 不展开也能看到关键错误。

### 展开体验

- 展开后能看到原先可见的关键内容。
- 截断说明仍然可见。
- full output 路径仍然可见。

### 安全性 / 兼容性

- 不改变 tool execute 语义。
- 不改变返回给 LLM 的 tool result 内容。
- 覆盖内置 tool 时保持 details shape 兼容。
- 在非 interactive 模式下不影响执行结果。

