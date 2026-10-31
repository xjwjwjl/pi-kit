# Pi Database

A multi-source Pi extension for MySQL and ClickHouse. It also exposes a `database_usql` fallback that runs one statement through the local [usql](https://github.com/xo/usql) binary against any database the configured sources cannot reach.

## Config

DBX MySQL and ClickHouse connections are loaded from the local DBX profile by default. Optionally, the extension reads `.pi/databases.json` from the current project or its nearest ancestor when you want custom sources or `default_sources`.

```json
{
  "version": 2,
  "dbx_connections": true,
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

Source names are globally unique and may contain letters, digits, underscores, dots, and hyphens. `label` is optional and is used only in the status view; it falls back to `name`, which remains the stable value for tool selection. Database tools default to off for every project. Project settings are stored in `<cwd>/.pi/settings.json` under `piDatabase`: `toolsEnabled` controls database tool activation, and `dbxImportEnabled` controls DBX connection import. Use `/database on` and `/database off` to control tools. The optional `enabled` field in `.pi/databases.json` is honored only as a fallback when `toolsEnabled` is absent. Tool definitions remain registered so historical tool rows can keep their custom TUI rendering. `default_sources` maps each dialect to a configured source of the same dialect; omit either key when that dialect has no default. `password_env` takes precedence over `password` and fails clearly when the named environment variable is absent. `options.database` is optional; set it only when one database should be the source default. `query_timeout_ms` defaults to `30000`; `max_rows` defaults to `100` and is capped at `500`. The `database_query.max_rows` argument overrides its source default for that call. `allow_write` defaults to `true`; set it to `false` to make a source read-only. `write_confirm` defaults to `false`; set it to `true` for a source that should require interactive confirmation before writes. `INSERT ... SELECT` and destructive statements (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`) always require interactive confirmation regardless of `write_confirm`. Version 1 configurations and `default_source` are unsupported.

The corresponding `.pi/settings.json` fragment looks like this:

```json
{
  "piDatabase": {
    "toolsEnabled": false,
    "dbxImportEnabled": true
  }
}
```

Supported local DBX MySQL and ClickHouse connections are the default sources, including when `.pi/databases.json` is absent. Set `dbx_connections` to `false` in a custom config or use `/database dbx off` to disable this import for the project. Imported sources use a readable name derived from the DBX connection name (`dbx-<connection-name>`, lowercased with unsupported characters replaced); the name falls back to `dbx-<connection-id>` when the connection name is missing or unusable, and a numeric suffix (`-2`, `-3`, …) is appended when names collide with project sources or other DBX connections. The connection name is also accepted as a `source` alias and is shown as the display label in status and source listings. The extension reads DBX's SQLite profile read-only and resolves saved passwords from DBX's encrypted secret store only when a native database client is created. Credentials are never written into `.pi/databases.json`, tool results, or logs. DBX connections marked `read_only` or `is_production` cannot be written; other imported DBX sources require interactive confirmation for every `database_write` call and still use pi-database's SQL allowlist. DBX MCP-specific policies do not apply to these direct connections.

DBX import requires a Node.js runtime with the built-in `node:sqlite` module. On Windows, saved passwords are unlocked through the current user's Windows Credential Manager entry. Headless profiles can set `DBX_SECRET_KEY_FILE` or `DBX_SECRET_KEY` to the existing DBX key; passphrase-form keys use Node.js 24.7 or later. This direct credential-store integration supports Windows Credential Manager and DBX key files; other operating systems can use an explicit supported key file. The DBX profile path defaults to `%APPDATA%/com.dbx.app/dbx.db`; set `PI_DATABASE_DBX_DB_PATH` to override it for a custom profile.

When a tool omits `source`, it must pass `dialect` (`mysql` or `clickhouse`) to use that dialect's configured default. An explicit `source` may be used instead and must match `dialect` when both are passed. A single configured source is selected automatically. Multiple sources with neither `source` nor `dialect` require an explicit choice. Without `options.database`, `database_list_tables` requires its `database` argument. `database_query` always requires its `database` argument, even when the source has a default database.

## Commands

- `/database list`: opens an interactive tree of configured sources (`↑↓` select, `Enter` expand/collapse details, `Esc` close).
- `/database config init`: creates an optional version 2 `.pi/databases.json` for custom sources or `default_sources`, without overwriting an existing or inherited config. It does not opt the project in.
- `/database on`: enables database tools for the current project and saves the state in `.pi/settings.json`. It does not create `.pi/databases.json`; DBX connections are used by default.
- `/database off`: disables the plugin for the current project and saves the state in `.pi/settings.json`.
- `/database dbx on` / `/database dbx off`: persist whether the current project imports connections from the local DBX profile. This does not change the tool enablement state.
- `/database trust`: list sources/databases trusted for the current session.
- `/database trust off`: clear all session trust.

The `/database` command is always available. Tool definitions are registered at startup so persisted tool rows can keep their custom TUI rendering, but all database tools (including `database_usql`) are inactive by default. `piDatabase.toolsEnabled` in `<cwd>/.pi/settings.json` controls project enablement; when absent, it defaults to `false`.

The footer status badge is hidden while database tools are off and shows `database: on` while enabled; trusted session targets are appended as `· trusted: ...`. An invalid config shows `database: config error` in red. Use `/database list` to inspect sources in a compact list.

## Tools

- `database_list_sources`
- `database_ping`
- `database_list_databases`
- `database_list_tables`
- `database_search_tables`
- `database_describe_table`
- `database_query`
- `database_write`
- `database_usql`

Every result identifies its source and dialect. Source-selecting tools accept optional `source` and `dialect` parameters; use `dialect` to choose its configured default when `source` is omitted. Results are bounded to 500 rows/tables, 50KB total output, and 2,000 characters per cell or metadata text field. `database_query` is read-only and blocks lock, file, and time-wait operations (MySQL `FOR UPDATE`, `LOCK IN SHARE MODE`, `INTO OUTFILE/DUMPFILE`, `LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `MASTER_POS_WAIT`; ClickHouse `INTO OUTFILE`, `sleep`/`sleepEachRow`). `database_write` runs only when `allow_write: true` on the selected source and asks for interactive confirmation when `write_confirm: true` is configured for that source; restricted `INSERT ... SELECT`, destructive statements, MySQL `CREATE OR REPLACE VIEW`, and ClickHouse `CREATE OR REPLACE MATERIALIZED VIEW` always ask (see below). Table-scoped writes require its `database` argument; only `CREATE DATABASE` and `DROP DATABASE` omit it.

All database tools declare an output schema and return JSON-normalized `structuredContent` to programmatic callers such as codemode scripts. The existing `content` text and TUI `details` remain available.

Allowed writes:

```text
MySQL:
  INSERT ... VALUES
  INSERT ... SELECT (always confirmed)
  UPDATE ... WHERE
  DELETE ... WHERE (always confirmed)
  TRUNCATE [TABLE] <table> (always confirmed)
  DROP TABLE / DROP VIEW / DROP DATABASE / DROP INDEX ... ON ... (single object; always confirmed)
  RENAME TABLE <a> TO <b> (single pair; always confirmed)
  REPLACE INTO ... VALUES (always confirmed)
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  CREATE INDEX [UNIQUE|FULLTEXT|SPATIAL] ... ON ... (...) (always confirmed)
  CREATE VIEW <view> [(columns)] AS SELECT ... (write_confirm controls confirmation)
  CREATE OR REPLACE VIEW <view> [(columns)] AS SELECT ... (always confirmed)
  ALTER TABLE ... ADD COLUMN / ADD INDEX / ADD PRIMARY KEY / ADD UNIQUE / ADD FOREIGN KEY / ADD CONSTRAINT / ADD CHECK
  ALTER TABLE ... DROP COLUMN / DROP INDEX / DROP KEY / DROP PRIMARY KEY / DROP FOREIGN KEY / DROP CONSTRAINT / DROP CHECK / DROP PARTITION (always confirmed)
  ALTER TABLE ... MODIFY / CHANGE / RENAME COLUMN / RENAME INDEX / RENAME TO (always confirmed)
  ALTER TABLE ... ALTER COLUMN ... SET DEFAULT / DROP DEFAULT (always confirmed)
  ALTER TABLE ... CONVERT TO CHARACTER SET (always confirmed)

ClickHouse:
  INSERT ... VALUES
  INSERT ... SELECT (always confirmed)
  DELETE FROM ... WHERE (always confirmed)
  ALTER TABLE ... DELETE WHERE (always confirmed)
  TRUNCATE TABLE <table> (always confirmed)
  DROP TABLE / DROP DATABASE / DROP VIEW / DROP DICTIONARY (single object; always confirmed)
  RENAME TABLE <a> TO <b> (single pair; always confirmed)
  CREATE DATABASE [IF NOT EXISTS] ...
  CREATE TABLE ... (...)
  CREATE VIEW <view> [(columns)] AS SELECT ... (always confirmed)
  CREATE DICTIONARY ... (...) (always confirmed)
  CREATE MATERIALIZED VIEW ... TO ... AS SELECT ...
  CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT ...
  OPTIMIZE TABLE <table> ... (always confirmed)
  ALTER TABLE ... ADD COLUMN / ADD INDEX
  ALTER TABLE ... DROP COLUMN / DROP PARTITION / DROP INDEX / RENAME COLUMN / MODIFY COLUMN / CLEAR COLUMN (always confirmed)
```

`INSERT ... SELECT` and destructive operations (`DELETE`, `TRUNCATE`, `DROP`, `RENAME`, `REPLACE`, and destructive `ALTER`) run only when `allow_write: true` on the selected source and always go through interactive confirmation first, independent of `write_confirm`. They are accepted only in restricted forms: `INSERT ... SELECT` must be `INSERT INTO <table> [(columns)] SELECT ...`; `DELETE` and `ALTER TABLE ... DELETE` require a `WHERE` clause; `DROP` and `TRUNCATE` are single-object; `RENAME` is a single pair; `REPLACE` is `VALUES`-only; destructive `ALTER` is limited to single actions like `DROP COLUMN`, `DROP INDEX`, `DROP PARTITION`, `MODIFY`, `CHANGE`, `RENAME COLUMN`, or `CLEAR COLUMN` (MySQL allows several comma-separated actions as long as each is ADD or a supported destructive action). The added schema operations (`CREATE/DROP INDEX`, ClickHouse `CREATE/DROP VIEW`, `CREATE/DROP DICTIONARY`, `OPTIMIZE TABLE`, ClickHouse `ALTER TABLE ADD/DROP INDEX`) always require interactive confirmation. Any other form is rejected. The only exception to these confirmation rules is session trust, described below.

ClickHouse materialized views use the normal create policy: `write_confirm` controls whether creation asks for confirmation, including the supported `ON CLUSTER` variants. Only `CREATE MATERIALIZED VIEW ... TO ... AS SELECT ...` and `CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT ...` are supported. The `CREATE OR REPLACE` variant of those forms is allowed but always requires interactive confirmation. `POPULATE`, refreshable/window views, `DEFINER`, and `SQL SECURITY` are rejected.

MySQL `CREATE VIEW` uses the normal create policy: `write_confirm` controls confirmation. `CREATE OR REPLACE VIEW <view> [(columns)] AS SELECT ...` is accepted in the same restricted form (no `ALGORITHM`, `DEFINER`, or `SQL SECURITY` clauses) but always requires interactive confirmation. `DROP VIEW` is a single-object drop and always confirms.

Unsupported forms are rejected, including `REPLACE` other than MySQL `REPLACE INTO ... VALUES`, multi-object `DROP`/`TRUNCATE`/`RENAME`, derived table creation, destructive `ALTER` outside the supported restricted actions, ClickHouse mutations (except the restricted `ALTER TABLE ... DELETE WHERE` and destructive actions), `ON CLUSTER` outside the supported materialized-view forms, `CREATE FUNCTION` and other admin operations, and multiple statements. The restricted `INSERT ... SELECT` and destructive forms described above are available through `database_write` when `allow_write: true`, always with confirmation. `database_write` accepts one SQL statement per call; for multi-step operations, use separate calls, handle each result independently, pass `database` instead of `USE`, and do not assume atomic execution. If a confirmed write times out or loses its connection, the result reports `outcome: "unknown"`; inspect with `database_query` or metadata tools before any further action, and never retry automatically.

Blocked writes and confirmation outcomes include a `blocked_reason`:

- `source_read_only`: `allow_write` is false on the selected source. Do not bypass it.
- `missing_database`: a table-scoped write omitted `database`; pass it and retry.
- `unsupported_statement`: the statement form is outside the allowlist. The user may choose to run it through `database_usql` with confirmation, run it manually, or stop.
- `invalid_statement`: empty input, multiple statements, or other invalid input; fix the statement shape.
- `confirmation_required`: interactive confirmation is required but unavailable; no write ran.
- `cancelled`: the user declined confirmation; no write ran.

Only `unsupported_statement` is a candidate for explicit usql escalation. `source_read_only`, `missing_database`, `invalid_statement`, `confirmation_required`, and `cancelled` must not be bypassed with usql or another client.

### Session trust

In the TUI, a `database_write` confirmation also offers **Trust** (`t`) to trust the selected source and database for the rest of the session. This includes forced destructive confirmations, and is cleared on session start and shutdown. `/database trust` lists the trusted targets and `/database trust off` clears them. Session trust is not offered for `database_usql`, does not apply when `allow_write: false`, and is reported as `trusted_for_session: true`. It is the only exception to the "always confirmed" rules above.

## usql fallback

`database_usql` is the escape hatch for databases that have no configured source: PostgreSQL, SQLite, DuckDB, Trino, or any other dialect usql supports. It is also the explicit escalation path for a single statement that `database_write` rejects as `unsupported_statement`, but only after the user approves it. It takes a `connection` (a usql DSN such as `postgres://user:pass@host/db`, or a connection name defined in the usql config file) and a `statement`, and it runs them through the local `usql` binary with `-J -q -X -w -f`.

Arguments: `connection`, `statement`, optional `source` (bind the statement to a configured source's `allow_write` policy), and optional `max_rows` (default `100`, capped at `500`) and `timeout_ms` (default `30000`, capped at `300000`).

Behavior and limits:

- **It always asks for interactive confirmation.** Without `source`, `allow_write`, `write_confirm`, and the `database_write` statement allowlist do not apply; confirmation is the only guard. With `source`, writes and write-capable meta-commands require that source's `allow_write` and return `blocked_reason: "source_read_only"` otherwise. Never use it to bypass `blocked_reason: "source_read_only"` or `"missing_database"`. Session trust granted for `database_write` does not carry over to `database_usql`.
- **One statement per call.** Multi-statement input is rejected because usql JSON output cannot be split per statement reliably. Use separate calls for multi-step work and never assume atomic execution.
- **usql meta-commands are allowed**, including `\dt`, `\d <table>`, and `\copy`, which is the way to move data between two databases. When `source` is supplied, known read-only meta-commands remain allowed, while write-capable ones such as `\copy` require `allow_write`.
- Results are bounded like every other tool: `max_rows`, 50KB total, and 2,000 characters per cell. Non-row results such as `CREATE TABLE` return `Executed · 0 rows`, and raw text output is kept in `output`.
- Credentials stay in the DSN you pass, so they appear in the process argument list. Prefer a named connection from the usql config file, or a DSN without an embedded password. Confirmation dialogs and results always show the connection with the password replaced by `*****`.
- A non-zero exit code makes the call a failure and reports `stderr`. When a non-read statement fails after a timeout or a lost connection, the outcome is unknown: inspect the database before doing anything else and never retry automatically.

The tool activates only when the current project is enabled and a `usql` binary is found. Set `PI_DATABASE_USQL_BIN` to an explicit path, or set `PI_DATABASE_USQL=0` to switch the fallback off. `/database off` disables it for the current project.

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
