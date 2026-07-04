# Pi SQL Extension Design

## 1. 目标重定义

这次 extension 不再是“给 pi 做一个 MySQL 专用 extension”，而是：

> 做一个面向 `pi-coding-agent` 的通用 SQL extension，首期同时支持 MySQL 和 ClickHouse。

设计重点也随之变化：

- 不是围绕某一个数据库产品做能力堆叠
- 不是包装现成 MCP server
- 不是复用现有 `clickhouse-client` extension
- 而是做一层 pi 原生的、方言可插拔的 SQL 工具抽象

## 2. 约束与原则

### 2.1 设计约束

- 同一套 extension 要同时覆盖 MySQL 和 ClickHouse
- tool 名称和使用方式尽量统一，不让模型感知太多底层差异
- 底层连接、schema 查询、SQL 限制逻辑按方言适配
- v1 以只读能力为主
- 写能力必须显式 opt-in

### 2.2 设计原则

- tool 面统一，方言能力下沉到 adapter
- 配置驱动，不把连接信息写死进 extension
- 默认保守，尤其是多数据源和写权限
- 返回给 LLM 的结果结构稳定
- 返回给 UI 的结果简洁
- 对方言差异做显式建模，不假装所有 SQL 都一样

## 3. 为什么不能再按单库思路设计

如果按“先做 MySQL，再兼容 ClickHouse”的思路推进，通常会出现几个问题：

- tool 会天然偏向 MySQL 术语
- schema 和 metadata 查询会写死在某一套 `information_schema`
- 权限模型会混入某一家的安全语义
- 结果结构会不一致，后面再统一代价更高

所以这次更合理的方向是：

- 先定义“SQL extension 的宿主接口”
- 再分别实现 `mysql` 和 `clickhouse` 两个 adapter

## 4. 从参考项目里保留什么，不保留什么

本地参考仓库仍然保留：

- `D:\code\my-pi\extensions\sqlkit\ref\mcp-server-mysql-main`，对应 `benborla/mcp-server-mysql`
- `D:\code\my-pi\extensions\sqlkit\ref\mcp-main`，对应 `mariadb/mcp`

它们现在的角色只是：

- 参考 MySQL/MariaDB 的安全策略
- 参考 MCP 侧常见数据库工具命名
- 参考只读守卫、参数化、multi-statement 防御方式

明确不采用的东西：

- 不复用本地 `clickhouse-client` extension 的设计
- 不直接照搬 `mysql_query` 这种单 tool 模型
- 不直接包 Python MariaDB MCP 进 pi
- 不把任何一个数据库的能力模型当成“标准模型”

## 5. 总体架构

建议采用三层结构：

```txt
pi extension layer
  ├─ tool registration
  ├─ ui rendering
  ├─ context shaping
  └─ project config discovery

sql core layer
  ├─ datasource registry
  ├─ dialect-neutral tool contracts
  ├─ result shaping
  ├─ permission policy
  └─ query guard

dialect adapter layer
  ├─ mysql adapter
  └─ clickhouse adapter
```

### 5.1 extension layer 负责什么

- 向 pi 注册工具
- 管理 footer status
- 把 UI 文本和 LLM 结构化内容分开
- 处理项目配置发现
- 管理 datasource 选择和默认源

### 5.2 sql core layer 负责什么

- 定义统一的 tool 输入输出
- 把“列库 / 列表 / 描述表 / 跑查询”抽象成通用操作
- 做结果截断、错误包装、权限判断
- 做跨方言的最小安全守卫

### 5.3 adapter layer 负责什么

- 建连
- ping
- schema metadata 查询
- query 执行
- 方言级只读判断
- 方言级结果规范化

## 6. 核心抽象：DataSource + DialectAdapter

建议引入两个核心概念：

### 6.1 DataSource

表示一个可连接的数据源实例。

建议字段：

```ts
type SqlDialect = "mysql" | "clickhouse";

type DataSourceConfig = {
  name: string;
  dialect: SqlDialect;
  readOnly?: boolean;
  allowApply?: boolean;
  options: Record<string, unknown>;
};
```

### 6.2 DialectAdapter

每种数据库实现一组统一接口：

```ts
interface DialectAdapter {
  dialect: "mysql" | "clickhouse";
  ping(source: ResolvedDataSource, signal?: AbortSignal): Promise<PingResult>;
  listDatabases(source: ResolvedDataSource, signal?: AbortSignal): Promise<string[]>;
  listTables(
    source: ResolvedDataSource,
    input: { database?: string; like?: string },
    signal?: AbortSignal,
  ): Promise<ListTablesResult>;
  describeTable(
    source: ResolvedDataSource,
    input: { database?: string; table: string; includeRelations?: boolean },
    signal?: AbortSignal,
  ): Promise<DescribeTableResult>;
  runQuery(
    source: ResolvedDataSource,
    input: { query: string; maxRows: number },
    signal?: AbortSignal,
  ): Promise<QueryResult>;
}
```

这样可以保证：

- 对 pi 暴露统一 tool
- 对底层保留方言差异

## 7. 配置设计

这次不按“一个 extension 对应一个库连接”设计，而是按“一个 extension 管多个 datasource”设计。

建议项目配置文件候选路径：

- `.pi/sqlkit.json`
- `.sqlkit.json`
- `sqlkit.json`

建议结构：

```json
{
  "default_source": "app_mysql",
  "sources": [
    {
      "name": "app_mysql",
      "dialect": "mysql",
      "read_only": true,
      "allow_apply": false,
      "options": {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "root",
        "password": "",
        "database": "app_db",
        "ssl": false
      }
    },
    {
      "name": "analytics_ch",
      "dialect": "clickhouse",
      "read_only": true,
      "allow_apply": false,
      "options": {
        "url": "http://127.0.0.1:8123",
        "username": "default",
        "password": "",
        "database": "default"
      }
    }
  ]
}
```

### 7.1 配置设计要点

- `name` 是 tool 调用时的稳定 datasource 标识
- `dialect` 决定走哪个 adapter
- `default_source` 用于用户未指定时的默认连接
- 每个 source 可独立设置只读、写权限、DDL 权限
- `options` 由方言 adapter 自己解析

## 8. 建议的统一工具面

tool 设计不要暴露成 `mysql_*` 或 `clickhouse_*`，而应该统一成 `sql_*`。

### 8.1 `sql_list_sources`

- 用途：列出当前项目已配置的数据源
- 输出：
  - `sources`
  - `default_source`
  - `dialect`
  - `read_only`

这是多数据源场景下必须有的入口工具。

### 8.2 `sql_ping`

- 参数：
  - `source?`
- 输出：
  - `source`
  - `dialect`
  - `ok`
  - `server_version?`
  - `current_database?`
  - `warnings[]`

### 8.3 `sql_list_databases`

- 参数：
  - `source?`
- 输出：
  - `source`
  - `dialect`
  - `databases`

### 8.4 `sql_list_tables`

- 参数：
  - `source?`
  - `database?`
  - `like?`
- 输出：
  - `source`
  - `dialect`
  - `database`
  - `tables`
  - `count`

### 8.5 `sql_describe_table`

- 参数：
  - `source?`
  - `database?`
  - `table`
  - `include_relations?`
- 输出统一为：
  - `source`
  - `dialect`
  - `database`
  - `table`
  - `columns`
  - `indexes`
  - `relations`
  - `engine?`
  - `create_statement?`

注意：

- MySQL 能较完整提供 foreign keys / indexes
- ClickHouse 通常没有与 MySQL 对等的 FK 语义
- 所以 `relations` 在 ClickHouse 下通常为空
- 但返回结构仍然保持一致

### 8.6 `sql_run_query`

- 参数：
  - `source?`
  - `query`
  - `max_rows?`
- 输出：
  - `source`
  - `dialect`
  - `query_kind`
  - `columns`
  - `rows`
  - `row_count`
  - `truncated`
  - `duration_ms`
  - `warnings[]`

这是唯一一个“通用执行”工具，但也必须做强约束。

## 9. 为什么要统一成 `sql_*` 而不是按方言拆工具

如果拆成：

- `mysql_list_tables`
- `clickhouse_list_tables`

问题会很明显：

- 模型要先学会选方言工具
- 多数据源下 prompt 复杂度变高
- tool 数量翻倍
- 同一个任务跨库时上下文更混乱

统一成 `sql_*` 后，模型只需要学会：

- 先 `sql_list_sources`
- 再带 `source`
- 然后按统一工具面工作

这更符合 agent 的工作流。

## 10. MySQL 与 ClickHouse 的共性/差异建模

## 10.1 共性

可以抽象统一的部分：

- ping
- list databases
- list tables
- describe table
- run single query
- read-only mode
- result truncation

## 10.2 差异

必须明确建模的部分：

### MySQL

- 强事务语义
- 写操作类型更丰富
- `information_schema` 更标准
- 存在 `LOAD_FILE` / `OUTFILE` / `LOCAL INFILE` 等额外风险点
- foreign key 信息更完整

### ClickHouse

- 事务语义弱很多，更多是查询和 DDL/INSERT 语义
- metadata 更依赖 `system.tables` / `system.columns`
- engine 信息很重要
- 关系型外键信息通常缺失
- 查询结果可能非常大，截断和 LIMIT 注入策略更重要

## 11. 安全设计

既然支持多方言，安全也必须分成“通用层”和“方言层”。

## 11.1 通用层

- 默认只读
- 默认单语句
- 限制最大返回行数
- 限制总文本大小
- 所有写能力必须由配置显式开启

## 11.2 MySQL 方言层

- 禁止多语句
- 禁止 `LOAD_FILE`
- 禁止 `INTO OUTFILE`
- 禁止 `INTO DUMPFILE`
- 禁止本地文件导入
- 可选检查 `SHOW GRANTS`，若发现 `FILE` privilege 则告警

## 11.3 ClickHouse 方言层

- 只读模式下禁止：
  - `INSERT`
  - `ALTER`
  - `DROP`
  - `TRUNCATE`
  - `CREATE`
  - `RENAME`
  - `OPTIMIZE`
- 尽量要求单语句
- 对无 `LIMIT` 的查询做结果集保护

## 11.4 最重要的底线

客户端守卫永远只是第二道防线。

文档中必须明确：

- 真正的生产安全边界仍然是数据库账号权限
- MySQL 和 ClickHouse 都应该使用最小权限账号
- extension 的只读策略不能替代数据库侧权限收缩

## 12. 结果结构设计

需要同时服务两个对象：

- 用户 UI
- LLM

所以每个 tool 返回建议分两层：

- `content`
  - 简洁、适合 TUI 展示
- `details`
  - 稳定、结构化、适合 LLM 消费

例如 `sql_run_query`：

### UI 文本

```txt
Source: analytics_ch (clickhouse)
Query kind: select
Rows: 120 (truncated to 50)
Duration: 183 ms
```

### details

```json
{
  "source": "analytics_ch",
  "dialect": "clickhouse",
  "query_kind": "select",
  "columns": ["event_date", "cnt"],
  "rows": [["2026-06-01", 123]],
  "row_count": 50,
  "truncated": true,
  "duration_ms": 183,
  "warnings": []
}
```

## 13. pi 交互设计

## 13.1 footer status

只显示最关键状态，不展示过多数据库细节。

建议样式：

- `sql: 2 sources`
- `sql: app_mysql* + analytics_ch`
- `sql: no config`

其中：

- `*` 表示默认 source
- 如果默认 source 连接失败，可切成 `sql: default source unavailable`

## 13.2 上下文整形

建议在 `pi.on("context")` 中统一把以下工具的内容替换为 JSON 文本：

- `sql_list_sources`
- `sql_list_databases`
- `sql_list_tables`
- `sql_describe_table`
- `sql_run_query`

原因：

- UI 可以保持简洁
- 模型拿到的是稳定结构，而不是为展示服务的描述文字

## 13.3 datasource 选择策略

若 tool 未传 `source`：

- 优先使用 `default_source`
- 没有默认源且只有一个 source，则自动使用它
- 有多个 source 且无默认源，则返回明确错误，引导先调用 `sql_list_sources`

## 14. 技术选型建议

推荐：

- TypeScript
- `mysql2/promise` 负责 MySQL adapter
- `@clickhouse/client` 负责 ClickHouse adapter
- `typebox` 定义 tool schema

可选：

- SQL parser 只作为辅助，不作为唯一安全依据

不推荐：

- 把现有 ClickHouse extension 直接改造成多库版
- 用 Python 子进程统一承载 MySQL + ClickHouse
- v1 就做 embedding / vector / DDL orchestration

## 15. 建议目录结构

```txt
sqlkit/
  DESIGN.md
  package.json
  index.ts
  src/
    config.ts
    discovery.ts
    core/
      datasource.ts
      result.ts
      policy.ts
      errors.ts
    adapters/
      base.ts
      mysql.ts
      clickhouse.ts
    tools/
      list-sources.ts
      ping.ts
      list-databases.ts
      list-tables.ts
      describe-table.ts
      run-query.ts
    ui/
      format.ts
      status.ts
```

## 16. v1 范围

建议 v1 只做：

- `sql_list_sources`
- `sql_ping`
- `sql_list_databases`
- `sql_list_tables`
- `sql_describe_table`
- `sql_run_query`

并且：

- MySQL 和 ClickHouse 都只支持只读
- 不做写操作
- 不做建库
- 不做建表
- 不做向量检索
- 不做远程 MCP 服务模式

这是最稳的第一版。

## 17. 后续扩展路线

### Phase 2

- datasource 级写权限开关
- schema/database 级权限控制
- 更完整的 grants / capability self-check
- ClickHouse engine-aware table summaries

### Phase 3

- 写操作工具拆分，而不是继续依赖 `sql_run_query`
- 例如：
  - `sql_insert_rows`
  - `sql_execute_statement`
- 这样能减少 LLM 直接生成危险 SQL 的概率

### Phase 4

- 如果确实有业务需要，再考虑：
  - 向量能力
  - 跨源对比
  - explain / analyze
  - query templates

## 18. 最终设计结论

最终推荐方案是：

- 做一个 **pi 原生、统一 `sql_*` 工具面、方言 adapter 可插拔** 的 SQL extension
- 首批支持：
  - `mysql`
  - `clickhouse`
- 默认只读
- 多数据源配置
- UI 和 LLM 输出分离
- 不复用现有 `clickhouse-client` 设计

一句话概括：

> 这不是一个 MySQL extension，也不是一个 ClickHouse extension，而是一个以 datasource 和 dialect adapter 为核心的通用 SQL extension。

## 19. 下一步建议

如果继续实现，建议直接按这个顺序开工：

1. 初始化 `package.json` 和 `index.ts`
2. 定义配置发现与 `DataSourceConfig`
3. 实现 `DialectAdapter` 抽象
4. 先落地 `mysql` 与 `clickhouse` 两个 adapter 的只读 `ping/list/describe/query`
5. 再注册统一的 `sql_*` tools
