# Bash TUI 展示优化 TODO

## 目标
- 为 `bash` 成功态增加轻量摘要
- 为 `bash` running 态增加可选 tail preview
- 保持 expanded 模式继续回退到内置 renderer
- 默认行为保持 compact、低刷屏

## 默认策略
- `successfulOutputSummary: true`
- `runningTailPreview: false`
- `previewLines: 2`

## 实现任务清单

### 1. 定义 Bash 展示配置
- [x] 在 `renderers/bash.ts` 附近定义 `BashDisplayOptions`
- [x] 配置字段：
  - [x] `successfulOutputSummary?: boolean`
  - [x] `runningTailPreview?: boolean`
  - [x] `previewLines?: number`
- [x] 定义默认配置常量
- [x] 决定配置注入方式：
  - [x] 方案 A：`registerCompactBash(pi, cwd, options?)`
- [x] 不需要同步更新 `index.ts`

### 2. 抽取 Bash 输出摘要 helper
- [x] 修改 `renderers/bash-helpers.ts`
- [x] 新增 `hasMeaningfulOutput(output: string): boolean`
  - [x] 基于 `stripAnsi(output).trim()` 判断
- [x] 新增 `summarizeSuccessfulBashOutput(output: string): string | undefined`
  - [x] 空输出 => `undefined`
  - [x] 单行输出 => `1 line output`
  - [x] 多行输出 => `N lines output`
- [x] 新增 running preview helper
  - [x] 采用 `previewTail(output: string, maxLines: number): string`

### 3. 成功态 header 增加轻量摘要
- [x] 修改 `renderers/bash.ts` 的 success 分支
- [x] 保持当前：成功 collapsed 不展示正文
- [x] 仅在 `successfulOutputSummary === true` 时，在 header metadata 中拼接成功摘要
  - [x] 无输出 => 只显示 duration
  - [x] 有输出 => `duration + output summary`
- [x] 当 `successfulOutputSummary === false` 时，保持当前效果
  - [x] `✓ bash npm test · 12.4s`
- [x] 目标效果：
  - [x] `✓ bash npm test · 12.4s · 38 lines output`
  - [x] `✓ bash echo hi · 0.1s · 1 line output`
- [x] expanded 模式继续走 `original.renderResult`

### 4. running 态增加可选 tail preview
- [x] 修改 `renderers/bash.ts` 的 partial/running 分支
- [x] 保持当前 header：
  - [x] 无输出时 `running · <elapsed>`
  - [x] 有输出时 `<n> lines streamed · <elapsed>`
- [x] 当满足以下条件时展示 preview 正文：
  - [x] `options.isPartial === true`
  - [x] `!context.isError`
  - [x] `!options.expanded`
  - [x] `runningTailPreview === true`
  - [x] output 非空
- [x] preview 内容规则：
  - [x] strip ANSI
  - [x] 去掉末尾空行
  - [x] 取最后 `previewLines` 行
- [x] 返回 `Text` 组件展示 preview
- [x] 若 preview 为空，继续返回 `emptyComponent()`
- [x] expanded 模式仍交给内置 renderer

### 5. 统一 metadata 拼接顺序
- [x] 明确成功态 metadata 顺序
  - [x] 推荐：`· 12.4s · 38 lines output`
- [x] 明确 running 态 metadata 顺序
  - [x] 推荐：`· 12 lines streamed · 4.1s`
- [x] 确认 `mutedMetadataText()` 足够复用，无需新增样式函数

### 6. 处理边界情况
- [x] 空白输出不应显示 `1 line output`
- [x] 只有换行或空格的 partial output 不应触发 preview
- [x] success summary 不应影响错误态 tail 展示逻辑
- [x] preview 不应影响错误态 tail 展示逻辑
- [x] preview 不应改变现有 interval / invalidate 生命周期

### 7. 测试：helpers
- [x] 修改 `test/bash-helpers.test.ts`
- [x] 新增 `hasMeaningfulOutput()` 用例
  - [x] `""` => false
  - [x] `"\n  \n"` => false
  - [x] `"ok\n"` => true
- [x] 新增 `summarizeSuccessfulBashOutput()` 用例
  - [x] 空输出 => `undefined`
  - [x] 单行输出 => `1 line output`
  - [x] 多行输出 => `N lines output`
- [x] 新增 running preview/tail helper 用例
  - [x] `a\nb\nc\n` + 2 => `b\nc`

### 8. 测试：renderer smoke
- [x] 修改 `test/renderers-smoke.test.ts`
- [x] 新增“成功 summary 开启且有输出时，collapsed header 显示 output summary”用例
- [x] 新增“成功 summary 关闭时，collapsed header 不显示 output summary”用例
- [x] 新增“成功且空输出时，不显示 output summary”用例
- [x] 新增“running + preview 开启时，collapsed result 显示 tail preview”用例
- [x] 新增“running + preview 关闭时，collapsed result 不显示正文”用例
- [x] 新增“expanded + preview 开启时，仍回退内置 renderer”基础用例

### 9. 文档更新
- [x] 更新 `docs/tools-ui-display-design.md`
- [x] 调整 success collapsed 示例
  - [x] 从 `✓ bash npm test · 12.4s`
  - [x] 到 `✓ bash npm test · 12.4s · 38 lines output`
- [x] 调整 running 描述
  - [x] 默认不展示 tail preview
  - [x] 可通过配置开启最后 N 行 preview
- [x] 不需要额外补充入口配置示例

### 10. 验收清单
- [x] 成功态在不增加正文的前提下提供更多信息
- [x] running 态 preview 关闭时，视觉行为与当前版本基本一致
- [x] running 态 preview 开启时，不会明显破坏 compact 布局
- [x] expanded 模式行为不退化
- [x] 现有 bash 失败态 tail preview 保持不变
- [x] 所有测试通过

## 建议实现顺序
1. `renderers/bash-helpers.ts`
2. `renderers/bash.ts`
3. `index.ts`（如需透出配置）
4. `test/bash-helpers.test.ts`
5. `test/renderers-smoke.test.ts`
6. `docs/tools-ui-display-design.md`

## 首版范围建议
- 必做：`successfulOutputSummary`
- 必做：`runningTailPreview` + `previewLines`
- 延后：如后续需要，再讨论成功态内联摘要或更复杂模式
