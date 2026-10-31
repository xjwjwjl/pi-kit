# ChatGPT Context — endpoint notes

Endpoint observations below were previously recorded in 2026-10 and were **not
reverified now**. Transport restrictions are safety policy, not evidence that
other origins were verified. These are **undocumented ChatGPT web-app endpoints**,
not a public API. They can change or be rate limited without notice; treat
failures as expected behavior, not as bugs to force through.

For command syntax, selection, output format 7, continuation validation, budgets,
configured credentials, and failure handling, load [cli.md](cli.md).

## Endpoints

Base: `https://chatgpt.com/backend-api`

| Request | Returns |
|---|---|
| `GET /me` | account identity (`id`, `email`, `name`) |
| `GET /conversations?offset=N&limit=M` | active conversations, newest first |
| `GET /conversations?offset=N&limit=M&is_archived=true` | archived conversations |
| `GET /conversation/{id}` | one conversation, full message tree |
| `GET /files/{file_id}/download` | one message file: `{status, download_url, file_name, file_size_bytes}` |

`GET /conversation/{id}` can return ~2.5 MB for a long chat: a `mapping` of node
ID to `{ id, parent, children, message }`, plus `current_node`. Parent links define
the active branch; sorting every node by `create_time` can incorrectly merge
forks. The CLI's complete-chain requirement, fallback rules, and branch labels
are specified in [Read selectors and fidelity](cli.md#read-selectors-and-fidelity).

Useful fields per conversation: `title`, `create_time`, `update_time`,
`is_archived`, `conversation_origin`, `default_model_slug`. Message text lives in
`message.content.parts[]` and is only meaningful for `content_type` of `text` or
`multimodal_text`; `tool` role items are captions and tool output. Only string parts
carry text: image and other non-text parts become `[image]`/`[attachment]`
placeholders and are counted as omitted content, so a message is never silently
dropped.

## Images

An image part looks like this and carries a file ID:

```json
{ "content_type": "image_asset_pointer",
  "asset_pointer": "sediment://file_000000009f0081f8abfb9d2f7469eb84",
  "mime_type": "image/png", "width": 1055, "height": 1491, "size_bytes": 3586523 }
```

The id after `://` (`sediment://` and `file-service://` both occur) is what the
files endpoint wants. Downloading is two GETs with the normal headers:

1. `GET /backend-api/files/{file_id}/download` →
   `{"status":"success","download_url":"https://chatgpt.com/backend-api/estuary/content?id=…&sig=…","file_name":"image-gen-1(8).png","file_size_bytes":3586523}`
2. `GET <download_url>` → the bytes.

Previously recorded in 2026-10, not reverified now: the signed `estuary/content`
URL **still needed the Authorization header**. Without it the response was
`403 {"detail":"File stream access de…"}`; with it a ranged request returned `206`
and PNG magic bytes. The CLI sends authenticated headers only after validating the
exact `https://chatgpt.com` origin, no userinfo, and effective port 443; subdomains
and `oaiusercontent.com` are not allowed. This is a restriction, not a claim that
other origins were tested.

The same file ID can be referenced by several messages; one recorded generated
batch appeared twice. Images produced by `image_gen` occur in `role: "tool"`
messages, whose text is omitted by default. For window intersection, tool-image
selection, deduplication, dimensions, destination handling, success-only file
replacement, and per-image failures, see
[Tool omissions and optional images](cli.md#tool-omissions-and-optional-images).

Canvas components are **not** files: markup such as `<AsyncImage query="…"/>` or
`<AsyncImageGroup query={[…]} />` appears inside the assistant's *text* parts and is
rendered client-side from the query. There is no asset pointer, so there is nothing
to download.

## Required headers

```
Authorization: Bearer <access token>
chatgpt-account-id: <chatgpt_account_id>  # when available; see Authentication
User-Agent: <browser UA>          # omitting this yields an empty response
Referer: https://chatgpt.com/
oai-language: zh-CN               # optional
```

Headers travel through curl config on stdin, not process arguments or temporary
config files. HTTPS/origin restrictions and sanitized diagnostics are specified in
[Configured credentials and transport safety](cli.md#configured-credentials-and-transport-safety).

## Authentication

Network commands use `--auth-source auto|env|pi|codex`. Auto initially chooses
ENV > Pi > Codex, then pins the selected source without cross-source fallback.
Explicit sources access only that source; Pi can normally refresh within Pi,
but refresh failure is an error, not a Codex or browser-cookie fallback.
Credential paths, refresh behavior and legacy environment compatibility are in
[cli.md](cli.md#configured-credentials-and-transport-safety). The CLI reads credentials
internally; the agent must not inspect real auth/session contents or expose secrets.
`chats filter` and `help`/`--help` require no credential access or network requests.
These are CLI policies, not new live endpoint observations.

The previously recorded 2026-10 observations tested both Pi and Codex credentials
against the endpoints above; this was not reverified now:

| | Pi | Codex |
|---|---|---|
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` | same |
| scopes | `openid profile email offline_access` | adds `api.connectors.read`, `api.connectors.invoke` |
| same `chatgpt_account_id` | yes | yes |

The extra connector scopes are **not** required for reading conversation history.

## Transport

The recorded host behavior was a **403 from Cloudflare** for Node's `fetch`,
including with `NODE_USE_ENV_PROXY=1`, while curl was accepted and honored
`HTTP(S)_PROXY` / `ALL_PROXY`. This has not been reverified now. The CLI continues
to use curl with HTTPS-only, fixed-origin protections; see
[transport safety](cli.md#configured-credentials-and-transport-safety) and
[bounded retries and failures](cli.md#strict-validation-and-concise-failures).

## Previously recorded failure modes

| Symptom | Cause |
|---|---|
| `401` on a burst of requests, then works again minutes later | short-term rate limiting, not a bad token. Back off; do not loop. |
| `403` with `%0D` visible in the URL | the conversation id carried a trailing `\r` from a CRLF file. Trim ids. |
| `404 {"code":"conversation_deleted"}` | the chat was deleted server-side; the local sidebar index can still list it. |
| `404 "thread not loaded"` | this was an app-server call, not `/backend-api` — different API. |
| empty body, no HTTP status | missing `User-Agent`. |

### Archived pagination is unreliable

`is_archived=true` accepts `offset` but effectively returns the same first page, and
`total` is not a real count — it tracks `offset + limit + 1` (51, 101, 151 for
offsets 0/50/100). Treat the archived list as "a sample", and read by id when you
know the id.

## Not available to this CLI

- **Account-wide full-text search.** `chats list --filter TERM` makes one GET,
  then filters titles on that fetched page client-side. `chats filter TERM --input
  FILE|-` only filters a strictly validated format 7 list JSON locally, without
  authentication, network access, or automatic next-page fetching. A miss is only
  a miss inside the scanned page. Inside one conversation, `chat find` matches
  message text literally within its selected range and never implicitly searches
  an older prefix. No `chats search` or `/global/search` is implemented; do not
  batch-read histories to simulate it. Project/image search, local indexing and
  background sync are also outside this CLI.
- **Local transcripts.** `~/.codex/thread_history_1.sqlite` has zero rows for the
  ChatGPT conversation ids, and the `codex app-server` JSON-RPC surface rejects them
  with `thread not loaded`.
- **Conversation content in local SQLite.** `~/.codex/sqlite/codex-dev.db` →
  `local_thread_catalog` rows with `source_kind='chatgpt'` carry only
  `thread_id` + `display_title` for roughly the sidebar-recent set.
- **The `codex_app` MCP.** It needs `CODEX_APP_TOOLS_PIPE_PATH` (a per-run secret
  handed only to its child process) plus thread metadata in each call's `_meta`,
  which a plain MCP client does not send.
