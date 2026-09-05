# launcher-panel

通用「启动面板」（Launcher Panel）扩展：在 Git 项目目录下启动 pi 时自动弹出，
作为多个 feature 的统一入口。当前没有内置 feature，主面板会折叠展示其他
扩展贡献的 slash 命令。

## 行为

| 触发方式 | 条件 |
| --- | --- |
| 启动自动弹出 | `session_start` 且 `reason === "startup"`，且 `ctx.cwd` 位于 Git 工作区内（向上找不到 `.git` 则不弹），且运行于 TUI 模式 |
| `/launcher` 命令 | 任意时候手动打开（非 Git 目录也可打开，副标题会提示） |

面板交互：`↑↓` / `jk` 选择，数字 `1-9` 快速选择，`enter` 确认，`esc` / `q` 关闭。
面板优先以浮动 overlay（模态弹窗）渲染；旧版本 pi 自动回退为替换编辑器区域渲染，
且 overlay 失败会被记忆，后续打开不再重复试探。
其他扩展贡献的 slash 命令不平铺在主面板，而是折叠为「Extension commands」
选项，点开进入子面板选择，保证主面板只聚焦 feature。
选项为空时展示禁用的占位行；某个 feature 的选项解析失败会被隔离并通知，
不会导致整个面板打不开；重复的选项 id 保留首个并告警。

样式：面板遵循 pi 官方选择器规范（与 llama 扩展的对话框样板、内置
theme-selector 一致）：accent 上下边框 + accent 粗标题 + dim 提示行，
不使用自定义背景色；选项 label 列宽度按官方常量自适应（12-32 列），
剩余宽度全部留给描述列，避免长描述被挤压截断。禁用项以 dim 色展示并
标注「disabled」；fallback 模式垂直居中，与 overlay 的居中观感一致。
以上均为纯视觉层，不改变任何交互与执行逻辑。

## 结构

```
launcher-panel/
├── index.ts                     # 扩展入口：装配检测、注册、触发
├── package.json                 # pi package 元数据
├── tsconfig.json                # 类型检查配置（tsc --noEmit，对照真实 pi 类型）
├── src/
│   ├── git.ts                   # Git 工作区检测：向上查找 .git（目录或文件）
│   ├── launcher/
│   │   ├── types.ts             # PanelOption / PanelConfig / PanelTheme 类型契约
│   │   ├── registry.ts          # LauncherRegistry：选项注册中心（feature 接入点）
│   │   ├── component.ts         # LauncherPanel：TUI 面板组件（渲染 + 键盘交互）
│   │   └── show.ts              # showLauncherPanel() / openLauncher()：弹出与执行
│   └── features/                # LauncherFeature 实现（按需新增）
└── test/
    ├── launcher.test.ts         # git 检测、注册表、面板执行流与装配测试
    ├── pi-loader.ts             # 测试用 resolve 钩子：pi 裸包重定向到本地桩
    └── stubs/                   # pi-tui / pi-coding-agent 的最小测试桩
```

## 扩展点

### 新增 feature

在 `src/features/<name>.ts` 中声明一个 `LauncherFeature`，并加入 `index.ts`
顶部的 `features` 数组即可，面板代码无需任何改动：

```ts
import type { LauncherFeature } from "../launcher/types";

export const myFeature: LauncherFeature = {
	id: "my",
	description: "What this feature does", // 用作快捷键描述
	shortcuts: ["ctrl+x"],                 // 可选：经 pi.registerShortcut 全局绑定
	options: ({ workspaceRoot }) => [
		{
			id: "my.action",
			label: "My action",
			description: "optional muted description",
			shortcut: "ctrl+x", // 与 feature 级 shortcut 保持一致才能被按键直接触发
			execute: async ({ ctx }) => {
				ctx.ui.notify("hello", "info");
			},
		},
	],
};
```

约定：

- feature 级 `shortcuts` 决定注册哪些全局按键；option 级 `shortcut` 决定按下后
  执行哪个选项，两者需保持一致。同一按键被多个 feature 声明时只绑定第一个，
  并输出警告。
- `options()` 在每次打开面板 / 按下快捷键时重新求值；抛错的 feature 会被跳过
  并通过通知提示，不影响其他选项。
- feature 内部可复用 `showLauncherPanel(ctx, config)` 弹出自己的子面板，选中项
  通过 `runOption()` 执行以获得统一的错误隔离。

## 开发

```sh
npm run check # tsc 类型检查（对照真实 pi 类型）+ 语法检查 + 测试
```

devDependencies 里的 `@earendil-works/pi-coding-agent` / `pi-tui` 仅供类型检查；
运行时由 pi 自身提供，测试则通过 `test/pi-loader.ts` 重定向到本地桩。
升级 pi 后建议同步升级这两个包，让 API 漂移在 `tsc --noEmit` 阶段暴露。
