# 禁止的写法

以下写法在新业务模块中禁止使用，除非项目本地规则明确覆盖。

## 后端

- 创建 `server/router/{module}/` 目录
- 创建 `enter.go`、`ApiGroupApp`、`ServiceGroupApp`、`RouterGroupApp`、`Container` 等旧 GVA 样板
- 添加包级 service 单例，如 `var XxxServiceApp = new(...)`
- 在 service 包中 import `server/global`
- 在 handler 中直接写数据库查询或业务流程

## 前端

- 在 `web/src/view/**` 中直接 import `@/utils/request`
- 把搜索/表格/表单/弹窗全部塞进一个 `index.vue`
- 普通业务开发中修改 `router/index.js`、`permission.js`、`utils/request.js`

## 流程

- 存在项目本地规范时跳过不读
- 顺便重构无关框架代码
