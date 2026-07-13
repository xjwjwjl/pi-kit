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
      "name": "clickhouse_localhost"
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

Source names are globally unique and may contain letters, digits, underscores, and hyphens. `password_env` takes precedence over `password` and fails clearly when the named environment variable is absent. `options.database` is optional; set it only when one database should be the source default. `query_timeout_ms` defaults to `30000`; `max_rows` defaults to `100` and is capped at `500`. The `database_query.max_rows` argument overrides its source default for that call. `allow_write` defaults to `true`. `write_confirm` defaults to `false`; set it to `true` for a source that should require interactive confirmation before writes.

When a tool omits `source`, it uses `default_source`; a single configured source is also selected automatically. Multiple sources without a default require an explicit source name. Without `options.database`, `database_list_tables` requires its `database` argument. `database_query` always requires its `database` argument, even when the source has a default database.

## Commands

- `/database-init`: creates a version 1 template only when no local or inherited config exists.
- `/database-migrate`: after confirmation, converts the legacy `{ "mysql": { ... }, "clickhouse": { ... } }` format to version 1.

Neither command overwrites an existing config without an explicit migration confirmation.

## Tools

- `database_list_sources`
- `database_ping`
- `database_list_databases`
- `database_list_tables`
- `database_search_tables`
- `database_describe_table`
- `database_query`
- `database_write`

Every result identifies its source and dialect. Results are bounded to 500 rows/tables, 50KB total output, and 2,000 characters per cell or metadata text field. `database_query` is read-only. `database_write` runs only when `allow_write: true` on the selected source and asks for interactive confirmation only when `write_confirm: true` is configured for that source. Table-scoped writes require its `database` argument; only `CREATE DATABASE` omits it.

Allowed writes:

```text
MySQL:
  INSERT ... VALUES
  UPDATE ... WHERE
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  ALTER TABLE ... ADD COLUMN / ADD INDEX

ClickHouse:
  INSERT ... VALUES
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  ALTER TABLE ... ADD COLUMN
```

Deletes, replacement writes, drops, truncates, renames, derived table creation, `INSERT SELECT`, destructive `ALTER`, ClickHouse mutations, `ON CLUSTER`, other admin operations, and multiple statements are rejected. If a confirmed write times out or loses its connection, the result reports `outcome: "unknown"`; inspect with `database_query` or metadata tools before any further action, and never retry automatically.

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
