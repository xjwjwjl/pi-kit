# git-worktree

在 Pi 中创建 git worktree，并（按你的选择）在 **Windows Terminal 新标签页**里启动一个以该 worktree 为工作目录的全新 Pi 会话。

解决现有 `git-worktree` **skill** 做不到的一步：skill 只负责「创建」然后丢给你一句 `Next: cd <path>`；这个扩展能更进一步，帮你**真正切换进去工作**。

## 命令

### `/worktree [分支名]`

创建 worktree，默认分支名由当前分支派生（`main` → `main-worktree`、`feature/foo` → `feature/foo-worktree`），也可显式传分支名。

流程：

1. 校验当前处于 git 仓库（否则报错）。
2. 若已在 linked worktree 内，先确认是否再建。
3. 工作树有未提交改动时，会在预览对话框标题中给出 **dirty 警告**，选择任一个 Create 选项即视为知情继续（不自动带改动走）。
4. **创建前预览**对话框（整个流程唯一的对话框，避免连续弹框闪屏），可选择：
   - **Create & open in WT** —— 创建并自动在 Windows Terminal 打开
   - **Create only** —— 只创建，不开
   - **Rename** —— 输入你自己的分支名后重新预览（可反复改名）
   - **Cancel** —— 取消，不创建
5. `git worktree add` 创建到仓库根目录下：
   ```
   <repo 根目录>/.worktrees/<分支>
   ```
   （分支中 `/` `\` `:` `@` 等路径不安全字符替换为 `-`；`.worktrees/` 已加入根 `.gitignore`）
6. 创建后的结果用非阻塞通知提示；选择了 **Create & open** 时，会在 Windows Terminal 新标签页以该目录为**起始目录打开 Git Bash** 并自动启动全新 Pi 会话（打不开则打印 `cd <path> && pi` 手动命令）；**Create only** 则打印进入命令。

### `/worktree --list`

只读列出当前仓库已存在的 worktree（路径 + 分支）。用于决定是复用已有 worktree 还是新建。

> 本扩展**不提供删除/清理**（`git worktree remove` 等交给 git 命令处理，超出范围）。

## 环境要求

- Windows + Windows Terminal（检测 `WT_SESSION`），且已配置一个 **Git Bash** profile。
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
| 形态 | 文字剧本，LLM 手动敲 git | `/worktree` / `/worktree --list` 命令 |
| 创建 | ✅（逐条交互） | ✅（命令内自动 + 交互确认） |
| 切换进入 | ❌（只提示 `cd`） | ✅（新 WT 标签启动 Pi） |
| 位置/命名 | 检测既有约定，否则 `.worktrees/` | 固定 `.worktrees/` 约定（首版不可配） |
| 删除清理 | ✅ | ❌（范围外） |

两者**互补不重复**：skill 是兜底文字剧本（无扩展时 LLM 仍能建），扩展是程序化入口 +「进入」能力。创建约定一致，避免行为漂移。

## 开发

```bash
npm install
npm run check   # tsc --noEmit + node --test
```

源码在 `src/core.ts`（无 `ExtensionAPI` 依赖，可用临时 git 仓库做单元测试），入口 `index.ts` 注册命令。