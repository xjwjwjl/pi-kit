# Pi ClickHouse

Pi native ClickHouse extension written in TypeScript.

## Config file

Both database extensions read only `.pi/databases.json` from the current project or its nearest ancestor. MySQL reads the `mysql` object; ClickHouse reads the `clickhouse` object. With `pi-mysql` loaded, run `/database-init` to create the shared template without overwriting an existing or inherited config.

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

`clickhouse` may use `host`, `port`, and `secure` instead of `url`.

## Supported `clickhouse` fields

- `url`
- `host`
- `port`
- `secure`
- `username` or `user`
- `password`
- `database`
- `pathname` or `proxy_path`
- `request_timeout_ms`
- `send_receive_timeout` (seconds)
- `allow_write_access`

## Tools

- `clickhouse_ping`
- `clickhouse_list_databases`
- `clickhouse_list_tables` (tables grouped by engine type with reader-friendly group labels and counts)
- `clickhouse_run_query`
- `clickhouse_write`

Each tool result includes the config file path used for the current project.

## Writes

`clickhouse_run_query` is read-only. Set `allow_write_access` to `true` to enable `clickhouse_write`; every write prompts for interactive confirmation and does not run without it.

`clickhouse_write` accepts one statement in these forms:

- `INSERT INTO ... VALUES ...`
- `CREATE TABLE ... (...)`
- `ALTER TABLE ... ADD COLUMN ...`

It rejects deletes, drops, truncates, renames, ClickHouse mutations, `INSERT SELECT`, `ON CLUSTER`, system or account operations, and multi-statement SQL. Use a database account with only the privileges required for the intended writes.

## Install dependencies

From this directory:

```bash
npm install
```

## Load in pi

Project-local auto-discovery path:

- `.pi/extensions/databases/pi-clickhouse/index.ts`

Then restart pi or run `/reload`.
