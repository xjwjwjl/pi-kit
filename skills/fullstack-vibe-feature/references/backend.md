# 后端规范

> **`{server}` 表示项目的后端根目录**，根据实际项目结构替换。

## 目录分层

模块 `{module}` 的文件结构：

```text
{server}/api/v1/{module}/{module}.go      # Register + Handler
{server}/service/{module}/{module}.go     # 业务逻辑
{server}/model/{module}/{module}.go       # DB 模型
{server}/model/{module}/request/{module}.go
{server}/utils/autosync/api.go          # 路由同步
{server}/utils/autosync/menu.go         # 菜单同步
```

禁止创建模块级路由目录：

```text
{server}/router/{module}/
```

禁止创建模块级聚合文件：

```text
{server}/**/enter.go
```

## API 层

API 包负责路由注册和 handler 方法。路由注册推荐使用 `autosync.AutoApiGroup`（详见 [autosync-api](../../../autosync-api/SKILL.md)），消除 Gin 路由注册和 Casbin `sys_apis` 写入之间的 Method/Path 重复。

### 推荐用法

```go
package order

type Api struct { svc *svc.Service }

func Register(privateGroup, publicGroup *gin.RouterGroup) {
    api := &Api{svc: svc.NewService(global.SERVICE_DB, global.FV_LOG)}

    g := autosync.NewAutoApiGroup(privateGroup.Group("order"), "/order").
        SetApiGroup("订单管理")

    g.GET("list", api.List).SetDesc("查询订单列表").SetAction("查询")
    g.POST("create", api.Create).SetDesc("创建订单").SetAction("新增")
}

func (a *Api) List(c *gin.Context) { /* bind -> svc -> response */ }
```

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
func (s *Service) List(ctx context.Context, req request.List) ([]model.Item, int64, error)
func (s *Service) Create(ctx context.Context, req request.Create) error
func (s *Service) Update(ctx context.Context, req request.Update) error
func (s *Service) Delete(ctx context.Context, req request.Delete) error
```

## 接入

路由注册在 `{server}/initialize/router_biz.go` → `initBizRouter()`。依次调用各模块的 `Register()`，最后批量写入 API 和菜单：

```go
product.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)
order.Register(privateGroup, publicGroup, global.GVA_DB, global.GVA_LOG)

autosync.Flush(global.GVA_DB)
autosync.FlushMenus(db, items)
```

表迁移在 `{server}/initialize/gorm_biz.go` → `bizModel()`：

```go
db.AutoMigrate(&order.Order{})
```

全局状态只在最外层接入点使用。不要用万能结构体隐藏依赖，除非项目本地标准明确要求。

## 命名

- API 结构体：`Api`，同包多个时用 `{Module}Api`
- Service 结构体：`Service`，同包多个时用 `{Module}Service`
- 构造函数：`NewService(...)`
- 路由注册函数：`Register(...)`
