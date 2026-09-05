# Pi Database

A new multi-source Pi extension for MySQL and ClickHouse. It is independent from `pi-mysql` and `pi-clickhouse`; installing or testing it does not change those extensions or Pi global settings.

## Config

The extension reads `.pi/databases.json` from the current project or its nearest ancestor.

```json
{
  "version": 2,
  "enabled": true,
  "default_sources": {
    "mysql": "mysql_localhost",
    "clickhouse": "clickhouse_localhost"
  },
  "sources": [
    {
      "name": "mysql_localhost",
      "label": "MySQL Local",
      "dialect": "mysql",
      "allow_write": true,
      "write_confirm": false,
      "query_timeout_ms": 30000,
      "max_rows": 100,
      "options": {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "app_reader",
        "password_env": "APP_MYSQL_PASSWORD",
        "database": ""
      }
    },
    {
      "name": "clickhouse_localhost",
      "label": "ClickHouse Local",
      "dialect": "clickhouse",
      "allow_write": true,
      "write_confirm": false,
      "query_timeout_ms": 30000,
      "max_rows": 100,
      "options": {
        "url": "http://127.0.0.1:8123",
        "username": "analytics_reader",
        "password_env": "ANALYTICS_CLICKHOUSE_PASSWORD",
        "database": ""
      }
    }
  ]
}
```

Source names are globally unique and may contain letters, digits, underscores, dots, and hyphens. `label` is optional and is used only in the status view; it falls back to `name`, which remains the stable value for tool selection. `enabled` defaults to `true`; set it to `false` to deactivate the database tools, prompt context, and status badge for this project. Tool definitions remain registered so historical tool rows can keep their custom TUI rendering. `default_sources` maps each dialect to a configured source of the same dialect; omit either key when that dialect has no default. `password_env` takes precedence over `password` and fails clearly when the named environment variable is absent. `options.database` is optional; set it only when one database should be the source default. `query_timeout_ms` defaults to `30000`; `max_rows` defaults to `100` and is capped at `500`. The `database_query.max_rows` argument overrides its source default for that call. `allow_write` defaults to `true`; set it to `false` to make a source read-only. `write_confirm` defaults to `false`; set it to `true` for a source that should require interactive confirmation before writes. `INSERT ... SELECT` and destructive statements (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`) always require interactive confirmation regardless of `write_confirm`. Version 1 configurations and `default_source` are unsupported.

When a tool omits `source`, it must pass `dialect` (`mysql` or `clickhouse`) to use that dialect's configured default. An explicit `source` may be used instead and must match `dialect` when both are passed. A single configured source is selected automatically. Multiple sources with neither `source` nor `dialect` require an explicit choice. Without `options.database`, `database_list_tables` requires its `database` argument. `database_query` always requires its `database` argument, even when the source has a default database.

## Commands

- `/database status`: opens an interactive tree of configured sources (`↑↓` select, `Enter` expand/collapse details, `Esc` close).
- `/database on`: enables the plugin; creates a version 2 template when no local or inherited config exists.
- `/database off`: disables the plugin for the current project.

The `/database` command is always available, even before a `.pi/databases.json` exists; `status` reports the missing-config error and `on` creates a template without overwriting an existing config. Tool definitions are registered at startup so persisted tool rows can recover their custom TUI renderers; the `database_*` tools are active only when a config file is found and `enabled` is not `false`.

The footer status badge shows only plugin state: `database: on` or `database: off`. An invalid config shows `database: config error` in red. Use `/database status` to inspect sources in a compact list.

## Tools

- `database_list_sources`
- `database_ping`
- `database_list_databases`
- `database_list_tables`
- `database_search_tables`
- `database_describe_table`
- `database_query`
- `database_write`

Every result identifies its source and dialect. Source-selecting tools accept optional `source` and `dialect` parameters; use `dialect` to choose its configured default when `source` is omitted. Results are bounded to 500 rows/tables, 50KB total output, and 2,000 characters per cell or metadata text field. `database_query` is read-only and blocks lock, file, and time-wait operations (MySQL `FOR UPDATE`, `LOCK IN SHARE MODE`, `INTO OUTFILE/DUMPFILE`, `LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `MASTER_POS_WAIT`; ClickHouse `INTO OUTFILE`, `sleep`/`sleepEachRow`). `database_write` runs only when `allow_write: true` on the selected source and asks for interactive confirmation when `write_confirm: true` is configured for that source; restricted `INSERT ... SELECT`, destructive statements, and ClickHouse `CREATE OR REPLACE MATERIALIZED VIEW` always ask (see below). Table-scoped writes require its `database` argument; only `CREATE DATABASE` and `DROP DATABASE` omit it.

Allowed writes:

```text
MySQL:
  INSERT ... VALUES
  INSERT ... SELECT (always confirmed)
  UPDATE ... WHERE
  DELETE ... WHERE (always confirmed)
  TRUNCATE [TABLE] <table> (always confirmed)
  DROP TABLE / DROP DATABASE (single object; always confirmed)
  RENAME TABLE <a> TO <b> (single pair; always confirmed)
  REPLACE INTO ... VALUES (always confirmed)
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  ALTER TABLE ... ADD COLUMN / ADD INDEX / ADD PRIMARY KEY / ADD UNIQUE / ADD FOREIGN KEY / ADD CONSTRAINT / ADD CHECK
  ALTER TABLE ... DROP COLUMN / DROP INDEX / DROP PRIMARY KEY / DROP FOREIGN KEY / DROP CONSTRAINT (always confirmed)
  ALTER TABLE ... MODIFY / CHANGE / RENAME COLUMN / RENAME INDEX / RENAME TO (always confirmed)
  ALTER TABLE ... ALTER COLUMN ... SET DEFAULT / DROP DEFAULT (always confirmed)
  ALTER TABLE ... CONVERT TO CHARACTER SET (always confirmed)

ClickHouse:
  INSERT ... VALUES
  INSERT ... SELECT (always confirmed)
  DELETE FROM ... WHERE (always confirmed)
  ALTER TABLE ... DELETE WHERE (always confirmed)
  TRUNCATE TABLE <table> (always confirmed)
  DROP TABLE / DROP DATABASE (single object; always confirmed)
  RENAME TABLE <a> TO <b> (single pair; always confirmed)
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  CREATE MATERIALIZED VIEW ... TO ... AS SELECT ...
  CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT ...
  ALTER TABLE ... ADD COLUMN
  ALTER TABLE ... DROP COLUMN / DROP PARTITION / RENAME COLUMN / MODIFY COLUMN / CLEAR COLUMN (always confirmed)
```

`INSERT ... SELECT` and destructive operations (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`, and destructive `ALTER`) run only when `allow_write: true` on the selected source and always go through interactive confirmation first, independent of `write_confirm`. They are accepted only in restricted forms: `INSERT ... SELECT` must be `INSERT INTO <table> [(columns)] SELECT ...`; `DELETE` and `ALTER TABLE ... DELETE` require a `WHERE` clause; `DROP` and `TRUNCATE` are single-object; `RENAME` is a single pair; `REPLACE` is `VALUES`-only; destructive `ALTER` is limited to single actions like `DROP COLUMN`, `MODIFY`, `CHANGE`, `RENAME COLUMN`, or `CLEAR COLUMN` (MySQL allows several comma-separated actions as long as each is ADD or a supported destructive action). Any other form is rejected.

ClickHouse materialized views use the normal create policy: `write_confirm` controls whether creation asks for confirmation, including the supported `ON CLUSTER` variants. Only `CREATE MATERIALIZED VIEW ... TO ... AS SELECT ...` and `CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT ...` are supported. The `CREATE OR REPLACE` variant of those forms is allowed but always requires interactive confirmation. `POPULATE`, refreshable/window views, `DEFINER`, and `SQL SECURITY` are rejected.

Replacement writes, drops, truncates, renames, derived table creation, destructive `ALTER` outside the supported restricted actions, ClickHouse mutations (except the restricted `ALTER TABLE ... DELETE WHERE` and destructive actions), `ON CLUSTER` outside the supported materialized-view forms, other admin operations, and multiple statements are rejected (the restricted `INSERT ... SELECT` and destructive forms are available through `database_write` when `allow_write: true`, always with confirmation). `database_write` accepts one SQL statement per call; for multi-step operations, use separate calls, handle each result independently, pass `database` instead of `USE`, and do not assume atomic execution. If a confirmed write times out or loses its connection, the result reports `outcome: "unknown"`; inspect with `database_query` or metadata tools before any further action, and never retry automatically.

## Discovery workflow

Use `database_search_tables` when the target table is unknown or described in business terms. Use `database_describe_table` before guessing columns, indexes, or table shape. Use `database_list_tables` only when the database is already known and a directory-style listing is enough.

## Development

```bash
npm install
npm run check
```

Temporary-load the extension without changing global settings:

```bash
pi --no-extensions -e ./index.ts
```
