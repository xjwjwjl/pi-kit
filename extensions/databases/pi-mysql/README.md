# Pi MySQL

Pi native MySQL extension written in TypeScript.

## Config file

Both database extensions read only `.pi/databases.json` from the current project or its nearest ancestor. MySQL reads the `mysql` object; ClickHouse reads the `clickhouse` object.

## Initialize config

Run `/database-init` in pi to create a shared `.pi/databases.json` template in the current project. It includes both MySQL and ClickHouse sections with writes disabled. The command does not overwrite a local config or create a child override when a parent config is already discovered.

## Example config

```json
{
  "mysql": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "readonly_user",
    "password": "",
    "database": "app_db",
    "allow_write_access": false
  },
  "clickhouse": {
    "url": "http://localhost:8123",
    "username": "default",
    "password": "",
    "database": "default",
    "allow_write_access": false
  }
}
```

## Supported `mysql` fields

- `host`
- `port`
- `user`
- `username`
- `password`
- `database`
- `socketPath`
- `charset`
- `connect_timeout_ms`
- `query_timeout_ms`
- `pool_size`
- `ssl`
- `allow_write_access`

## Tools

- `mysql_ping`
- `mysql_list_databases`
- `mysql_list_tables`
- `mysql_run_query`
- `mysql_write`

Each tool result includes the config file path used for the current project.

## Writes

`mysql_run_query` is read-only. Set `allow_write_access` to `true` to enable `mysql_write`; every write prompts for interactive confirmation and does not run without it.

`mysql_write` accepts one statement in these forms:

- `INSERT INTO ... VALUES ...`
- `UPDATE ... SET ... WHERE ...`
- `CREATE TABLE ... (...)`
- `ALTER TABLE ... ADD COLUMN ...` or `ALTER TABLE ... ADD INDEX ...`

It rejects deletes, replacement writes, drops, truncates, renames, destructive `ALTER` operations, account or privilege changes, file operations, multi-statement SQL, and MySQL executable comments. Use a database account with only the privileges required for the intended writes.

## Install dependencies

From this directory:

```bash
npm install
npm run check
```

## Load in pi

Project-local auto-discovery path:

- `.pi/extensions/databases/pi-mysql/index.ts`

Then restart pi or run `/reload`.
