# compact-tool-ui

为 Pi 的 `bash` / `read` / `write` / `edit` 与顶层 `codemode` 提供紧凑行和展开详情轨道（detail rail）。五个工具均通过 `pi.registerToolRenderer()` 定制展示，不注册工具、不包装执行，也不改变工具激活集合、模型收到的结果或会话存储。

## 使用

目标宿主与开发依赖为 **Pi 1.3.0**，需要 `registerToolRenderer` API。这是独立 Pi package，通过 `package.json` 的 `pi.extensions` 加载；Pi core / TUI 使用宿主提供的 peer dependencies，Bash 展示不依赖外部 shell parser。

首次开发或依赖更新后安装本扩展的检查依赖，再从仓库根目录临时加载（依赖与 lockfile 不同步时重新运行 `npm ci`）：

```bash
(cd extensions/compact-tool-ui && npm ci)
pi -e ./extensions/compact-tool-ui
```

开发验证：在 `extensions/compact-tool-ui` 运行 `npm run check`（类型检查与测试）。

也可将本目录的绝对路径加入个人 Pi `settings.json` 的 `extensions` 数组。仅排查本扩展的四个文件 / Shell 工具时可用 `pi --no-extensions -e ./extensions/compact-tool-ui`；该选项也会禁用内置 Codemode 扩展，不能据此检查 Codemode 展示。本扩展不负责启用 Codemode。

## 当前展示

| 工具 | 折叠态 | 展开态 |
| --- | --- | --- |
| `bash` | 所有状态只有一条 header：命令摘要、输出语义摘要或失败类别、运行中 timeout、可用耗时与截断标记；没有正文输出预览 | 原始命令与当前可用输出、截断信息、完整输出路径 |
| `read` | 路径、可选范围；仅截断、用户 limit 提前结束或图片等情况补 metadata，不显示正文 | 文件正文、高亮、真实行号、continuation / 截断 footer；图片由宿主展示 |
| `write` | 路径、行数与 UTF-8 大小，不显示正文 | 写入参数中的内容；失败时先显示错误，再显示 attempted content |
| `edit` | 路径和 diff stat；默认 64 行以内 diff 内联，超限仅 header | 完整可用 diff；失败时显示原始错误 |
| `codemode` | 一条父行，统计实际调用摘要中的工具名和次数，分开表达脚本与子调用状态 | 调用摘要、JavaScript、脚本输出 / 错误、图片摘要及可用的完整输出路径 |

- 长命令和文件路径采用约 64 字符预算的中间省略；路径优先保留头部目录和末尾文件名。终端实际宽度仍由组件测宽处理。
- `read` / `write` / `edit` 失败时只保留一行 compact reason，不增加下一行 hint；完整诊断靠展开。
- 展开 / 收起沿用宿主 `app.tools.expand` 快捷键，提示按当前键位生成。
- Bash 展开运行中最多保留最后 28 个逻辑行 / 28 个视觉行，结束后展示完整当前可用输出，不恢复工具已截掉的内容；无可信来源的历史耗时不编造，低于 1s 不显示。
- 展开命令保留原始结构，只在显示层清理控制序列、将 Tab 展开为 3 个空格并视觉换行；带 guide / 视觉换行的文本不保证可直接复制回 Shell。

## 设置

在 TUI 中运行 `/compact-tool-ui-settings`，只有两个配置项：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `renderShell` | `"self"` | 无外框，但仍按宿主 `outputPad` 缩进；`"default"` 为 header 与 result 共用一个 Box，额外带状态背景与上下留白 |
| `edit.inlineDiffMaxLines` | `64` | 内联 diff 的总逻辑行阈值（不是仅增删行数）；`0` 不限，`-1` 为 `never`，从不内联 |

面板提供 `never` / `0` / `16` / `32` / `64` / `128` 预设，也保留手写的非预设值。JSON 中有限数值向下取整，负数统一为 `-1`。

```json
{
  "compactToolUi": {
    "renderShell": "self",
    "edit": { "inlineDiffMaxLines": 64 }
  }
}
```

配置按 **内置默认值 ← 全局 ← 项目** 逐字段覆盖，缺字段继承：

- 全局：当前 agent 目录的 `settings.json`，默认 `~/.pi/agent/settings.json`，目录可由 `PI_CODING_AGENT_DIR` 覆盖。
- 项目：`<cwd>/.pi/settings.json`（目录名跟随 Pi 的 `CONFIG_DIR_NAME`），可以只写 `{"compactToolUi":{"edit":{"inlineDiffMaxLines":32}}}` 来覆盖单个字段。

项目层只在 `ctx.isProjectTrusted()` 为真时读取为有效值。未信任时忽略该层并提示，面板仅允许全局层；扩展加载先读全局，`session_start` 再叠加可信项目值。支持带 UTF-8 BOM 的文件；读取失败按层提示路径和原因，坏层在面板中只读，不阻断正常层，修复文件后重开面板恢复编辑。

面板编辑的是 `Settings scope` 所选层的原值；行说明另显示 `Effective` 生效值、`source` 来源（global / project / built-in）、待保存状态和项目覆盖提示。项目层选 `inherit`、全局层选 `unset` 会删除该层键以恢复继承。生效值只采用已读取或成功提交的值，不提前应用排队中的编辑。

| 按键 | 行为 |
| --- | --- |
| `↑` `↓` | 移动光标（遵循宿主选择键位） |
| `←` `→` | 前后循环取值；scope 行切换层 |
| `Enter` `Space` | 下一档，包含 `inherit` / `unset` 回退档 |
| `Tab` | 在可信项目中切换 global / project 层 |
| `Backspace` `Delete` | 清掉当前行在当前层的键 |
| `Esc` | 关闭面板，不撤销已保存的改动 |

面板不做模糊搜索。切换 scope 不创建文件；值成功落盘后立即热应用，已有行也可切换布局且保持展开 / 收起正常。宿主实际 `renderShell` 始终为 `self`，同名配置只控制共享展示组件。

保存使用与宿主兼容的文件锁，锁内重读最新文件，只 patch 本批实际编辑的字段；同时清理所选层旧 Bash 键，保留其他字段与未知键。成功后同步该层最新值，保存期间的新编辑继续排队；失败只回滚失败层未保存的编辑，不丢弃另一层的待办。采用临时文件原子替换，Windows 锁冲突有限重试；失败不降级为原地覆写。面板不监听其他窗口的文件变化，重开 / reload 或下次保存时再读取最新值。

## 限制与边界

- 不改变宿主 `shellPath` / `shellCommandPrefix`、图片缩放、工具 schema / description / exposure，或 access-control、sandbox、remote execution/filesystem、audit 扩展的执行定义。其他扩展也注册同名 renderer 时，展示优先级遵循 Pi resolver 链。
- Codemode 的 `details.calls` 只有可能被截断的参数预览、状态、耗时、错误与可选费用，不含子工具完整输出或 Edit diff；本扩展不采集嵌套事件、不新增子结果存储，也不静态解析脚本猜调用。
- 原始图片只由宿主按图片设置和终端能力渲染。print / JSON / RPC 等非 TUI 模式不会打开设置面板，也不因本扩展替换工具执行。
- 独立 `grep` / `find` / `ls` renderer 尚未实现；Bash 中识别这些命令的摘要不等于支持同名工具。
- 迁移：旧 Bash 预览键即使启用也不生效，成功输出摘要恒开。加载从不写配置；仅面板显式保存时清理所选层旧键，不自动修改已安装副本。旧键清单见[兼容说明](docs/compact-tool-ui-design.md#兼容说明)。

完整展示规则、组件边界和验收约束见 [compact-tool-ui-design.md](docs/compact-tool-ui-design.md)。
