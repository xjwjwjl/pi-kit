# Windows Terminal 启动交互式程序 — 踩坑与最佳实践

> 本文记录在 `git-worktree` 扩展开发中，从 Pi（Node/Electron 环境、运行于 Git Bash）里
> **让 Windows Terminal（WT）新开标签页并启动一个交互式程序（如 pi）** 时踩过的坑，
> 以及逐一验证后的可靠做法。可作为本扩展未来维护，以及其他需要「开终端/进目录/启动
> 长驻程序」的扩展的参考。所有结论都在本机真实验证过（写 marker 文件确认命令确实执行）。

---

## 核心难点

需求：`wt.exe new-tab` 新开标签 → 在该标签里打开 **Git Bash**（用户期望的 shell）→ 让 bash
的**起始目录**指到某个 worktree → 自动运行一个**交互式**程序（`pi`）且不阻塞调用方。

这在一个环节上反复翻车：**`wt.exe` 是 App Execution Alias（0 字节重解析点），而 `cmd start`
对引号的再解析会导致 `--` 之后的复杂命令不执行。** 下面逐条记录。

---

## 坑 1：`wt.exe` 无法被 Node `spawn` 直接启动

**现象**：`spawn('C:\...\WindowsApps\wt.exe', ['new-tab', ...])` 报 `ENOENT`。
反斜杠路径在层层转义后变成 `C:Usersadmin...`，即使路径写对，App Execution Alias 也
**只能由 Windows 经 PATH 用 `CreateProcess` 解析**，Node `spawn` 给完整路径解析不了它。

**结论 / 可靠做法**：
- **不要**用 `spawn`/`execFile` 直接给 `wt.exe` 的完整路径。
- **用** `cmd` 的隐式 shell + 相对命令，让 `wt` 由 PATH 解析：

  ```js
  import { exec } from "node:child_process";
  exec(`start "" wt new-tab ...`, /* cmd 默认 shell */ (err) => {});
  ```

- 检测是否可用 `WT_SESSION`（在 WT 内才关心）。

---

## 坑 2：`cmd start` 会重解析 `--` 之后的命令引号，导致命令不执行

**现象**：`start "" wt new-tab --title t -- powershell -Command "Set-Content ..."`
**有时成功**。但一旦命令里出现：
- `&&`（被外层 cmd 当作 start 之后的第二条命令 → 外层去跑长命程序 → 调用方挂起）；
- 命令内含**内层引号**（`cd "...path..." && pi`）、`$PWD`、重定向嵌套：

WINDOWS **命令体从 `--` 开始经 `cmd start` 重新拆分，嵌套引号被吃掉/错位，标签里的命令根本不会执行**（标签会打开，但只是默认 profile 空窗，或什么都不跑）。

**验证过的失败例子**（marker 未写入）：
```
start "" wt new-tab -p <g> --startingDirectory <dir> -- "bash -c cd \"<dir>\" && pwd > marker"
```
失败原因：`bash -c` 后的嵌套 `\"...\"` 在 cmd 引号层崩坏。

**结论 / 可靠做法**：
- **tab 命令保持「单层引号 + 极简」**，路径绝不嵌进命令里。
- **起始目录一律交给 `--startingDirectory`**，不要让命令里再 `cd`。
- 可执行、已确认稳定的最小形式：
  ```
  start "" wt new-tab -p <bashProfileGuid> --startingDirectory <winDir> -- bash -c "exec pi"
  ```
  即 `--` 后面是 `bash -c "单层引号内容"`，内容短、无内层引号、无路径、无重定向。

---

## 坑 3：`exec` 会等待交互式子进程，调用方被挂起

**现象**：如果用 `exec` 且 tab 命令是长命程序（`pi` / `cmd /k`），且 `&&` 泄漏到外层，
外层 shell 会去执行它，`exec` 回调永不返回 → 扩展/命令卡死。

**结论 / 可靠做法**：
- tab 命令里的 `&&`/长命进程**必须被 `--` 挡在 WT 内部**，不能外泄到外层 `cmd`。
- 用 `child.unref()` + `timeout` 兜底，确保不拖住 Pi 进程：
  ```js
  return await new Promise((resolve) => {
    const child = exec(full, { timeout: 15000 }, (err) => resolve(!err));
    child.unref?.();
  });
  ```

---

## 坑 4：WT 新标签默认 profile 是 pwsh/cmd，不是 bash

**现象**：不指定 profile 时，`wt new-tab` 打开**默认 profile**（这台机器是 PowerShell），
与用户期望的 Git Bash 不符。

**结论 / 可靠做法**：
- 用 `-p` 明确指定 **Git Bash profile 的 GUID**。
- 不要硬编码单个 GUID：从 `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`
  的 `profiles.list` 里按 `name` 含 `bash` 或 `commandline` 含 `bash.exe` 过滤挑选，
  优先取显式配置 `bash.exe` 的，回退到默认 profile。
- settings.json 路径里的包 ID（`..._8wekyb3d8bbwe`）是稳定的。

---

## 坑 5：`--startingDirectory` 传 Windows 路径才有效

**现象/结论**：`--startingDirectory` 要用 **Windows 形式路径**（`path.win32.normalize`），
虽然 bash 内部 `$PWD` 是 POSIX 形式，但 WT 的起始目录参数认 Windows 路径。已验证
传正斜杠的 Windows 路径能正确进入目标目录。

---

## 验证方法（重要：每个改动都要真实验证）

不要凭边界推断引号行为——直接写 marker 验证命令是否真执行：

```bash
rm -f /d/code/pi-kit/.wt-probe-marker.txt
node -e "
const { exec } = require('child_process');
exec('start \"\" wt new-tab -p <g> --startingDirectory <dir> -- bash -c \"echo OK > /d/code/pi-kit/.wt-probe-marker.txt\"', (e)=>{});
setTimeout(()=>{ console.log(require('fs').existsSync('/d/code/pi-kit/.wt-probe-marker.txt')?'RUN':'MISS'); process.exit(0); }, 8000);
"
```

每次调整命令体都重跑一次，别假设。

---

## 最终可靠配方（本扩展在用）

```js
import { path } from "node:path"; // path.win32.normalize
import { exec } from "node:child_process";

const winDir = path.win32.normalize(startDir);        // Windows 路径
const tabCmd = `bash -c "exec pi"`;                   // 极简 + 单层引号，不嵌路径
const full = `start "" wt new-tab -p "${findBashProfile() ?? DEFAULT_BASH_PROFILE}" --startingDirectory "${winDir}" -- ${tabCmd}`;

return await new Promise((resolve) => {
  const child = exec(full, { timeout: 15000 }, (err) => resolve(!err));
  child.unref?.();
});
```

要点回顾：
1. 启动走 `cmd` 隐式 shell + 裸 `wt`（PATH 解析别名）。
2. `-p` 指定 Git Bash profile。
3. 路径只经 `--startingDirectory`，命令体极简、单层引号、不含 `&&`/路径/重定向。
4. `exec` 配 `unref` + `timeout`，绝不阻塞调用方。