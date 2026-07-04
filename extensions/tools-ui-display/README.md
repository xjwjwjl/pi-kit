# tools-ui-display

这是一个用于讨论和实现 pi tools UI 展示优化的扩展工作目录。

当前状态：**MVP v0 已实现为扩展初版，并已加入 `edit` compact renderer 与 compact error/hint 统一**。`index.ts` 仅在 TUI session 中覆盖内置 `bash` / `write` / `read` / `edit` 的 renderer，执行逻辑仍委托原始内置 tool；并使用 `renderShell: "self"` 去掉默认 Box/cell 背景与内边距，降低视觉噪音。

## 目标

优化 pi 内置 tools 在 TUI 中的展示方式，使其：

1. 默认更紧凑，减少滚屏噪音。
2. 状态更清晰，便于快速判断 tool 正在做什么、是否成功、是否失败。
3. 失败和截断场景保留足够诊断信息。
4. 详细内容通过 expand 查看，而不是默认铺满会话。

## 文档

- [docs/tools-ui-display-design.md](docs/tools-ui-display-design.md)：当前讨论沉淀的设计草案。

## 后续实现方向

MVP v0 优先从最容易造成噪音的内置工具开始：

1. `bash`：成功只显示命令摘要、输出摘要和耗时，耗时统一放在 metadata 最后；多行 / Python heredoc / 长命令默认压缩成一行；`timeout` 会显示在 collapsed metadata 中；`rg/find/ls` 等常见命令输出会显示 `matches` / `paths` / `entries` 语义摘要，空结果显示 `no matches` / `no paths` / `empty`；失败显示 10 行 tail，running 显示已输出行数和耗时。
2. `write`：成功只显示路径、行数和大小，展开后看写入内容。
3. `read`：普通文本成功只显示路径和可选行号范围；截断、图片等重要状态才显示摘要，展开后看文件内容。
4. `edit`：64 行以内 diff 默认 inline 展示，大 diff 只显示路径和 diff stat，展开后看完整 diff；失败时显示精简错误。

后续再扩展到：

- `grep`
- `find`
- `ls`

## 扩展规范说明

本目录按 pi package 规则提供 `package.json` 中的 `pi.extensions` manifest，因此可以作为目录扩展加载。运行时导入的 pi 包声明在 `peerDependencies`，避免把 pi core / TUI 作为普通依赖打包。

## 设置

通过命令打开全局设置 UI：

```text
/tools-ui-settings
```

可配置项包括：

- `Tool render shell`：`self` 保持当前无外框 compact 行；`default` 使用 pi 原本 boxed shell / padding / 背景，更接近展开后的原生外观。
- Bash running tail preview / success tail preview / preview lines / success output summary。
- Edit inline diff max lines：默认 `64`，设为 `0` 时所有 diff 都在 collapsed 视图 inline 展示。

配置只写入全局 `~/.pi/agent/settings.json` 的 `toolsUiDisplay`：

```json
{
  "toolsUiDisplay": {
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

- `bash` / `write` / `read` / `edit` 只在 `session_start` 且 `ctx.mode === "tui"` 时通过同名 `pi.registerTool()` 覆盖内置 renderer。
- `execute` 始终委托原始内置 tool definition，不改变 tool 执行语义。
- 通过 `...original` 保留内置 schema、description、prompt metadata 和 result shape。
- collapsed 视图使用 compact renderer；expanded 视图委托原始 renderer 保留细节。
- `read` / `write` / `edit` 失败时使用 compact error reason；有明确修复方向时显示一行 compact hint。
- 默认 `renderShell: "self"` 去掉默认 Box/cell 背景与内边距；可在设置里切到 `default`，让 tool 行使用 pi 原本外层 shell。
- settings 命令只在 TUI 中调用 `ctx.ui.custom()`；print / JSON / RPC 等非 TUI 模式不会打开自定义组件，也不会覆盖内置工具。

## 运行方式

可以用临时扩展方式测试：

```bash
pi -e ./extensions/tools-ui-display
```

在 TUI 中，如果已有其他覆盖内置 `read` / `bash` / `write` / `edit` 的扩展，仍可能发生 tool name conflict。尤其是 access-control、sandbox、remote execution/filesystem、audit 类扩展也通过同名 tool override 改写执行语义时，请优先单独加载本扩展，或确保这类安全/远程扩展在本扩展之后加载并成为最终 override。

当前仓库里已有 `extensions/collapse-read` 时，可以先用 `--no-extensions` 只加载本扩展测试：

```bash
pi --no-extensions -e ./extensions/tools-ui-display
```

如果需要项目级自动加载，可以后续迁移或链接到 `.pi/extensions/tools-ui-display/`。
