# git-worktree

在 Pi 中创建 git worktree，或从列表中重新打开已有 worktree，并（按你的选择）在 **Windows Terminal 新标签页**里启动一个以该 worktree 为工作目录的全新 Pi 会话。

解决现有 `git-worktree` **skill** 做不到的一步：skill 只负责「创建」然后丢给你一句 `Next: cd <path>`；这个扩展能更进一步，帮你**真正切换进去工作**。

## 命令

### `/worktree`

不带参数时，弹出统一选择列表：

- 选择已有 worktree：请求在 Windows Terminal 新标签页中打开，并自动启动全新的 Pi 会话；当前所在 worktree 会标记为 `[current]`，locked worktree 会标记为 `[locked]`。
- 选择 **Create new worktree...**：输入分支名后进入创建预览流程，默认提示名为 `当前分支-worktree`，直接回车即可采用。
- 如果发现 stale worktree 元数据，会显示 **Prune stale worktrees...**；清理前会再次确认。

创建 worktree 或请求打开 Windows Terminal 期间会显示带动画的 spinner；成功提示表示启动命令已提交，不代表已经确认标签页可见。

### `/worktree <分支名>`

直接传入分支名可跳过选择列表创建新 worktree，支持 `feature/foo` 这类带 `/` 的分支名；创建前可通过对话框里的 **Rename** 改名。分支名会先经过 Git 格式校验。

创建前会检查目标分支是否已被其他 worktree 占用；如果已占用，可选择打开已有 worktree、换一个分支或取消。

目标目录如果已经存在但不是合法 worktree，不会自动删除，而是要求换一个分支；合法但已存在的 worktree 则可直接打开。

流程：

1. 校验当前处于 git 仓库（否则报错）。
2. 若已在 linked worktree 内，先确认是否再建。
3. 工作树有未提交改动时，会在预览对话框标题中给出 **dirty 警告**，选择任一个 Create 选项即视为知情继续（不自动带改动走）。
4. **创建前预览**对话框（创建流程中的确认对话框，避免额外的创建后弹框），可选择：
   - **Create & open in WT** —— 创建并自动在 Windows Terminal 打开
   - **Create only** —— 只创建，不开
   - **Rename** —— 输入你自己的分支名后重新预览（可反复改名）
   - **Cancel** —— 取消，不创建
5. `git worktree add` 创建到 **Pi 家目录**下：
   ```
   ~/.pi/worktrees/<仓库名>/<分支>
   ```
   - `<仓库名>` 取仓库根目录的目录名，用来隔离不同仓库的同名分支。
   - 分支/仓库名中 `/` `\` `:` `@` 等路径不安全字符替换为 `-`。
   - 家目录跟随 `PI_CODING_AGENT_DIR`：设置时取它的**父目录**，否则 `~/.pi`。
   - worktree 不再落在仓库内部，因此**无需** `.gitignore` 条目。
   - 示例：仓库 `D:/code/pi-kit` + 分支 `feature/foo` → `~/.pi/worktrees/pi-kit/feature-foo`。
6. 分支已存在但尚未被其他 worktree 占用时，直接复用该分支（不加 `-b`）；否则以当前分支（detached 时为 `HEAD`）为基点新建分支。
7. 创建后的结果用一条非阻塞通知提示；选择了 **Create & open** 时，会请求在 Windows Terminal 新标签页以该目录为**起始目录打开 Git Bash** 并自动启动全新 Pi 会话（请求失败则打印 `cd <path> && pi` 手动命令）；**Create only** 则打印进入命令。

> 本扩展**不提供删除/清理**（`git worktree remove` 等交给 git 命令处理，超出范围）。

## 环境要求

- Windows + Windows Terminal（检测 `WT_SESSION`），且已配置一个 **Git Bash** profile。
- profile 从 WT `settings.json` 自动挑选：优先未隐藏、`source: "Git"` 的条目；`commandline` 指向
  已不存在路径的失效 profile 会被跳过（否则分屏/duplicate pane 会报 `0x80070002`，见
  [`docs/wt-interactive-launch-notes.md`](docs/wt-interactive-launch-notes.md) 坑 6）。
- 启动 WT 标签页的方式（App Execution Alias、cmd 引号、profile 选择等）见
  [`docs/wt-interactive-launch-notes.md`](docs/wt-interactive-launch-notes.md)（踩坑与最佳实践）。
- 新标签页用 Git Bash profile 打开，通过 `--startingDirectory` 定位到 worktree 目录，并运行 `bash -c "exec pi"` 自动启动 Pi。
- `wt.exe` 是 Windows 的 App Execution Alias，通过 `cmd start` 按 PATH 解析启动；若自动打开失败，会降级打印 `cd <path> && pi` 手动命令。
- 其他平台（Linux/macOS/WSL）：不支持自动开终端，命令回退到打印手动进入命令。首版只做 Windows。

## 与会话

- 新开启的 Pi 是**全新会话**，不会延续当前对话上下文；worktree 被当作独立的隔离工作场。
- Pi 的会话按工作目录组织，`~/.pi/agent/sessions/` 会自动把 worktree 下的临时会话归档到 worktree 目录名下。

## 与 `git-worktree` skill 的关系

| | skill（`~/.agents/skills/git-worktree`） | 本扩展 |
|---|---|---|
| 形态 | 文字剧本，LLM 手动敲 git | `/worktree` 命令 |
| 创建 | ✅（逐条交互） | ✅（命令内自动 + 交互确认） |
| 切换进入 | ❌（只提示 `cd`） | ✅（新 WT 标签启动 Pi） |
| 位置/命名 | 检测既有约定，否则 `.worktrees/` | 固定 `<pi 家目录>/worktrees/<仓库名>/<分支>`（路径不可配，家目录跟随 `PI_CODING_AGENT_DIR`） |
| 删除清理 | ✅ | ❌（范围外） |

两者**互补不重复**：skill 是兜底文字剧本（无扩展时 LLM 仍能建），扩展是程序化入口 +「进入」能力。**注意**：扩展的创建位置已改为 Pi 家目录，与 skill 的 `<repo-parent>/.worktrees/` 约定不再一致（skill 侧未同步改动）。

## 开发

```bash
npm install
npm run check   # tsc --noEmit + node --test
```

源码在 `src/core.ts`（无 `ExtensionAPI` 依赖，可用临时 git 仓库做单元测试），入口 `index.ts` 注册命令。