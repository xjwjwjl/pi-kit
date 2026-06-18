---
name: pi-kit-maintainer
description: Maintain the user's personal Pi package at /Users/wjinlin/code/pi-kit when asked to add, update, remove, reorganize, or document Pi extensions, skills, shared helpers, or repository-level conventions.
---

# Pi Kit Maintainer

Use this skill when working in `/Users/wjinlin/code/pi-kit`.

## Goal

Keep `pi-kit` as the source of truth for the user's personal Pi extensions and skills.

## Layout

- `extensions/<name>/index.ts`: Pi extension entrypoints
- `skills/<name>/SKILL.md`: Pi skills
- `shared/`: code shared by multiple extensions
- `extensions/_experimental/` and `skills/_experimental/`: disabled experiments
- `work/`: scratch files
- `outputs/`: generated artifacts

## Extension Workflow

1. Create `extensions/<name>/`.
2. Put the Pi entry file at `extensions/<name>/index.ts`.
3. Add `src/` only when the extension grows beyond a small file.
4. Move reusable logic into `shared/` instead of importing across sibling extensions.
5. Update `package.json` only if the current `pi.extensions` globs no longer cover the new structure.

## Skill Workflow

1. Create `skills/<name>/SKILL.md`.
2. Include frontmatter with `name` and `description`.
3. Keep the body procedural and concise.
4. Put helper code in `scripts/`, detailed references in `references/`, and non-context assets in `assets/`.
5. Update `package.json` only if the current `pi.skills` globs no longer cover the new structure.

## Guardrails

- Use kebab-case directory names.
- Treat this repository as the source of truth; avoid editing installed copies under `~/.pi/agent/` or project `.pi/` directories unless the user explicitly asks.
- Keep experiments under underscore-prefixed directories so the package manifest excludes them.
- Do not create archive trees by default; rely on git history.
- When conventions change, keep `AGENTS.md`, `README.md`, and `docs/conventions.md` consistent.
- After code changes, run `npm run check` and any targeted tests.
