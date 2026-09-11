# compact-tool-ui

这是一个用于讨论和实现 pi tools UI 展示优化的扩展工作目录。

当前状态：**MVP v0 与 Expanded v1（`bash` / `read` / `write` / `edit` detail rail）已实现**，并包含 Expanded Bash 原始命令展示、ANSI-safe 换行与 truncation 细节增强。`index.ts` 仅在 TUI session 中覆盖内置 `bash` / `write` / `read` / `edit` 的 renderer，执行逻辑仍委托原始内置 tool；并使用 `renderShell: "self"` 去掉默认 Box/cell 背景与内边距，降低视觉噪音。

## 目标

优化 pi 内置 tools 在 TUI 中的展示方式，使其：

1. 默认更紧凑，减少滚屏噪音。
2. 状态更清晰，便于快速判断 tool 正在做什么、是否成功、是否失败。
3. 失败和截断场景保留足够诊断信息。
4. 详细内容通过 expand 查看，而不是默认铺满会话。

## 文档

- [docs/compact-tool-ui-design.md](docs/compact-tool-ui-design.md)：当前讨论沉淀的设计草案。

## 后续实现方向

MVP v0 优先从最容易造成噪音的内置工具开始：

1. `bash`：成功只显示命令摘要、输出摘要和耗时，耗时统一放在 metadata 最后且低于 1s 不展示；多行 / Python heredoc / 长命令默认压缩成一行；`timeout` 只在运行中显示在 collapsed metadata 中，命令结束后移除（`timeout` / `aborted` 结果仍由 result summary 表达）；内容行数 ≤ 2 的普通命令直接显示首行内容（如 `bash echo hi · hi`），行数 ≥ 3 用 `NL` 计数（如 `50L`），计数只算非空行，输出被内置限制截断时追加 `truncated` 标记；`rg/find/ls` 等常见命令输出会显示 `matches` / `paths` / `entries` 语义摘要，空结果显示 `no matches` / `no paths` / `empty`，`git diff` / `git status --short` 空结果显示 `no changes` / `clean`；失败显示 10 行 tail，running 显示已输出行数（`NL so far`）和耗时。
2. `write`：成功只显示路径、行数和大小（`write src/generated.ts · 214L · 6.8 KB`），展开后看写入内容。
3. `read`：普通文本成功只显示路径和可选行号范围；截断时显示 `2000/9000L`、用户 `limit` 提前结束时显示 `4900L more`，图片显示 mime；展开后看文件内容。
4. `edit`：64 行以内 diff 默认 inline 展示，大 diff 只显示路径和 diff stat，展开后看完整 diff；失败时显示精简错误。

Expanded v1：展开 `bash` / `read` / `write` / `edit` 时使用统一 detail rail、完整命令/内容/diff、行号、高亮、streaming tail、截断与 continuation footer；Bash 命令保留原始文本，仅进行 ANSI-safe 视觉换行。

后续再扩展到：

- `grep`
- `find`
- `ls`

## 扩展规范说明

本目录按 pi package 规则提供 `package.json` 中的 `pi.extensions` manifest，因此可以作为目录扩展加载。运行时导入的 pi 包声明在 `peerDependencies`，避免把 pi core / TUI 作为普通依赖打包；Bash 展示不依赖额外运行时 parser。

## 设置

通过命令打开全局设置 UI：

```text
/compact-tool-ui-settings
```

可配置项包括：

- `Tool render shell`：`self` 保持当前无外框 compact 行；`default` 使用 pi 原本 boxed shell / padding / 背景，更接近展开后的原生外观。
- Bash running tail preview / success tail preview / preview lines / success output summary。
- Edit inline diff max lines：默认 `64`，设为 `0` 时所有 diff 都在 collapsed 视图 inline 展示。

配置只写入 Pi 当前 agent 目录（默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 覆盖）中的 `settings.json` 的 `compactToolUi`：

```json
{
  "compactToolUi": {
    "renderShell": "default",
    "bash": {
      "runningTailPreview": false,
      "successfulTailPreview": true,
      "previewLines": 5,
      "successfulOutputSummary": true
    },
    "edit": {
      "inlineDiffMaxLines": 64
    }
  }
}
```

`renderShell` 默认值是 `self`。

实现上遵循内置 tool override 约束：

- `bash` / `write` / `read` / `edit` 在扩展加载时通过同名 `pi.registerTool()` 覆盖内置 renderer。当前 Pi 运行时中，将同名覆盖延后到 `session_start` 会在 `/reload` 后丢失，因此此处预注册。
- `execute` 始终委托原始内置 tool definition，不改变 tool 执行语义。
- 通过 `...original` 保留内置 schema、description、prompt metadata 和 result shape。
- collapsed 视图使用 compact renderer；expanded 的 `bash` / `read` 使用统一 detail rail，`write` / `edit` 保留原始 renderer 作为兼容路径。
- `read` / `write` / `edit` 失败时使用 compact error reason；有明确修复方向时显示一行 compact hint。
- 默认 `renderShell: "self"` 去掉默认 Box/cell 背景与内边距；可在设置里切到 `default`，让 tool 行使用 pi 原本外层 shell。
- settings 命令只在 TUI 中调用 `ctx.ui.custom()`；print / JSON / RPC 等非 TUI 模式不会打开自定义组件，也不会覆盖内置工具。

## 运行方式

这是一个独立的 Pi package。首次使用或依赖更新后，先安装本扩展用于类型检查和测试的开发依赖：

```bash
cd extensions/compact-tool-ui
npm ci
cd ../..
```

然后可以用临时扩展方式测试：

```bash
pi -e ./extensions/compact-tool-ui
```

如果本地 `node_modules` 尚未和 `package-lock.json` 同步，重新执行上面的 `npm ci` 即可。Expanded Bash 始终保留原始命令文本，不依赖外部 shell parser。

在 TUI 中，如果已有其他覆盖内置 `read` / `bash` / `write` / `edit` 的扩展，仍可能发生 tool name conflict。尤其是 access-control、sandbox、remote execution/filesystem、audit 类扩展也通过同名 tool override 改写执行语义时，请优先单独加载本扩展，或确保这类安全/远程扩展在本扩展之后加载并成为最终 override。

当前仓库里已有 `extensions/collapse-read` 时，可以先用 `--no-extensions` 只加载本扩展测试：

```bash
pi --no-extensions -e ./extensions/compact-tool-ui
```

如果需要项目级自动加载，可以后续迁移或链接到 `.pi/extensions/compact-tool-ui/`。
