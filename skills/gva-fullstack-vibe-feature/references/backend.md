# Backend Convention

## Directory Layout

For module `{module}`, prefer:

```text
server/api/v1/{module}/{module}.go      # Register + Handlers
server/service/{module}/{module}.go     # Business logic
server/model/{module}/{module}.go       # DB model
server/model/{module}/request/{module}.go
server/model/{module}/response/{module}.go
server/utils/autosync/autosync.go       # AutoApiGroup wrapper (shared utility)
```

Do not create new module router directories:

```text
server/router/{module}/
```

Do not create new module aggregators:

```text
server/**/enter.go
```

## API Layer

The API package owns route registration and handler methods. Use `autosync.AutoApiGroup` to eliminate Method/Path duplication between Gin route registration and Casbin `sys_apis` seeding.

### Shared Utility: autosync.AutoApiGroup

Place a single copy of `autosync.go` under `server/utils/autosync/`. Each `POST/GET/PUT/DELETE` call registers the Gin route and appends a `*Route` entry to a global registry. `Flush(db)` at the end of `initBizRouter` writes all entries to `sys_apis` in one batch via `FirstOrCreate`, then clears the registry.

```go
package autosync

type Route struct {
    Method   string
    Path     string
    Desc     string
    ApiGroup string
}

type AutoApiGroup struct {
    *gin.RouterGroup
    basePath string
    apiGroup string
}

func NewAutoApiGroup(group *gin.RouterGroup, db *gorm.DB, basePath string) *AutoApiGroup
func (g *AutoApiGroup) SetApiGroup(s string) *AutoApiGroup
func (g *AutoApiGroup) POST(path string, handler gin.HandlerFunc) *Route
func (g *AutoApiGroup) GET(path string, handler gin.HandlerFunc) *Route
func (g *AutoApiGroup) PUT(path string, handler gin.HandlerFunc) *Route
func (g *AutoApiGroup) DELETE(path string, handler gin.HandlerFunc) *Route
func (r *Route) SetDesc(s string) *Route
func Flush(db *gorm.DB)
```

### Recommended Usage

```go
package order

import "{{GO_MODULE}}/utils/autosync"

func Register(private, public *gin.RouterGroup, db *gorm.DB, log *zap.Logger) {
    api := NewApi(moduleService.NewService(db, log), log)

    g := autosync.NewAutoApiGroup(private.Group("order"), db, "/order").
        SetApiGroup("订单管理")

    g.POST("list", api.List)
    g.POST("create", api.Create).SetDesc("创建订单")
    g.PUT("update", api.Update).SetDesc("更新订单")
    g.DELETE("delete", api.Delete).SetDesc("删除订单")
}

func (a *Api) List(c *gin.Context) { /* bind -> svc -> response */ }
```

Key points:
- Zero Method/Path duplication between Gin routes and Casbin API entries
- `FirstOrCreate` semantics — safe to run on every startup, won't overwrite records modified via admin UI
- Adding a new endpoint only requires one line of code
- `SetApiGroup` is sticky: applies to all subsequent routes until changed
- Routes without `.SetDesc()` still get a `sys_apis` record, just with empty description

Handlers should bind input, call service methods, log failures, and write responses. Do not put business workflows or database query chains in handlers.

## Service Layer

Services must declare dependencies explicitly:

```go
type Service struct {
    db  *gorm.DB
    log *zap.Logger
}

func NewService(db *gorm.DB, log *zap.Logger) *Service {
    return &Service{
        db:  db,
        log: log.Named("module-service"),
    }
}
```

Use `context.Context` for service methods when the caller has request context:

```go
func (s *Service) List(ctx context.Context, req request.List) ([]response.Item, int64, error)
func (s *Service) Create(ctx context.Context, req request.Create) error
func (s *Service) Update(ctx context.Context, req request.Update) error
func (s *Service) Delete(ctx context.Context, req request.Delete) error
```

## Wiring

Route wiring goes into `server/initialize/router_biz.go` → `initBizRouter()`. Call each module's `Register()` then batch API and menu writes at the end:

```go
product.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)
order.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)

autosync.Flush(global.GVA_DB)
autosync.FlushMenus(global.GVA_DB)
```

Table migration goes into `server/initialize/gorm_biz.go` → `bizModel()`:

```go
db.AutoMigrate(&order.Order{})
```

Use global state only at the outer wiring point. Do not hide dependencies in a catch-all struct unless a repository-local standard requires it.

## Menu and Permission Initialization

Menu creation uses the same collect-then-batch pattern as route registration. Each module calls `autosync.EnsureMenu()` in its `Register()` to declare a menu entry. `autosync.FlushMenus(db)` in `router_biz.go` writes all menus to `sys_base_menus` and binds them to the admin role (888) in one pass, then clears the registry.

```go
autosync.EnsureMenu(autosync.Menu{
    Name:   "product",
    Title:  "产品管理",
    Icon:   "box",
    Parent: "example",  // 父菜单 name，空 = 顶级
    Sort:   10,
})
```

`Menu` fields:
- `Name` — unique key, used as `sys_base_menus.name` and `sys_base_menus.path`
- `Title` — display name (`sys_base_menus.meta.title`)
- `Icon` — menu icon (`sys_base_menus.meta.icon`)
- `Parent` — parent menu `name` (empty = top-level)
- `Component` — frontend file path, defaults to `"view/{name}/index.vue"`
- `Sort` — sort order

Key principles:
- Menu records go into `sys_base_menus` with `name` as the stable lookup key
- `FirstOrCreate` semantics — safe to re-run, won't overwrite admin UI changes
- Parent menu referenced by `name`, not database ID — avoids hardcoded IDs
- All menus bound to admin role (authority_id=888) by default
- Registry cleared after `FlushMenus()`, no memory retained

## Naming

- API struct: `Api`, or `{Module}Api` when several APIs share a package.
- Service struct: `Service`, or `{Module}Service` when several services share a package.
- Constructor: `NewService(...)`.
- Route registration: `Register(...)`.
