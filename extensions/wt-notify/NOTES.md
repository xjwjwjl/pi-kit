# wt-notify 踩坑记录与正确方案

> 本文档沉淀了开发 wt-notify（Windows 系统 toast 通知扩展）时踩过的坑、根因和最终正确方案，供后续维护与同类扩展参考。

## 背景

wt-notify 的目标：当 Pi 的 Agent 任务**真正完成**（settle）时，在 Windows 弹出一个**系统级 toast 弹窗**，正文包含耗时与当前项目名。

几个容易混淆的概念先厘清：

| 概念 | 说明 |
|---|---|
| `ctx.ui.notify` | Pi **TUI 界面内部**的通知（终端内一行提示），**不是** Windows 系统弹窗 |
| 系统 toast | Windows 桌面右下角原生通知（通知中心） |
| toast 来源 | toast 卡片左上角显示的应用名（如 "Windows Terminal"） |

## 关键结论（先说对的做法）

- 触发时机用 `agent_settled`（不用 `agent_end`），并过滤短任务与中止任务
- 通知介质用 **PowerShell + Windows toast**，不要用 `ctx.ui.notify`
- 必须用**已注册的 AUMID**，否则 `.Show()` 成功但 toast 被系统静默丢弃
- PowerShell 里操作 toast XML 的节点要**先缓存再改**，避免 live-collection 枚举异常

## 踩坑清单

### 坑 1：`ctx.ui.notify` 不是系统弹窗

- **现象**：任务完成后 TUI 没弹出对话框/toast。
- **根因**：`ctx.ui.notify` 只是 Pi UI 内部的通知渲染，属于终端内提示，不是 Windows 桌面通知。
- **正确方案**：需要系统弹窗就调用 PowerShell 的 Windows toast API（见下）。

### 坑 2：`GetElementsByTagName('text')[0]` 触发"集合已修改"枚举异常

- **现象**：toast 脚本在 `.Show()` 之前抛 `BadEnumeration`/“集合已修改；可能无法执行枚举操作”，`.Show()` 从未执行，toast 不弹。
- **根因**：`GetElementsByTagName(...)` 返回 **live collection**，先按索引 `[0]` 取节点再 `AppendChild` 修改时，部分 PowerShell 运行环境会因迭代器失效抛错。参考实现 pi-notify 用的就是这个写法。
- **正确方案**：先取出节点引用再操作：
  ```powershell
  $texts = $xml.GetElementsByTagName('text')
  $textNode = $texts.Item(0)
  $null  = $textNode.AppendChild($xml.CreateTextNode($body))
  ```
- **排错技巧**：用「在 `.Show()` 前后写标记文件」判断是否真正执行到 `.Show()`，而不是只看 stderr。

### 坑 3：未注册的 AUMID 导致 toast 被静默丢弃

- **现象**：`.Show()` 返回成功（无异常），但 toast 就是不显示。
- **根因**：`CreateToastNotifier('Pi')` 用了**未注册的 AUMID**。Windows 对未注册 AUMID 的 toast 直接丢弃，不报错——这是最难排查的坑。
- **正确方案**：借用**已注册的** AUMID。Windows 内置可靠的两个：
  ```ts
  const REGISTERED_AUMIDS = [
    "Microsoft.WindowsTerminal",                // Windows Terminal 自身
    "Microsoft.Windows.Shell.RunDialog",         // “运行”对话框（兜底）
  ];
  ```
  依次尝试，首个能 `Show` 成功的即用它：
  ```powershell
  foreach ($id in @($aumids)) {
    try { $nt = ...CreateToastNotifier($id); $nt.Show($toast); break }
    catch { continue }
  }
  ```
- **副产坑**：借用 `RunDialog` 时，toast **来源名会显示"运行"**（中文系统）而不是 Pi。把 `Microsoft.WindowsTerminal` 放首位，来源就显示 "Windows Terminal"。

### 坑 4：PowerShell 手写 XML 时 WinRT 类型加载失败

- **现象**：`New-Object Windows.Data.Xml.Dom.XmlDocument` 报"找不到类型"。
- **根因**：原生 PowerShell 5.1 对 WinRT 投影加载不完整，`New-Object` 创建不了 WinRT 类型。
- **正确方案**：
  - 最简单：用官方模板 `GetTemplateContent(...)` 拿 XML，**不要手写 XmlDocument**（us与 ToastText01 避开此问题）。
  - 若必须手建 WinRT 对象，用类型引用语法而不是 `New-Object`：
    ```powershell
    $doc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]::new()
    ```

### 坑 5：`.ps1 -File` 中文编码乱码 vs `-Command` 传参

- **现象**：把含中文的 PowerShell 写成 `.ps1` 用 `-File` 执行，中文被解析成 GBK 乱码，破坏引号/脚本。
- **根因**：Windows PowerShell 5.1 按系统 ANSI（GBK）解析无 BOM 的 `.ps1`，UTF-8 中文乱掉；而扩展用 Node `execFile` 经 `-Command` 传参时走 UTF-8，正常。
- **正确方案**：扩展里用 `execFile("powershell.exe", ["-NoProfile", "-Command", script])` 传整段脚本，不要落 `.ps1` 文件；中文通过 `-Command` 传即可。

### 坑 6：toast 双行模板

- **现象**：想把"标题"和"正文"分行，用 `ToastText01` 只有单文本。
- **正确方案**：用 `ToastText02`（两个 text 节点，第一个是粗体标题）。当前需求是单行，用 `ToastText01`。

### 坑 7：扩展"看起来没加载" 的排查

- **现象**：逻辑看起来应该触发，但没有任何效果；改完代码重启后仍无日志。
- **根因排查顺序**：
  1. 扩展列表/事件订阅在**进程启动时**建立，`reload` 命令不一定重新订阅事件派发器，需要**彻底重启整个 Pi 进程**才能加载新扩展代码。
  2. 用 `debug()` 写文件日志确认扩展是否被加载与事件是否触发（区分「没加载」vs「事件没触发」）。
  3. 用 Pi 实际用的 **jiti** 加载器复现加载，确认模块与 factory 能跑（`jiti.import(index.ts)` → `factory` 应为 function；调用 factory 后日志应写入）。
- **注意**：测试用 `node --experimental-strip-types` 直接 import，是**另一条加载路径**，能过测试不代表 Pi 的 jiti 路径 OK（反之亦然）。验证加载请用 jiti 或真实 Pi 进程。

## 正确方案：核心代码骨架（精简）

```ts
import { execFile } from "node:child_process";
import path from "node:path";

const TOAST_PREFIX = "🤖 ";
const REGISTERED_AUMIDS = ["Microsoft.WindowsTerminal", "Microsoft.Windows.Shell.RunDialog"];

function windowsToastScript(body: string): string {
  const type = "Windows.UI.Notifications";
  return [
    "try {",
    `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] | Out-Null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
    "$texts = $xml.GetElementsByTagName('text')",
    "$textNode = $texts.Item(0)",
    `$null = $textNode.AppendChild($xml.CreateTextNode('${body}'))`,
    `$toast = [${type}.ToastNotification]::new($xml)`,
    `foreach ($id in @('${REGISTERED_AUMIDS.join("', '")}')) { try { $nt = [${type}.ToastNotificationManager]::CreateToastNotifier($id); $nt.Show($toast); break } catch { continue } }`,
    "} catch { /* swallow */ }",
  ].join("\n");
}

// agent_settled 触发时机 + minSeconds 过滤 + aborted 过滤（略）
// body = `${TOAST_PREFIX}任务完成 · 用时 ${seconds}s · ${path.basename(process.cwd())}`
```

关键点再次强调：
1. `agent_settled`（真正结束）而不是 `agent_end`
2. 已注册 AUMID（否则静默丢弃）
3. 节点先缓存再改（避免枚举异常）
4. `-Command` 传参（避免 `.ps1` 中文编码）
5. 用 `debug()` 日志做"加载 vs 事件"二分定位

## 验证方式

- **单测**：注入 `notify` 后端，断言 `agent_settled` 后收到预期正文（覆盖过滤/中止/时长/连续重试）。
- **端到端**：在真实 Pi 会话跑一个 >8s 的任务，观察右下角 toast；用「写入标记文件」确认 `.Show()` 是否真正执行。