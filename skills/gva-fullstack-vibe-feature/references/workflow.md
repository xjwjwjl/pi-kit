# Workflow

Use this workflow for new business features in existing admin-style full-stack repositories.

## Discovery

1. Detect project layout: `./scripts/detect_project.sh .`
2. Identify the module name, route prefix, entity names, and target frontend page.
3. Read any module context under `vibe/features/{module}/`.
4. Search for nearby modules with similar business shape and reuse local conventions that do not conflict with this standard.

## Build Order

1. Define or update backend models and request/response DTOs.
2. Implement service constructors and business methods.
3. Implement API `Register(...)` in `server/api/v1/{module}`:
   - Use `autosync.NewAutoApiGroup()` for route registration.
   - Call `autosync.EnsureMenu(...)` to declare the menu entry.
4. Wire in `server/initialize/router_biz.go`:
   - Import the module and call its `Register(...)`.
   - After all modules, call `autosync.Flush(db)` and `autosync.FlushMenus(db)`.
5. Wire table migration in `server/initialize/gorm_biz.go` if new models exist.
6. Implement frontend API wrappers in `web/src/api/{module}.js`.
7. Implement frontend pages under `web/src/view/{module}/`.
8. Split page details into `components/` and `composables/` when logic grows.

## Scope Control

Only touch shared framework files when required for wiring. Avoid refactoring old modules while adding new features.

## Checks

Run the strongest available checks:

```bash
./scripts/vibe_check.sh .
go test ./...
cd web && npm run build
```

If a command is unavailable, report it instead of inventing a replacement.
