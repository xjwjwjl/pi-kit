# 后端规范

## 目录分层

模块 `{module}` 的文件结构：

```text
server/api/v1/{module}/{module}.go      # Register + Handler
server/service/{module}/{module}.go     # 业务逻辑
server/model/{module}/{module}.go       # DB 模型
server/model/{module}/request/{module}.go
server/model/{module}/response/{module}.go
server/utils/autosync/autosync.go       # AutoApiGroup 工具（项目共享一份）
```

禁止创建模块级路由目录：

```text
server/router/{module}/
```

禁止创建模块级聚合文件：

```text
server/**/enter.go
```

## API 层

API 包负责路由注册和 handler 方法。使用 `autosync.AutoApiGroup` 消除 Gin 路由注册和 Casbin `sys_apis` 写入之间的 Method/Path 重复。

### 共享工具：autosync.AutoApiGroup

在 `server/utils/autosync/` 下放置一份 `autosync.go`。每次 `POST/GET/PUT/DELETE` 调用既注册 Gin 路由，也追加一条 `*Route` 到全局注册表。`router_biz.go` 末尾调用 `Flush(db)` 将所有条目批量写入 `sys_apis`（`FirstOrCreate`），然后清空注册表。

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

### 推荐用法

```go
package order

import "your-module-path/utils/autosync"

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

要点：
- Gin 路由和 Casbin API 条目零重复
- `FirstOrCreate` 语义 — 每次启动可安全重跑，不覆盖管理后台修改的记录
- 新增接口只需一行代码
- `SetApiGroup` 有粘性：对其后所有路由生效，直到再次调用
- 未调 `.SetDesc()` 的路由仍会写入 `sys_apis`，描述为空

Handler 应只做参数绑定、调用 service、记录日志、返回响应。不要在 handler 中写业务流程或数据库查询链。

## Service 层

Service 必须显式声明依赖：

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

调用方有请求上下文时，service 方法使用 `context.Context`：

```go
func (s *Service) List(ctx context.Context, req request.List) ([]response.Item, int64, error)
func (s *Service) Create(ctx context.Context, req request.Create) error
func (s *Service) Update(ctx context.Context, req request.Update) error
func (s *Service) Delete(ctx context.Context, req request.Delete) error
```

## 接入

路由注册在 `server/initialize/router_biz.go` → `initBizRouter()`。依次调用各模块的 `Register()`，最后批量写入 API 和菜单：

```go
product.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)
order.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)

autosync.Flush(global.GVA_DB)
autosync.FlushMenus(db, items)
```

表迁移在 `server/initialize/gorm_biz.go` → `bizModel()`：

```go
db.AutoMigrate(&order.Order{})
```

全局状态只在最外层接入点使用。不要用万能结构体隐藏依赖，除非项目本地标准明确要求。

## 菜单初始化

各模块导出 `Menu` 变量。在 `router_biz.go` 中组装成菜单树，一次性传入 `autosync.FlushMenus(db, items)`。

```go
// ── 模块内导出 ──
package product
var Menu = autosync.MenuItem{
    Name:  "product",
    Title: "产品管理",
    Icon:  "box",
    Sort:  10,
}

// ── router_biz.go 集中编排 ──
var system = autosync.MenuItem{Name: "system"} // 桩，引用已有菜单

autosync.FlushMenus(db,
    dashboard.Menu,
    system.Sub(
        user.Menu,
        role.Menu,
        product.Menu,   // 挂到已有 "system" 下
    ),
    autosync.MenuItem{Name: "biz", Title: "业务管理", Icon: "chart", Sort: 10}.Sub(
        autosync.MenuItem{Name: "flow", Title: "流量分析", Icon: "flow", Sort: 10},
    ),
)
```

`MenuItem` 字段：
- `Name` — 唯一键，同时作为 `sys_base_menus.name` 和 `sys_base_menus.path`
- `Title` — 显示名（`sys_base_menus.meta.title`）
- `Icon` — 图标（`sys_base_menus.meta.icon`）
- `Component` — 前端文件路径，默认 `"view/{name}/index.vue"`
- `Sort` — 排序
- `Children` — 子菜单，通过 `.Sub(...)` 设置，无字符串 `Parent` 字段

核心原则：
- 菜单树在 `router_biz.go` 集中组装 — 层级可见、编译期校验
- `MenuItem{Name: "x"}` 可作为"桩"引用 DB 中已有菜单
- `Sub()` 可引用任意菜单，不论来自代码还是管理后台
- `FirstOrCreate` — 安全重入，不覆盖已有数据
- 所有菜单默认绑定 admin 角色（authority_id=888）
- 无全局菜单注册表 — 菜单树直接传入 `FlushMenus`

## 命名

- API 结构体：`Api`，同包多个时用 `{Module}Api`
- Service 结构体：`Service`，同包多个时用 `{Module}Service`
- 构造函数：`NewService(...)`
- 路由注册函数：`Register(...)`
