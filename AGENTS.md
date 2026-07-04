# Pi Kit Agent Guide

This repository is the source of truth for the user's personal Pi extensions and skills at `D:/code/pi-kit`.

Each extension is an independent Pi package with its own `package.json` and dependencies. Extensions are registered individually in `~/.pi/agent/settings.json` under the `extensions` array.

## Repository Layout

- `extensions/<name>/`: independent Pi extension packages
- `skills/<name>/SKILL.md`: Pi skills
- `docs/`: human-facing conventions
- `extensions/_experimental/` and `skills/_experimental/`: disabled experiments

## Working Rules

- Use kebab-case for extension and skill directory names.
- Each extension is a self-contained Pi package with its own `package.json` (`"pi": {"extensions": ["./index.ts"]}`) and `node_modules/`.
- Keep extension entry logic in `index.ts`; move larger implementations into `src/`.
- Keep skills concise; put helper code in `scripts/`, larger references in `references/`, and output assets in `assets/`.
- Treat this repo as the source of truth; do not edit installed copies under `~/.pi/agent/` or project `.pi/` directories unless the user explicitly asks.
- For repository maintenance tasks, read `skills/pi-kit-maintainer/SKILL.md`.

## Git Commit Conventions

- 默认使用 Conventional Commits 格式：`<类型>(<范围>): <中文说明>`。
- `:` 前使用英文类型；`:` 后使用中文短句，优先动宾结构。
- `<范围>` 表示改动影响的模块、目录、功能域或组件；范围不明确时可以省略，格式为 `<类型>: <中文说明>`。
- 常用类型：
  - `feat`：新增功能或能力。
  - `fix`：修复缺陷或错误行为。
  - `refactor`：重构实现，不改变外部行为。
  - `test`：新增或调整测试。
  - `docs`：文档或注释改动。
  - `chore`：构建、依赖、脚本、配置等维护事项。
- 提交标题应简短明确，描述本次提交“做了什么”，避免使用“修改代码”“更新文件”等泛化表述。
- 如需说明背景、影响范围、兼容性、迁移步骤或验证方式，使用 commit body 补充，不要把所有细节堆在标题中。
