# SQLKit Pi Extension

Pi native SQL extension with a unified `sql_*` tool surface and dialect adapters for MySQL and ClickHouse.

This is not a MySQL-only extension and does not reuse the existing ClickHouse extension. The design is datasource-first: a project can configure multiple SQL sources, each source declares its dialect, and pi gets the same discovery/query tools for both databases.

## Status

- Supported dialects: `mysql`, `clickhouse`
- Default policy: read-only query execution
- Config discovery: `.pi/sqlkit.json`, `.sqlkit.json`, then `sqlkit.json`, walking upward from the current cwd
- Reference repos: `ref/mcp-server-mysql-main` (`benborla/mcp-server-mysql`) and `ref/mcp-main` (`mariadb/mcp`)

## Agent-Facing Tool Guide

Use the `sql_*` tools as a staged workflow, not as a flat bag of capabilities.

### Current Tool Surface

- `sql_upsert_source`
- `sql_list_sources`
- `sql_validate_config`
- `sql_ping`
- `sql_list_databases`
- `sql_list_tables`
- `sql_search_tables`
- `sql_describe_table`
- `sql_run_query`
- `sql_clickhouse_profile_query`
- `sql_explain_query`
- `sql_mysql_analyze_query`
- `sql_apply`

### 1. Pick the datasource first

- `sql_list_sources`: call this first when the project may define multiple datasources.
- `sql_validate_config`: call this when config, credentials, connectivity, or privileges may be stale.
- `sql_ping`: call this when the user is explicitly asking about connectivity or the target datasource may be down.

### 2. Orient before writing SQL

- `sql_list_databases`: use this when database/catalog names themselves matter.
- `sql_search_tables`: use this when the target table is unknown, the user gives business terms, or you need a broad discovery sample.
- `sql_list_tables`: use this only when the database is already known and you want a lightweight namespace directory.
- `sql_describe_table`: use this before writing SQL if exact column names, indexes, or table shape are not already known.

### 3. Query in increasing cost order

- `sql_run_query`: default execution tool for small, bounded read queries. Prefer this for initial sampling.
- `sql_clickhouse_profile_query`: ClickHouse-only runtime-cost tool. Use this when you need `system.query_log` evidence such as read rows/bytes, memory, duration, or top `ProfileEvents`.
- `sql_explain_query`: static plan/shape inspection tool. Use this before expensive joins, large scans, or when debugging query structure.
- `sql_mysql_analyze_query`: MySQL-only runtime execution analysis tool via `EXPLAIN ANALYZE`.
- `sql_apply`: guarded SQL change tool for a single allowed statement. It requires datasource apply opt-in and asks the user to confirm before execution.
- `sql_upsert_source`: configuration tool for creating or updating SQLKit sources. Prefer this over hand-editing `sqlkit.json`; it writes the canonical `dialect` + `options` schema.

### 4. Query-shape rules for agents

- Pass the original `SELECT` / `WITH` query to `sql_explain_query`, `sql_clickhouse_profile_query`, and `sql_mysql_analyze_query`.
- Do **not** prefix those tools with `EXPLAIN` yourself; the adapter adds the dialect-specific syntax.
- `sql_run_query` currently allows read-oriented statements such as `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN`, and `WITH` queries.
- `sql_run_query` rejects multiple statements and common write/admin/file-oriented patterns.
- Use `sql_apply` for user-requested allowed changes; do not use `sql_run_query` as a write fallback.
- `sql_apply` allows `INSERT`, `UPDATE`, `REPLACE`, `MERGE`, `CREATE DATABASE`, `CREATE TABLE`, and additive `ALTER TABLE ... ADD` statements.
- Do not use `sql_apply` for destructive/admin operations such as `DELETE`, `DROP`, `TRUNCATE`, destructive `ALTER`, grants, account changes, session changes, file operations, or unsupported `CREATE` forms.
- `sql_apply` never accepts a model-supplied confirmation parameter. It executes only after the user confirms through the UI for that tool call.
- If user confirmation is unavailable or cancelled, `sql_apply` returns `executed=false` and does not run SQL.
- If the datasource has not enabled `allow_apply`, `sql_apply` returns `executed=false`, `blocked=true`, and `requires_config_change` before retrying allowed apply statements.
- With datasource access policies enabled, prefer explicit `database.table` references.
- With datasource access policies enabled, ambiguous discovery SQL such as `SHOW TABLES` may be rejected; use discovery tools instead.

### 5. Result interpretation rules

- `sql_run_query` returns `result_profile`, a lightweight profile of the returned sample rows.
- Treat `result_profile` as sampled-result metadata, not full table statistics.
- `sql_clickhouse_profile_query` is ClickHouse-only. It runs the guarded query, returns the same bounded sample/result-profile shape as `sql_run_query`, adds a generated `query_id`, and then polls `system.query_log` for a best-effort `runtime_profile`.
- Large metadata-heavy tool results are also shaped for LLM context. For example, `sql_describe_table` may sample large column/index/relation arrays and truncate oversized `create_statement` text in context, while preserving the human-readable tool output.
- In interactive pi TUI, the primary SQL tools also use custom compact renderers so source/database/query summaries stay readable in collapsed tool rows.

Current explain/profile/analyze behavior:

- MySQL:
  - `sql_explain_query` modes: `plan`, `json`
  - `sql_mysql_analyze_query`: supported via `EXPLAIN ANALYZE`
- ClickHouse:
  - `sql_explain_query` modes: `plan`, `ast`, `syntax`, `pipeline`, `estimate`
  - `sql_clickhouse_profile_query`: supported via `system.query_log`; returns the sampled query result plus `query_id` and a best-effort `runtime_profile`
  - use `sql_explain_query` or `sql_clickhouse_profile_query` instead of the MySQL-only analyze tool

## Recommended Agent Flow

For most agent turns, follow this order unless the user already gave a precise datasource/table/query and the skipped steps are truly unnecessary:

1. **Identify the datasource** with `sql_list_sources`.
2. **Validate configuration changes** with `sql_validate_config`; by default it checks structure, connectivity, and basic permissions. Use `check_connections=false` only for an explicit lightweight structural check.
3. **Orient the namespace** with `sql_list_databases` when database/catalog names matter.
4. **Find the object** with `sql_search_tables` when the table is unknown, or `sql_list_tables` when the database is already known.
5. **Inspect the object** with `sql_describe_table` before guessing columns.
6. **Sample the data** with `sql_run_query` using a small `max_rows`.
7. **Diagnose cost or shape** only after the likely query is known:
   - ClickHouse runtime evidence: `sql_clickhouse_profile_query`
   - Static plan inspection: `sql_explain_query`
   - MySQL runtime execution analysis: `sql_mysql_analyze_query`
8. **Run allowed database changes only on explicit user request** with `sql_apply`; expect a user confirmation prompt before execution.

Agent heuristics:

- If the user gives business language, discover first; do not jump directly to handwritten SQL.
- If the datasource is unfamiliar, prefer discovery tools over `sql_run_query`.
- If the datasource dialect is uncertain, call `sql_list_sources` and use the returned `dialect` before choosing profile/analyze tools.
- If access policies are enabled, discovery belongs in discovery tools, not in ambiguous SQL.
- Prefer narrower follow-up queries over increasing `max_rows` too early.
- Treat `sql_apply` results literally: if `executed=false`, no mutation happened.
- When the user explicitly asks to create or edit SQLKit sources, prefer `sql_upsert_source` and then validate with `sql_validate_config`. Direct `sqlkit.json` edits require user confirmation and should be followed by validation.

## Install

From this directory:

```powershell
npm install
npm run verify:all
```

For the full development workflow, verification layers, CLI pitfalls, and print-mode debugging notes, see [DEVELOPMENT.md](./DEVELOPMENT.md). For the current SQLKit block-policy matrix, see [BLOCK-STRATEGY.md](./BLOCK-STRATEGY.md).

Load directly while developing:

```powershell
pi --no-extensions -e ./index.ts
```

Or from the repo root:

```powershell
pi --no-extensions -e ./extensions/sqlkit
```

Run a real print-mode tool flow with an explicit allowlist:

```powershell
pi --mode json -p -nbt -e ./index.ts -t 'sql_validate_config,sql_list_sources' "请必须先调用 sql_validate_config 工具，参数 check_connections=true；再调用 sql_list_sources；最后用中文总结。不要凭空回答。"
```

In PowerShell, pass `--tools/-t` as a single comma-separated string.

Interactive command entrypoint:

- `/sqlkit`: open the SQLKit source manager TUI
- `/sqlkit on`: enable SQLKit agent tools
- `/sqlkit off`: disable SQLKit agent tools
- `/sqlkit toggle`: toggle SQLKit agent tools
- `/sqlkit status`: show whether SQLKit agent tools are enabled

SQLKit keeps the `sql_upsert_source` and `sql_validate_config` configuration tools active so agents can create sources without hand-editing `sqlkit.json` and validate the result afterward. SQLKit activates the datasource discovery/query/apply tools by default when the current project has at least one configured source. Use `/sqlkit off` or `Ctrl+O` to keep datasource runtime tools out of the active agent prompt; use `/sqlkit on` to enable them again. The explicit toggle is persisted in the project config as `agent_tools.enabled`; automation can override the startup state with `SQLKIT_AUTO_ENABLE_TOOLS=1`.

## Project Config

Create one of these files in your project:

- `.pi/sqlkit.json`
- `.sqlkit.json`
- `sqlkit.json`

Start from [examples/sqlkit.example.json](./examples/sqlkit.example.json). Prefer `password_env` for secrets:

Agent reads and edits of these config files require explicit user confirmation at tool-call time; if confirmation is unavailable or cancelled, SQLKit blocks the access and leaves `sqlkit.json` unread and unchanged. This is distinct from SQL execution: changing config does not bypass the guarded `sql_run_query` and `sql_apply` execution rules.

For this local workspace, [.pi/sqlkit.example.json](./.pi/sqlkit.example.json) is a plaintext MySQL/ClickHouse sample using the known WSL Docker test credentials. Copy it into a project as `.pi/sqlkit.json` only for local testing.

```json
{
  "agent_tools": {
    "enabled": false
  },
  "sources": [
    {
      "name": "mysql_local",
      "dialect": "mysql",
      "read_only": true,
      "allow_apply": false,
      "access": {
        "databases": {
          "allow": ["app_db"],
          "deny": ["mysql", "sys", "performance_schema", "information_schema"]
        },
        "tables": [
          {
            "database": "app_db",
            "allow": ["users", "orders", "order_*"],
            "deny": ["audit_log", "payments_secret"]
          }
        ]
      },
      "options": {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "readonly_user",
        "password_env": "SQLKIT_MYSQL_PASSWORD",
        "database": "app_db"
      }
    },
    {
      "name": "clickhouse_local",
      "dialect": "clickhouse",
      "read_only": true,
      "access": {
        "databases": {
          "allow": ["default", "analytics"]
        },
        "tables": [
          {
            "database": "analytics",
            "allow": ["events_*", "daily_*"],
            "deny": ["raw_secrets"]
          }
        ]
      },
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

For MySQL, `options.password_env` is read before `options.password`. The same applies to ClickHouse if you need a password-protected user.

`sql_apply` checks `allow_apply` for every allowed apply statement, including `INSERT`, `UPDATE`, `REPLACE`, `MERGE`, `CREATE DATABASE`, `CREATE TABLE`, and additive `ALTER TABLE ... ADD`. The tool blocks destructive/admin operations such as `DELETE`, `DROP`, `TRUNCATE`, destructive `ALTER`, grants, account changes, session changes, file operations, and unsupported `CREATE` forms. Use least-privilege database accounts even when SQLKit apply tools are enabled.

ClickHouse accepts either `options.url` directly or host/port style. For host/port style, `options.secure=true` builds an HTTPS URL and defaults to port 8443; otherwise it defaults to HTTP port 8123. `options.pathname` and `options.proxy_path` are both accepted for proxy deployments.

`access` is optional, but recommended when you want long-lived agent sessions to stay inside an approved database/table scope. `sql_validate_config` emits a warning for datasources without an access policy because agents can otherwise discover every database/table visible to the database account:

- `access.databases.allow`: only these databases are visible
- `access.databases.deny`: these databases are always blocked
- `access.tables[].database`: optional database matcher for the table rule
- `access.tables[].allow`: only these tables are allowed for that database scope
- `access.tables[].deny`: these tables are always blocked for that database scope

Table patterns support `*` wildcards. `deny` wins over `allow`. `sql_search_tables` only returns visible tables. When an access policy is enabled, `sql_run_query` becomes stricter and may reject ambiguous statements like `SHOW TABLES` in favor of `sql_list_tables` / `sql_search_tables` / `sql_describe_table`. ClickHouse query-log search tools require a `database` or `table` filter under access policies and hide entries outside the allowed scope.

Current query-reference extraction is intentionally conservative. With an access policy enabled, `sql_run_query` / `sql_clickhouse_profile_query` / `sql_explain_query` / `sql_mysql_analyze_query` can safely validate common read patterns such as:

- direct `FROM db.table`
- `JOIN db.table`
- comma joins like `FROM db.a, db.b`
- quoted identifiers such as `` `db`.`table` `` or `[db].[table]`
- CTEs like `WITH x AS (SELECT ... FROM db.table) SELECT ... FROM x`
- subqueries like `FROM (SELECT ... FROM db.table) AS derived`

Some source expressions are rejected on purpose because they are harder to validate safely with policy rules, for example table-function style sources like `mysql(...)`, `s3(...)`, `url(...)`, or other function-like `name(...)` constructs. In those cases, prefer explicit `database.table` references or relax the datasource policy only if that is an intentional decision.

On `session_shutdown` and reload-like teardown flows, the extension closes MySQL pools and ClickHouse clients so long-lived pi sessions do not accumulate stale adapter state.

By default, `sql_validate_config` also performs an adapter-specific connection and capability self-check. Pass `check_connections=false` only when you need a lightweight structural check without database connections:

- MySQL: inspects `SHOW GRANTS` and flags elevated privileges such as `FILE`, `CREATE USER`, `INSERT`, `DROP`, or `ALL PRIVILEGES`
- ClickHouse: inspects `SHOW GRANTS`, `system.grants`, and relevant session settings like `readonly` / `allow_ddl`

These checks are advisory, not a hard security boundary. Local admin/root accounts will usually trigger warnings, which is expected during development.

## Local Smoke

The smoke script expects your local WSL Docker containers to expose:

- MySQL on `127.0.0.1:3306`
- ClickHouse HTTP on `127.0.0.1:8123`

Run:

```powershell
$env:SQLKIT_MYSQL_PASSWORD = "<mysql password>"
npm run verify:all:local
Remove-Item Env:\SQLKIT_MYSQL_PASSWORD
```

The local verification flow runs the basic checks, creates temporary configs, checks both dialects, validates a real pi agent flow, and removes temporary directories at the end. The MySQL password is passed through `SQLKIT_MYSQL_PASSWORD` and is not written into the generated config files.

If you only need the real database smoke script, run:

```powershell
$env:SQLKIT_MYSQL_PASSWORD = "<mysql password>"
npm run smoke:local
Remove-Item Env:\SQLKIT_MYSQL_PASSWORD
```

`verify:pi-agent-scenarios` uses a local mock OpenAI-compatible provider to make deterministic tool-call decisions while still executing real `pi` extension tools against local MySQL/ClickHouse, including ClickHouse `sql_clickhouse_profile_query` against `system.query_log` and MySQL `sql_mysql_analyze_query`.

## Safety Notes

For the current block-policy matrix covering query-tool limits, config protection, prompt guidance, and non-goals, see [BLOCK-STRATEGY.md](./BLOCK-STRATEGY.md).


The extension guard is intentionally conservative, but it is not the production security boundary. Use least-privilege database users. For MySQL, a root user with `FILE` privilege will trigger a warning during `sql_ping`; this is expected and useful for local testing, but production should use a restricted read-only account.

If you enable `access` policies, prefer fully-qualified table references in SQL queries. The extension will reject queries it cannot safely map onto the allowed database/table scope.

## Reference Analysis

`benborla/mcp-server-mysql` is useful as a MySQL-focused reference for connection handling, permission awareness, and read-only safety checks. Its downside for this project is that its tool surface and mental model are MySQL-centered, so extending it directly would leak MySQL assumptions into ClickHouse.

`mariadb/mcp` is useful for a more service-oriented MCP implementation and for MariaDB/MySQL query validation ideas. Its downside here is similar: it is not a pi-native extension, is Python/MCP-server shaped, and does not solve a unified multi-dialect datasource model.

This extension borrows the safety lessons, not the architecture.
