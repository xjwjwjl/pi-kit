---
name: fullstack-vibe-feature
description: "Admin 全栈业务功能规范：后端 api/service/model 三层，前端 api/view/components 组织，Register/NewService 显式 DI。触发词：全栈开发、新增模块、GVA admin、Gin Vue、业务功能、CRUD 模块、后端分层、前端页面、新业务。"
---

# Admin 全栈业务功能规范

纯规范文档 — 无模板、无脚手架。加载后按规范自行编写代码。

> **`{server}` 说明**：表示项目的后端根目录。可能是 `server/`、`backend/`、或项目根目录本身（api/、service/、model/ 直接在项目根下）。根据实际项目结构替换，不要强行创建不存在的目录层级。

## 目录分层

```
{server}/
  api/v1/{module}/{module}.go    — Register + Handler
  service/{module}/{module}.go   — 业务逻辑
  model/{module}/{module}.go     — DB 模型
  model/{module}/request/        — 请求 DTO

web/
  src/api/{module}.js            — API 封装（唯一允许 import request 的地方）
  src/view/{module}/
    index.vue                    — 页面
    components/                  — UI 子组件（可选）
```

## 核心规则

- 不创建 `{server}/router/{module}/` 目录
- 不创建 `enter.go` 文件
- 不用 `ApiGroupApp` / `ServiceGroupApp` / `RouterGroupApp`
- 不用 `Container` 结构体
- 路由注册在 `{server}/api/v1/{module}/{module}.go` 的 `Register()` 中
- Service 用显式构造函数 DI：`NewService(db, log)`
- 前端 `web/src/api/` 是唯一调用 `@/utils/request` 的地方

## 参考文档

按需加载：

- [backend.md](references/backend.md) — API/Service/Model 分层规范
- [frontend.md](references/frontend.md) — 目录分层、API 封装规范
- [forbidden.md](references/forbidden.md) — 禁止的写法
