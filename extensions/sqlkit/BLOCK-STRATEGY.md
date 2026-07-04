# SQLKit Block Strategy

This document defines the current blocking policy for `sqlkit` during the v1 development phase.

Goal:

- keep `sql_*` query tools read-oriented
- allow explicit database changes only through `sql_apply`
- require user confirmation before agent-driven `sqlkit.json` reads or mutations
- discourage reactive `sqlkit.json` mutations after a blocked SQL attempt unless the user asks for a configuration change
- let the assistant explain the block to the user instead of silently terminating the turn

Out of scope for v1:

- full shell sandboxing
- generic network blocking
- safe write/admin SQL execution through `sql_run_query`
- implicit escalation from read-only analysis into migration/admin behavior

## Current Policy Summary

| Surface | Target | Behavior | Why |
|---|---|---|---|
| `sql_run_query` / `sql_profile_query` / `sql_explain_query` / `sql_analyze_query` | DDL, DML, admin, session-setting SQL | Block | read-oriented query tools stay read-only |
| `sql_apply` | Allowed apply statements with datasource opt-in and user confirmation | Allow | explicit change tool for user-requested mutation/schema additions |
| `sql_apply` | Destructive/admin SQL such as `DELETE`, `DROP`, `TRUNCATE`, destructive `ALTER`, grants, accounts, or session/file operations | Block | outside the current apply tool safety envelope |
| `sql_apply` | account, grant, session, file, multi-statement, or high-risk admin SQL | Block | not part of the apply tool safety envelope |
| `read` | `.pi/sqlkit.json`, `.sqlkit.json`, `sqlkit.json` | Confirm, then allow | Config reads require explicit user confirmation |
| `edit` / `write` | `.pi/sqlkit.json`, `.sqlkit.json`, `sqlkit.json` | Confirm, then allow | Config mutations require explicit user confirmation |
| `bash` | Commands that mutate raw SQLKit config | Confirm, then allow | Shell-based config mutations require explicit user confirmation |
| `/sqlkit` command | Project config edits and tool toggle | Allow | Human-facing TUI config entrypoint remains available |
| `sql_list_sources` / `sql_validate_config` | Redacted datasource info | Allow | Safe alternative to reading raw config |

## Query Tool Policy

### Blocked SQL categories

The query guard blocks these classes for `sql_run_query` and related query tools:

- DDL: `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`
- DML / writes: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `REPLACE`
- admin / dangerous commands: `OPTIMIZE`, `SYSTEM`, `KILL`, `GRANT`, `REVOKE`, `SET`
- MySQL file and lock patterns such as `INTO OUTFILE`, `LOAD DATA`, `FOR UPDATE`

Allowed query kinds remain read-oriented:

- `SELECT`
- `WITH ... SELECT`
- `SHOW`
- `DESCRIBE` / `DESC`
- `EXPLAIN`

Allowed database changes belong in `sql_apply`, not in read-oriented query tools. Destructive and admin SQL stays outside the current agent tool surface.

### Write tool policy

`sql_apply` has a deliberately small contract:

- one SQL statement only
- `INSERT`, `UPDATE`, `REPLACE`, `MERGE`, `CREATE DATABASE`, `CREATE TABLE`, and additive `ALTER TABLE ... ADD` require datasource `allow_apply=true`
- `DELETE`, `DROP`, `TRUNCATE`, destructive `ALTER`, account, grant, session, file, and unsupported `CREATE` forms are blocked
- every execution requires user confirmation through the UI
- missing confirmation UI or user cancellation returns `executed=false`
- tool parameters cannot stand in for user confirmation
- account, grant, session, file, and high-risk admin operations remain blocked

Important nuance:

- a blocked SQL attempt still produces a visible tool result with `[SQLKIT QUERY BLOCKED - READ/SAFETY POLICY]`
- the turn no longer terminates automatically
- the model is expected to explain the policy block to the user in natural language

## Config Access Policy

### Config files

The following project config paths are SQLKit config:

- `.pi/sqlkit.json`
- `.sqlkit.json`
- `sqlkit.json`
- the actual discovered SQLKit config path for the current cwd

### Direct file-tool access

SQLKit no longer intercepts direct file-tool reads or mutations of these files.

Allowed operations:

- `read` of SQLKit config through normal agent file tools
- `edit` of SQLKit config through normal agent file tools
- `write` of SQLKit config through normal agent file tools

Expected agent behavior:

- inspect/edit raw config only when the user explicitly asks to create or change SQLKit sources/configuration
- prefer `sql_upsert_source` for datasource changes instead of hand-editing JSON when it can express the requested change
- prefer focused changes and validate with `sql_validate_config` afterward when possible
- do not silently relax `read_only`, `allow_apply`, or access-policy settings after a query/apply block unless the user explicitly asks for that configuration change

### Bash access scope

SQLKit does not block shell commands just because they mention `sqlkit.json`.

- generic `curl`, `wget`, or `clickhouse-client` commands by themselves
- generic network access that does not depend on reading SQLKit config first
- config reads through shell commands
- config mutations through shell commands

This is intentional. The current SQLKit safety boundary is:

1. keep read-oriented query tools read-only
2. route allowed database changes through `sql_apply`
3. require datasource opt-in and user confirmation for `sql_apply`

rather than treating SQLKit as a general shell sandbox.

## `/sqlkit` Command Policy

`/sqlkit` is the interactive config-management path. Direct agent edits to `sqlkit.json` are also allowed when the user explicitly asks to manage SQLKit sources/configuration.

Allowed operations:

- inspect and edit datasource config through the SQLKit UI flow
- persist `agent_tools.enabled`
- enable / disable SQLKit agent tools
- default-enable SQLKit agent tools when sources exist and `agent_tools.enabled` is not explicitly set

Current persistence location:

```json
{
  "agent_tools": {
    "enabled": true
  }
}
```

This lives inside project `sqlkit.json` by design.

## Prompt-Level Guidance

When SQLKit tools are active, `before_agent_start` appends a policy prompt that tells the model:

- SQLKit query tools are read-oriented only
- do not use `sql_run_query` family for DDL / DML / admin / session-setting SQL
- do not edit SQLKit config merely to bypass policy after a query/write block
- if a SQLKit tool reports `SQLKIT QUERY BLOCKED - READ/SAFETY POLICY`, stop retrying and explain the limitation

This prompt is meant to reduce bad first attempts. The hard boundary still lives in tool-time blocking.

## Regression Coverage

Current automated coverage includes:

- unit-level guard tests in `scripts/test-v1.ts`
- extension registration and policy-prompt checks in `scripts/verify-extension.ts`
- print-mode exposure checks in `scripts/verify-pi-print.ts`
- blocked-write conversational regressions in `scripts/verify-pi-write-blocks.ts`

The blocked-write regressions verify two important cases:

- `CREATE TABLE` request through a read-oriented query tool
- `ALTER TABLE ... DROP COLUMN` request

Expected behavior in both:

1. the model calls `sql_run_query`
2. SQLKit blocks the write/admin SQL
3. the assistant still produces a Chinese explanation
4. no extra SQLKit tools are called to keep retrying the blocked operation

## Known Non-Goals

These are intentionally not solved yet:

- arbitrary shell sandboxing
- preventing a human user from manually running direct database clients outside pi
- supporting schema or data mutation through `sql_run_query`
- supporting destructive/admin SQL unless a future dedicated admin workflow is introduced

## Future Evolution

If SQLKit needs broader admin support later, do **not** expand `sql_run_query` casually and do not silently widen `sql_apply`.

Preferred direction:

- keep read-oriented analysis separate from mutation/admin workflows
- add dedicated higher-risk tools only when the workflow needs them
- require explicit enablement, user confirmation, and clear auditability
