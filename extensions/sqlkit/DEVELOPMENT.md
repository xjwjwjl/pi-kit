# Development and E2E Notes

This document captures the recommended development loop for `sqlkit`, plus the debugging lessons learned while validating real `pi` print-mode tool calls.

For the current SQLKit block-policy matrix, see [BLOCK-STRATEGY.md](./BLOCK-STRATEGY.md).

## Scope

`sqlkit` has four distinct verification layers:

1. Pure TypeScript and local logic checks.
2. Extension registration checks.
3. Real `pi` runtime loading checks.
4. End-to-end tool-call checks, first with a local mock provider, then with real databases.

Do not rely on only one layer. A passing `tsc` or factory registration check does not prove that `pi --mode json -p` can actually see and call the tools.

## Recommended Development Loop

Run these from the extension root:

```powershell
npm run verify:all
```

When the feature depends on real database behavior, also run:

```powershell
$env:SQLKIT_MYSQL_PASSWORD = "<mysql password>"
npm run verify:all:local
Remove-Item Env:\SQLKIT_MYSQL_PASSWORD
```

## Verification Layers

### 1. `npm run check`

Purpose:
- TypeScript compile-time validation.
- Fast feedback for shim types, script changes, and tool signatures.

What it does not prove:
- Extension factory registration.
- `pi` runtime loading.
- Real tool exposure to the model.

### 2. `npm run test:v1`

Purpose:
- Read-only SQL guard checks.
- Result shaping, truncation, and sampled `result_profile` checks.
- Config validation behavior that does not need a live provider.

Use this when changing:
- `src/guards.ts`
- `src/limits.ts`
- config shape or config validation logic

### 3. `npm run verify:extension`

Purpose:
- Confirms the extension factory registers the expected `sql_*` tools.
- Confirms the expected event hooks are registered.

This is a factory-level test only. It does not prove that `pi` runtime state contains those tools later.

### 4. `npm run verify:pi-load`

Purpose:
- Confirms `pi` can load the extension in real runtime startup.
- Confirms `session_start` runs and `ctx.ui.setStatus()` works.

This catches:
- broken extension entrypoints
- import/runtime failures
- extension loading regressions

This still does not prove that print-mode tool calling works end-to-end.

### 5. `npm run verify:pi-print`

Purpose:
- Confirms real `pi --mode json -p` can expose the extension tools to the model.
- Confirms the model-facing tool allowlist is correct.
- Confirms a full tool flow works:
  - `sql_validate_config`
  - `sql_list_sources`
  - final Chinese summary

Implementation notes:
- Uses a local mock OpenAI-compatible provider.
- Does not depend on your global default provider, online auth, or external model behavior.
- This makes the regression stable and suitable for CI-like local development.

This is the most important regression for the class of issue we hit during development.

### 6. `npm run verify:pi-write-blocks`

Purpose:
- Confirms blocked write/admin requests do not cause the agent to spiral into retries.
- Uses a local mock OpenAI-compatible provider.
- Verifies blocked `sql_run_query` calls still allow the assistant to continue and explain the limitation in Chinese.

Current scenarios:
- `CREATE TABLE`
- `ALTER TABLE ... DROP COLUMN`

This catches regressions where:
- blocked SQL disappears from model-visible context
- the turn terminates too early for a natural-language explanation
- the agent keeps trying extra SQL tools after a hard policy block

### 7. `npm run verify:all`

Purpose:
- Runs the default non-database verification chain.
- Expands to:
  - `npm run check`
  - `npm run test:v1`
  - `npm run verify:extension`
  - `npm run verify:pi-load`
  - `npm run verify:pi-print`
  - `npm run verify:pi-write-blocks`

Use this before handing off normal code or documentation changes.

### 8. `npm run smoke:local`

Purpose:
- Verifies actual MySQL and ClickHouse adapters against local services.
- Proves end-to-end datasource behavior beyond mocked provider interactions.

Current assumptions:
- MySQL reachable on `127.0.0.1:3306`
- ClickHouse HTTP reachable on `127.0.0.1:8123`

### 9. `npm run verify:pi-agent-scenarios`

Purpose:
- Confirms a real `pi --mode json -p` agent flow can call multiple SQL tools in sequence.
- Uses a local mock OpenAI-compatible provider for deterministic tool-call decisions.
- Executes real extension tools against local MySQL/ClickHouse config in a temporary project.

Current scenario:
- `sql_list_sources`
- `sql_search_tables`
- `sql_describe_table`
- `sql_run_query`
- `sql_clickhouse_profile_query`
- `sql_explain_query`
- `sql_mysql_analyze_query`
- `sql_apply`

This catches issues that simple print-mode verification does not, such as multi-turn tool-result reshaping, agent follow-up tool calls, ClickHouse table search, `sql_run_query` `result_profile` visibility, ClickHouse `sql_clickhouse_profile_query` runtime-profile shaping, and MySQL `sql_mysql_analyze_query` behavior inside a real pi loop.

### 10. `npm run verify:all:local`

Purpose:
- Runs the full local confidence suite.
- Expands to `verify:all`, `smoke:local`, and `verify:pi-agent-scenarios`.
- Requires local MySQL/ClickHouse services and `SQLKIT_MYSQL_PASSWORD`.

## Manual Real-Provider E2E

When you want to test against your real configured provider instead of the mock verification script, use:

```powershell
pi --mode json -p -nbt -e ./index.ts -t 'sql_validate_config,sql_list_sources' "请必须先调用 sql_validate_config 工具，参数 check_connections=true；再调用 sql_list_sources；最后用中文总结。不要凭空回答。"
```

Why this form matters:
- `-nbt` disables built-in tools but keeps extension/custom tools available.
- `-t` should be a single comma-separated allowlist string.
- In PowerShell, quote the whole allowlist string.

## Important CLI Pitfalls

### `--tools/-t` does not append

This is the biggest lesson from the print-mode debugging work.

Wrong:

```powershell
pi ... -t sql_validate_config -t sql_list_sources ...
```

Effect:
- the last `-t` wins
- earlier values are overwritten

Correct:

```powershell
pi ... -t 'sql_validate_config,sql_list_sources' ...
```

### Always quote comma-separated tool lists in PowerShell

Recommended:

```powershell
-t 'sql_validate_config,sql_list_sources'
```

This avoids shell parsing surprises and keeps the allowlist shape explicit.

### `-nbt` and `-nt` mean different things

- `-nbt` / `--no-builtin-tools`
  - disables built-in tools
  - keeps extension/custom tools available
  - preferred for focused extension E2E

- `-nt` / `--no-tools`
  - disables everything by default
  - use only when you intentionally want a fully locked-down run

### Temporary provider configs now prefer `$ENV_VAR` references

When generating temporary `models.json` files for local verification, use:

```json
{
  "apiKey": "$DUMMY_KEY_LITERAL"
}
```

and inject the env var in the spawned process.

Do not rely on plain string literals for `apiKey` in temporary test configs.

## Extension Debug Logging

`sqlkit` has an internal debug logger for tool-visibility diagnosis.

Enable it:

```powershell
$env:SQLKIT_DEBUG = "1"
```

Or specify an explicit path:

```powershell
$env:SQLKIT_DEBUG_LOG = "D:\\tmp\\sqlkit-debug.ndjson"
```

The legacy `SQL_MCP_DEBUG` / `SQL_MCP_DEBUG_LOG` names are still honored as fallbacks.

Default log path:

```text
<cwd>\.pi\sqlkit-debug.ndjson
```

### Logged events

- `extension_loaded`
- `session_start`
- `before_agent_start`
- `before_provider_request`

### What to look for

If `extension_loaded` is missing:
- the extension factory never loaded
- check `-e` path, imports, and runtime errors

If `session_start.all_tools` is empty:
- runtime tool registry does not contain the extension tools
- most common cause during this project: bad `--tools/-t` allowlist usage

If `all_tools` contains some but not all expected tools:
- allowlist or filtering is excluding tools
- verify the exact `-t` string passed to `pi`

If `before_provider_request.tools_count` is `0` but `active_tools` is not empty:
- provider payload serialization may be dropping tools
- this would be a `pi`/provider integration issue, not an adapter issue

If `before_provider_request.tools` contains the expected `sql_*` functions:
- provider payload is correct
- any remaining issue is model behavior, provider behavior, or later turn control

## Known Good Diagnosis Pattern

The incident that motivated this document looked like this:

1. The extension factory executed successfully.
2. The debug log showed `extension_loaded`.
3. `session_start.all_tools` was empty or partial.
4. The model reported that available tools were `none` or missing expected tools.
5. The root cause was not the extension implementation.
6. The root cause was the CLI allowlist usage.

That means:
- do not immediately assume a registry bug when the model says tools are missing
- verify the exact `pi` invocation first

## When Adding New `sql_*` Tools

When a new tool is added, treat [`src/tool-catalog.ts`](./src/tool-catalog.ts) as the primary seam.

1. Add the tool entry to [`src/tool-catalog.ts`](./src/tool-catalog.ts): name, schema, execute binding, renderer binding, and `contextShape`.
2. Add or extend execution logic in [`src/tools.ts`](./src/tools.ts); if the tool runs SQL, wire it through [`src/query-verification.ts`](./src/query-verification.ts) instead of inventing a parallel guard path.
3. If the tool changes adapter behavior, extend [`src/adapters/mysql.ts`](./src/adapters/mysql.ts) and/or [`src/adapters/clickhouse.ts`](./src/adapters/clickhouse.ts).
4. Add or extend pure logic tests in [`scripts/test-v1.ts`](./scripts/test-v1.ts) when applicable.
5. If the tool changes the canonical print-mode flow, update [`scripts/verify-pi-print.ts`](./scripts/verify-pi-print.ts).
6. If the tool exercises real adapters or multi-step agent behavior, extend [`scripts/smoke-local.ts`](./scripts/smoke-local.ts) or [`scripts/verify-pi-agent-scenarios.ts`](./scripts/verify-pi-agent-scenarios.ts).
7. Update [`README.md`](./README.md) and this file if the recommended agent flow or verification flow changes.

Maintainer rule:

- do **not** add new hand-maintained tool-name lists in `index.ts`, `ui.ts`, or verification scripts when the catalog can derive them
- prefer deriving tool groups from catalog metadata such as `contextShape`

### Minimal Diff Template

Use this as the default shape when adding a new `sql_*` tool.

#### 1. Add one catalog entry

```ts
// src/tool-catalog.ts
{
  contextShape: "default" | "databases" | "tables" | "search" | "describe" | "tabular",
  definition: {
    name: "sql_new_tool",
    label: "SQL New Tool",
    description: "...",
    promptSnippet: "...",
    promptGuidelines: [
      "Use sql_new_tool when ...",
    ],
    parameters: Type.Object({
      source: OptionalSource,
      // ... other params
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeNewTool(getContextCwd(ctx), params as NewToolParams, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      return newToolRender.call(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return newToolRender.result(result, options, theme, context);
    },
  },
}
```

#### 2. Add orchestration in `src/tools.ts`

```ts
export async function executeNewTool(
  cwd: string,
  params: NewToolParams,
  signal?: AbortSignal,
  onUpdate?: ToolUpdate,
): Promise<ToolExecutionResult<NewToolResult>> {
  const { source } = resolveConfigAndSource(cwd, params.source);
  // if this tool runs SQL, verify through src/query-verification.ts here
  const details = await getAdapter(source.dialect).newTool(source, verifiedOrNormalizedInput, signal);
  return makeToolResult(details, formatNewTool(details));
}
```

#### 3. Add the smallest meaningful tests

```text
scripts/test-v1.ts
  - pure logic and guard / shaping behavior

scripts/smoke-local.ts
  - only if the tool exercises real adapters

scripts/verify-pi-agent-scenarios.ts
  - only if the tool changes realistic multi-step agent behavior
```

#### 4. Update only the docs that changed

```text
README.md
  - agent-facing: when to call it, in what order, and what to avoid

DEVELOPMENT.md
  - maintainer-facing: verification flow or file map only if needed
```

Checklist before you stop:

- tool added to `src/tool-catalog.ts`
- no new hand-maintained tool-name list introduced elsewhere
- query-running tools wired through `src/query-verification.ts`
- docs describe agent decision rules, not just capabilities

## File Map

Core files:

- [`src/tool-catalog.ts`](./src/tool-catalog.ts): primary tool catalog; single source for tool registration metadata, schemas, renderer bindings, and context-shape grouping
- [`index.ts`](./index.ts): extension entrypoint; registers the catalog and hooks commands/events
- [`src/tools.ts`](./src/tools.ts): tool execution orchestration layer
- [`src/query-verification.ts`](./src/query-verification.ts): shared verification seam for run/profile/explain/analyze SQL tools
- [`src/guards.ts`](./src/guards.ts): read-only and write-statement SQL guard rails
- [`src/access.ts`](./src/access.ts): datasource/database/table access policy enforcement
- [`src/adapters.ts`](./src/adapters.ts): datasource adapter coordination
- [`src/adapters/mysql.ts`](./src/adapters/mysql.ts): MySQL adapter implementation
- [`src/adapters/clickhouse.ts`](./src/adapters/clickhouse.ts): ClickHouse adapter implementation
- [`src/limits.ts`](./src/limits.ts): result truncation and shaping
- [`src/ui.ts`](./src/ui.ts): tool-result shaping for LLM context; derives tool groups from the catalog
- [`src/tui-renderers.ts`](./src/tui-renderers.ts): compact interactive renderers used by the catalog
- [`src/debug.ts`](./src/debug.ts): debug event logging

Verification scripts:

- [`scripts/test-v1.ts`](./scripts/test-v1.ts)
- [`scripts/verify-extension.ts`](./scripts/verify-extension.ts)
- [`scripts/verify-pi-load.ts`](./scripts/verify-pi-load.ts)
- [`scripts/verify-pi-print.ts`](./scripts/verify-pi-print.ts)
- [`scripts/verify-pi-agent-scenarios.ts`](./scripts/verify-pi-agent-scenarios.ts)
- [`scripts/smoke-local.ts`](./scripts/smoke-local.ts)

## Profile / Explain / Analyze Notes

`sqlkit` now exposes dedicated runtime-diagnosis tools:

- `sql_clickhouse_profile_query`
- `sql_explain_query`
- `sql_mysql_analyze_query`

Usage rules:

- pass the original `SELECT` / `WITH` query
- do not prefix it with `EXPLAIN`
- the adapter adds the correct dialect-specific syntax

Current dialect behavior:

- MySQL:
  - explain modes: `plan`, `json`
  - analyze: uses `EXPLAIN ANALYZE`
  - profile: not supported; prefer `sql_mysql_analyze_query`

- ClickHouse:
  - explain modes: `plan`, `ast`, `syntax`, `pipeline`, `estimate`
  - profile: runs the query and polls `system.query_log` by `query_id`
  - analyze: not yet supported on the tested local server build, so the tool returns an explicit unsupported error

## Result Profile Notes

`sql_run_query` returns a sampled `result_profile` alongside structured rows.

Current scope:

- built from the rows that are actually returned after row/byte/cell shaping
- reports `profile_scope=sampled_result_rows`
- includes inferred column type, null counts/ratio, distinct non-null values in the sample, sample values, top values, and numeric/string summaries when applicable
- available for both MySQL and ClickHouse `sql_run_query`

Interpretation rule:

- treat `result_profile` as a compact description of the returned sample, not full table statistics
- use it to guide follow-up SQL, decide whether broader aggregation is needed, or spot obvious value-shape/nullability surprises
- do not use it as a substitute for database-native statistics or a full profiling query

## LLM Context Shaping Notes

Beyond row/query-log sampling, `sqlkit` now also trims metadata-heavy tool results before they enter model context:

- `sql_list_databases`: samples very large database lists
- `sql_list_tables`: samples very large table-name lists in model context (human tool output remains concise)
- `sql_search_tables`: samples large match sets and per-match `matched_columns`
- `sql_describe_table`: samples large `columns` / `indexes` / `relations` arrays and truncates oversized `create_statement`

This is a context-quality optimization, not a security boundary. Human-visible tool output and repeated targeted calls still provide the full workflow when more detail is needed.

## Interactive Command Entry Point

`sqlkit` exposes one slash command for interactive use:

- `/sqlkit`: open the SQLKit source manager TUI
- `/sqlkit on|off|toggle|status`: control whether SQLKit's `sql_*` tools are active for the agent

This is a human command entrypoint for the TUI flow. Agents can also access `.pi/sqlkit.json`, `.sqlkit.json`, or `sqlkit.json` directly when working on SQLKit configuration. Prefer `sql_upsert_source` for datasource changes when possible. SQLKit activates datasource runtime tools by default when sources exist; `/sqlkit off` or `Ctrl+O` disables them, and `/sqlkit on` enables them again. Automation can override the startup state with `SQLKIT_AUTO_ENABLE_TOOLS=1`.

## Write Tool Notes

`sql_apply` is the only guarded SQL change execution tool. Keep `sql_run_query` read-oriented.

Execution rules:

- one SQL statement only
- allowed apply statements require datasource `allow_apply=true`
- allowed shapes are `INSERT`, `UPDATE`, `REPLACE`, `MERGE`, `CREATE DATABASE`, `CREATE TABLE`, and additive `ALTER TABLE ... ADD`
- user confirmation is required for every execution
- missing confirmation UI or user cancellation returns `executed=false`
- model-supplied confirmation parameters are ignored
- `DELETE`, `DROP`, `TRUNCATE`, destructive `ALTER`, account, grant, session, file, and high-risk admin operations remain blocked

Implementation seams:

- [`src/guards.ts`](./src/guards.ts): `guardWriteStatement`
- [`src/query-verification.ts`](./src/query-verification.ts): `verifyWriteStatement`
- [`src/tools.ts`](./src/tools.ts): `executeWrite` and the confirmation prompt
- adapter `executeStatement` methods for dialect-specific execution

## Practical Rule

If a change touches tool exposure, tool naming, `pi` startup behavior, provider/tool-call flow, or custom TUI rendering, do not stop at `npm run check`. At minimum, also run:

```powershell
npm run verify:all
```

## Access Policy Notes

`sqlkit` now supports config-level access policies per datasource. `sql_validate_config` emits a warning when a datasource has no access policy, because the agent can otherwise discover every database and table visible to the database account:

- `access.databases.allow`
- `access.databases.deny`
- `access.tables[]`

Current enforcement model:

- `sql_list_databases` filters blocked databases out of the result
- `sql_list_tables` rejects blocked databases and filters blocked tables
- `sql_search_tables` rejects blocked databases and filters blocked tables from search results
- `sql_describe_table` rejects blocked tables
- `sql_run_query` rejects queries whose referenced tables fall outside policy

Important limitation:

- when an access policy is enabled, ambiguous `sql_run_query` statements like `SHOW TABLES` are intentionally rejected
- prefer `sql_list_tables` / `sql_search_tables` / `sql_describe_table` for discovery flows
- prefer fully-qualified `database.table` references in generated SQL when multiple databases exist

Current query-reference parser coverage:

- supported:
  - direct `FROM db.table`
  - `JOIN db.table`
  - comma joins such as `FROM db.a, db.b`
  - quoted identifiers such as `` `db`.`table` `` and `[db].[table]`
  - CTE-backed reads such as `WITH x AS (SELECT ... FROM db.table) SELECT ... FROM x`
  - subqueries such as `FROM (SELECT ... FROM db.table) AS derived`
  - ClickHouse `ARRAY JOIN` no longer gets misread as a table source

- intentionally rejected:
  - function-like sources such as `mysql(...)`, `s3(...)`, `url(...)`, or other `name(...)` source expressions
  - queries where policy-safe table extraction still cannot be determined with confidence

Interpretation rule:

- if policy-safe extraction fails, prefer rejecting the query over guessing
- this is a safety feature, not a parser bug
- if a workflow truly needs table functions or more exotic source expressions, treat that as a separate product decision instead of weakening the default read-policy path implicitly

## Capability Self-Check Notes

By default, `sql_validate_config` connects to each datasource and runs an adapter-specific capability self-check. Pass `check_connections=false` only for a lightweight structural check.

Current coverage:

- MySQL:
  - inspects `SHOW GRANTS FOR CURRENT_USER()`
  - extracts privileges such as `SELECT`, `FILE`, `CREATE USER`, `SUPER`, `INSERT`, `DROP`
  - flags risky grants for read-only agent scenarios

- ClickHouse:
  - inspects `SHOW GRANTS`
  - inspects `system.grants`
  - reads `readonly` and `allow_ddl` from session/system settings
  - flags risky privileges and non-readonly runtime settings

Interpretation rule:

- local admin accounts are expected to trigger warnings
- these findings are meant to help you decide whether the configured account is safe enough for long-lived agent usage
- the access policy and SQL guard still matter even when the account is powerful
