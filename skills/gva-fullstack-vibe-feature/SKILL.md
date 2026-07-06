---
name: gva-fullstack-vibe-feature
description: "Use when implementing new business features in admin-style full-stack projects with backend layers like server/api/v1/{module}, server/service/{module}, server/model/{module} and frontend layers like web/src/api/{module}.js and web/src/view/{module}. Applies the team convention: keep existing directory style, avoid new router directories/enter.go/GroupApp aggregators, use explicit constructor DI via Register/NewService patterns, and organize frontend with api/view/components/composables."
---

# Admin Full-Stack Vibe Feature

## Quick Start

1. Detect project layout: `./scripts/detect_project.sh .`
2. Scaffold a new module: `./scripts/scaffold_feature.sh <module>`
3. Wire in `server/initialize/router_biz.go` — import module, call `Register(...)`, then `autosync.Flush(db)` / `autosync.FlushMenus(db)`.
4. Run checks: `./scripts/vibe_check.sh <module>`

## Core Rules

- No new `server/router/{module}/` directories.
- No new `enter.go` files.
- No `ApiGroupApp` / `ServiceGroupApp` / `RouterGroupApp`.
- No `Container` struct.
- Route registration lives in `server/api/v1/{module}/{module}.go` via `Register(...)`.
- Services use explicit constructor DI: `NewService(db, log)`.
- Frontend: `web/src/api/{module}.js` + `web/src/view/{module}/` with `components/` and `composables/`.

## References

Read on-demand when more detail is needed:

- [workflow.md](references/workflow.md) — full build order and checks
- [backend.md](references/backend.md) — API/Service/Model conventions, autosync wrapper, menu wiring
- [frontend.md](references/frontend.md) — page structure, API wrappers, composables
- [forbidden.md](references/forbidden.md) — patterns to avoid

## Override Precedence

Repository-local rules override this skill. Check these files in order, first match wins:

- `vibe/standard/spec/*.md`
- `vibe/*.md`
- `AGENTS.md`
