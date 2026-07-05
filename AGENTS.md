# Pi Kit Agent Guide

This repository is the source of truth for the user's personal Pi extensions and skills at `D:/code/pi-kit`.

Each extension is an independent Pi package with its own `package.json` and dependencies. Extensions are registered individually in `~/.pi/agent/settings.json` under the `extensions` array.

## Repository Layout

- `extensions/<name>/index.ts`: Pi extension entrypoints
- `skills/<name>/SKILL.md`: Pi skills
- `shared/`: code shared across extensions
- `tests/`: focused tests
- `work/`: scratch files
- `outputs/`: generated deliverables
- `extensions/_experimental/` and `skills/_experimental/`: disabled experiments

## Working Rules

- Use kebab-case for extension and skill directory names.
- Each extension is a self-contained Pi package with its own `package.json` (`"pi": {"extensions": ["./index.ts"]}`) and `node_modules/`.
- Keep extension entry logic in `index.ts`; move larger implementations into `src/`.
- Keep skills concise; put helper code in `scripts/`, larger references in `references/`, and output assets in `assets/`.
- Treat this repo as the source of truth; do not edit installed copies under `~/.pi/agent/` or project `.pi/` directories unless the user explicitly asks.
- Do not create archive trees by default; rely on git history.
- After code or structural changes, run `npm run check` and any targeted tests.

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

## Add New Resources

For a new extension:

1. Create `extensions/<name>/index.ts`.
2. Add `extensions/<name>/README.md` when behavior, commands, or configuration need explanation.
3. Add `extensions/<name>/src/` only when the entry file is no longer small.
4. Put reusable helpers in `shared/`, not inside another extension.

For a new skill:

1. Create `skills/<name>/SKILL.md`.
2. Include `name` and `description` frontmatter.
3. Keep the skill body short and procedural.
4. Put helper code in `scripts/`, detailed docs in `references/`, and reusable assets in `assets/`.

Use `extensions/_experimental/` or `skills/_experimental/` for work that should not be loaded by Pi yet.
