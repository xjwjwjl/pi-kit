---
name: autosync-menu
description: "菜单声明式同步：MenuItem 编排菜单树，FlushMenus 写入 sys_base_menus。触发词：MenuItem、FlushMenus、菜单同步、导航菜单、sys_base_menus、菜单初始化、侧边栏菜单。"
---

# autosync — 菜单自动同步

将 [menu.go](references/menu.go) 放置到 `{server}/utils/autosync/`（与 [autosync-api](../autosync-api/SKILL.md) 的 `api.go` 同目录），修改其中的 `your-project/model/sys` 为实际模型路径。

## MenuItem

```go
type MenuItem struct {
    RouteName string     // 路由名，同时作为 sys_base_menus.name 和 path（唯一键）
    Title     string     // 显示名（meta.title）；空时为"桩"，仅引用已有菜单
    Icon      string     // 图标，默认 "aim"
    Sort      int        // 排序，默认按书写顺序 1-based，非零时用指定值
    Component string     // 前端路径，默认 "view/{RouteName}/index.vue"
    Children  []MenuItem // 通过 .Sub(...) 设置
}

func (m MenuItem) Sub(children ...MenuItem) MenuItem
```

## FlushMenus

```go
func FlushMenus(db *gorm.DB, items ...MenuItem) error
```

- `FirstOrCreate` 按 `RouteName` 匹配，安全重入
- `ParentId` 使用父菜单的 DB 自增 ID；桩节点自动查已有菜单
- 所有菜单绑定到 admin 角色（authority_id 默认 `"1"`，按项目修改）
- 同级菜单按书写顺序自动排序，显式指定 `Sort` 时用指定值

## 用法

菜单定义集中在 `initialize/menu.go`，用 Go doc comment 说明字段约定：

```go
// SyncMenus 将业务模块菜单同步到 sys_base_menus 并关联 admin 角色。
//
// MenuItem 字段说明：
//   RouteName — 路由名，也是 sys_base_menus.name / path（唯一键）
//   Title     — 显示名（sys_base_menus.meta.title）
//   Icon      — 图标，默认 "aim"
//   Sort      — 排序，默认按书写顺序自动分配（1-based），非零则用指定值
//   Component — 前端文件路径，默认 "view/{RouteName}/index.vue"
//               父级容器页需显式指定，如 "view/routerHolder.vue"
func SyncMenus(db *gorm.DB) error {
    return autosync.FlushMenus(db,
        autosync.MenuItem{RouteName: "dashboard", Title: "仪表盘", Icon: "odometer"},

        // 桩节点：不设 Title，引用 system 模块已有菜单，仅用于挂载子菜单
        autosync.MenuItem{RouteName: "system"}.Sub(
            autosync.MenuItem{RouteName: "user", Title: "用户管理"},
            autosync.MenuItem{RouteName: "role", Title: "角色管理"},
        ),

        // 父级容器：显式指定 Component 和 Sort
        autosync.MenuItem{RouteName: "biz", Title: "业务管理", Component: "view/routerHolder.vue", Sort: 15}.Sub(
            autosync.MenuItem{RouteName: "product", Title: "产品管理"},

            // 自定义前端路径（不遵循 view/{RouteName}/index.vue 约定时）
            autosync.MenuItem{
                RouteName: "customConfig",
                Title:     "自定义配置",
                Component: "view/biz/customConfig/index.vue",
            },
        ),
    )
}
```

## 接入流程

1. 将 [menu.go](references/menu.go) 放置到 `{server}/utils/autosync/`
2. 在 `initialize/menu.go` 中定义 `SyncMenus(db)`，集中编排菜单树
3. 路由初始化末尾调用 `SyncMenus(db)`（通常在 `autosync.Flush(db)` 之后）
