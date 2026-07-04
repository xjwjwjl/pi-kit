# clickhouse-client

Pi native ClickHouse extension written in TypeScript.

## Config file

This extension now reads config from the current project instead of environment variables.

It searches upward from the current project directory for any of these files:

- `.pi/clickhouse-client.json`
- `.clickhouse-client.json`
- `clickhouse-client.json`

Recommended location:

- `.pi/clickhouse-client.json`

## Example config

```json
{
  "url": "http://localhost:8123",
  "username": "default",
  "password": "",
  "database": "default",
  "allow_write_access": false,
  "allow_drop": false
}
```

Or host/port style:

```json
{
  "host": "localhost",
  "port": 8123,
  "secure": false,
  "username": "default",
  "password": "",
  "database": "default"
}
```

## Supported config fields

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
- `allow_drop`

## Tools

- `clickhouse_ping`
- `clickhouse_list_databases`
- `clickhouse_list_tables` (tables grouped by engine type with reader-friendly group labels and counts)
- `clickhouse_run_query`

Each tool result includes the config file path used for the current project.

## Install dependencies

From this directory:

```bash
npm install
```

## Load in pi

Project-local auto-discovery path:

- `.pi/extensions/clickhouse-client/index.ts`

Then restart pi or run `/reload`.
