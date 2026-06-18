# Pi Kit Agent Guide

This repository is the source of truth for the user's personal Pi package at `/Users/wjinlin/code/pi-kit`.

When the user asks to create, update, remove, reorganize, or document custom Pi extensions, skills, prompts, themes, or shared support code, do that work here unless they explicitly point to another location.

## Repository Layout

- `extensions/<name>/index.ts`: Pi extension entrypoints
- `skills/<name>/SKILL.md`: Pi skills
- `shared/`: code shared across extensions
- `tests/`: focused tests
- `docs/`: human-facing conventions
- `work/`: scratch files
- `outputs/`: generated deliverables
- `extensions/_experimental/` and `skills/_experimental/`: disabled experiments

## Working Rules

- Use kebab-case for extension and skill directory names.
- Prefer one directory per extension or skill.
- Keep extension entry logic in `index.ts`; move larger implementations into `src/`.
- Keep skills concise; put helper code in `scripts/`, larger references in `references/`, and output assets in `assets/`.
- Treat this repo as the source of truth; do not edit installed copies under `~/.pi/agent/` or project `.pi/` directories unless the user explicitly asks.
- Update `package.json` only when the current Pi manifest globs are no longer sufficient.
- If an extension imports Pi core packages, keep them in `peerDependencies`; third-party runtime packages belong in `dependencies`.
- After code or structural changes, run `npm run check` and any targeted tests.
- For repository maintenance tasks, read `skills/pi-kit-maintainer/SKILL.md`.
