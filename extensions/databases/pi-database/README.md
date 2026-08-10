# Pi Database

A new multi-source Pi extension for MySQL and ClickHouse. It is independent from `pi-mysql` and `pi-clickhouse`; installing or testing it does not change those extensions or Pi global settings.

## Config

The extension reads `.pi/databases.json` from the current project or its nearest ancestor.

```json
{
  "version": 1,
  "default_source": "",
  "sources": [
    {
      "name": "mysql_localhost",
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

Source names are globally unique and may contain letters, digits, underscores, dots, and hyphens. `password_env` takes precedence over `password` and fails clearly when the named environment variable is absent. `options.database` is optional; set it only when one database should be the source default. `query_timeout_ms` defaults to `30000`; `max_rows` defaults to `100` and is capped at `500`. The `database_query.max_rows` argument overrides its source default for that call. `allow_write` defaults to `true`; set it to `false` to make a source read-only. `write_confirm` defaults to `false`; set it to `true` for a source that should require interactive confirmation before writes. `INSERT ... SELECT` and destructive statements (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`) always require interactive confirmation regardless of `write_confirm`.

When a tool omits `source`, it uses `default_source`; a single configured source is also selected automatically. Multiple sources without a default require an explicit source name. Without `options.database`, `database_list_tables` requires its `database` argument. `database_query` always requires its `database` argument, even when the source has a default database.

## Commands

- `/database-init`: creates a version 1 template only when no local or inherited config exists.
- `/database-status`: opens an interactive tree of configured sources (`↑↓` select, `Enter` expand/collapse details, `Esc` close).

Both commands are always available, even before a `.pi/databases.json` exists; `database-status` reports the missing-config error and `database-init` never overwrites an existing config. The `database_*` tools are registered only when a config file is found.

The footer status badge shows the default source (or a `N sources` count when there is no default): `database: mysql-192.168.27.148 +1`. An invalid config shows `database: config error` in red.

## Tools

- `database_list_sources`
- `database_ping`
- `database_list_databases`
- `database_list_tables`
- `database_search_tables`
- `database_describe_table`
- `database_query`
- `database_write`

Every result identifies its source and dialect. Results are bounded to 500 rows/tables, 50KB total output, and 2,000 characters per cell or metadata text field. `database_query` is read-only. `database_write` runs only when `allow_write: true` on the selected source and asks for interactive confirmation when `write_confirm: true` is configured for that source; restricted `INSERT ... SELECT`, destructive statements, and ClickHouse `CREATE OR REPLACE MATERIALIZED VIEW` always ask (see below). Table-scoped writes require its `database` argument; only `CREATE DATABASE` and `DROP DATABASE` omit it.

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
  ALTER TABLE ... ADD COLUMN / ADD INDEX

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
```

`INSERT ... SELECT` and destructive operations (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`) run only when `allow_write: true` on the selected source and always go through interactive confirmation first, independent of `write_confirm`. They are accepted only in restricted forms: `INSERT ... SELECT` must be `INSERT INTO <table> [(columns)] SELECT ...`; `DELETE` and `ALTER TABLE ... DELETE` require a `WHERE` clause; `DROP` and `TRUNCATE` are single-object; `RENAME` is a single pair; `REPLACE` is `VALUES`-only. Any other form is rejected.

ClickHouse materialized views use the normal create policy: `write_confirm` controls whether creation asks for confirmation, including the supported `ON CLUSTER` variants. Only `CREATE MATERIALIZED VIEW ... TO ... AS SELECT ...` and `CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT ...` are supported. The `CREATE OR REPLACE` variant of those forms is allowed but always requires interactive confirmation. `POPULATE`, refreshable/window views, `DEFINER`, and `SQL SECURITY` are rejected.

Replacement writes, drops, truncates, renames, derived table creation, destructive `ALTER`, ClickHouse mutations (except the restricted `ALTER TABLE ... DELETE WHERE`), `ON CLUSTER` outside the supported materialized-view forms, other admin operations, and multiple statements are rejected (the restricted `INSERT ... SELECT` and destructive forms are available through `database_write` when `allow_write: true`, always with confirmation). If a confirmed write times out or loses its connection, the result reports `outcome: "unknown"`; inspect with `database_query` or metadata tools before any further action, and never retry automatically.

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
