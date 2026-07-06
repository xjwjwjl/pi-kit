---
name: fullstack-vibe-feature
description: "用于在 admin 风格全栈项目中实现新业务功能。后端分层：server/api/v1/{module}、server/service/{module}、server/model/{module}；前端分层：web/src/api/{module}.js、web/src/view/{module}。遵循团队规范：保持既有目录风格，不新建 router 目录/enter.go/GroupApp 聚合，用 Register/NewService 显式构造函数 DI，前端以 api/view/components 组织。"
---

# Admin 全栈业务功能规范

纯规范文档 — 无模板、无脚手架。加载后按规范自行编写代码。

## 目录分层

```
server/
  api/v1/{module}/{module}.go    — Register + Handler
  service/{module}/{module}.go   — 业务逻辑
  model/{module}/{module}.go     — DB 模型
  model/{module}/request/        — 请求 DTO
  model/{module}/response/       — 响应 DTO
  utils/autosync/autosync.go     — 路由/菜单自动同步（共享工具）

web/
  src/api/{module}.js            — API 封装（唯一允许 import request 的地方）
  src/view/{module}/
    index.vue                    — 页面
    components/                  — UI 子组件（可选）
```

## 核心规则

- 不创建 `server/router/{module}/` 目录
- 不创建 `enter.go` 文件
- 不用 `ApiGroupApp` / `ServiceGroupApp` / `RouterGroupApp`
- 不用 `Container` 结构体
- 路由注册在 `server/api/v1/{module}/{module}.go` 的 `Register()` 中
- Service 用显式构造函数 DI：`NewService(db, log)`
- 前端 `web/src/api/` 是唯一调用 `@/utils/request` 的地方

## 参考文档

按需加载：

- [backend.md](references/backend.md) — API/Service/Model 规范、autosync 用法、菜单声明
- [frontend.md](references/frontend.md) — 目录分层、API 封装规范
- [forbidden.md](references/forbidden.md) — 禁止的写法
