---
name: autosync-api
description: "Gin 路由注册时自动同步 Casbin sys_apis 权限表。触发词：AutoApiGroup、Flush、注册路由、权限同步、Casbin API、sys_apis、路由自动同步。"
---

# autosync — API 自动同步

将 [api.go](references/api.go) 放置到 `{server}/utils/autosync/`（与 [autosync-menu](../autosync-menu/SKILL.md) 的 `menu.go` 同目录），修改其中的 `your-project/model/sys` 为实际模型路径。

## AutoApiGroup

```go
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

func NewAutoApiGroup(group *gin.RouterGroup, basePath string) *AutoApiGroup
func (g *AutoApiGroup) SetApiGroup(s string) *AutoApiGroup
func (g *AutoApiGroup) POST(path, handler) *Route   // alias: GET / PUT / DELETE
func (r *Route) SetDesc(s string) *Route
```

`AutoApiGroup` 包装 `gin.RouterGroup`，注册路由时同步记录 Method/Path/Desc/ApiGroup 到全局注册表。`SetDesc` 写入 `sys_apis.description`。

## Flush — 批量写入 sys_apis

```go
func Flush(db *gorm.DB)
```

- 查询 `sys_apis` 已有记录，按 `(path, method)` 去重
- 新增路由通过 `CreateInBatches(100)` 批量写入
- 写入后清空注册表，可安全重复调用

具体实现见 [api.go](references/api.go)。

## 用法

路由注册集中在各模块的 `Register()` 函数，开头用 Go doc comment 说明本模块的路由分组和权限归属：

```go
// Register 注册订单模块路由到 privateGroup。
//
// AutoApiGroup 在注册路由的同时记录 Method/Path/Desc/ApiGroup，
// 初始化末尾通过 autosync.Flush 批量写入 sys_apis 权限表，自动去重。
func Register(privateGroup, publicGroup *gin.RouterGroup) {
    api := &Api{svc: NewService(db, log)}

    g := autosync.NewAutoApiGroup(privateGroup.Group("order"), "/order").
        SetApiGroup("订单管理")

    g.GET("list", api.List).SetDesc("查询订单列表")
    g.POST("create", api.Create).SetDesc("创建订单")
    g.PUT("update", api.Update).SetDesc("更新订单")
    g.DELETE("delete", api.Delete).SetDesc("删除订单")
}
```

路由初始化末尾统一调用：

```go
order.Register(privateGroup, publicGroup)
product.Register(privateGroup, publicGroup)

autosync.Flush(global.GVA_DB) // sys_apis 批量写入

// 菜单同步参考 autosync-menu
autosync.FlushMenus(global.GVA_DB, menuItems...)
```

## 接入流程

1. 将 [api.go](references/api.go) 放置到 `{server}/utils/autosync/`，修改 `your-project/model/sys` 为实际模型路径
2. 模块 API 层使用 `AutoApiGroup` 替代原始 `gin.RouterGroup`
3. 路由初始化末尾调用 `autosync.Flush(db)`
4. 描述信息建议与 `scripts/mysql/sys_apis.sql` 保持一致
