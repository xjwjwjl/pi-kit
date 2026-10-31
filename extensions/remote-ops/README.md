# Remote Ops

Project-scoped, guarded remote command execution for Pi through the Linux `piexec` HTTP proxy (also called rp-proxy in code).

## Available interfaces

- Agent tool: `remote_exec({ profile, command, cwd?, timeout? })`.
- User commands: `/remote-init`, `/remote-status`, `/remote-doctor`, `/remote-doctor <profile>`.

There is no registered interactive shell, SSH setup command, model bridge, or file-transfer tool.

## Setup and configuration

Deploy and start `piexec` on the target Linux server. For example, from `extensions/remote-ops/piexec` on Linux:

```bash
go build -o piexec .
./piexec --token='<RANDOM_BEARER_TOKEN>' --port=9090
```

Replace the token placeholder with a strong random secret; use the same value in the project profile. The server listens on `:<port>` (not loopback-only). **The current adapter uses plain HTTP, with no TLS configuration.** Restrict network access and use a protected network path; do not expose this bearer-authenticated execution endpoint to an untrusted network. Client command policy is not a server-side authorization boundary.

Run `/remote-init` to create `.pi/remote-ops.json` without overwriting an existing file. Its template uses `confirm-all`; edit the profile, then run `/reload`, `/remote-status`, and `/remote-doctor production`.

```json
{
  "version": 3,
  "profiles": {
    "production": {
      "description": "生产 Linux 主机诊断与受保护运维命令",
      "host": "192.0.2.10",
      "port": 9090,
      "token": "<RANDOM_BEARER_TOKEN>",
      "cwd": "/srv/app",
      "defaultTimeout": 60,
      "maxTimeout": 1800,
      "policy": "confirm-all"
    }
  }
}
```

`host`, `port`, `token`, `cwd`, and `policy` are required. `host` is a proxy hostname/IP, not an SSH alias or URL. `port` is 1–65535; `cwd` is an absolute POSIX path. Optional timeouts are positive integer seconds; the client rejects requests above `maxTimeout`, and `piexec` rejects timeouts above 3600 seconds. The fallback timeout is 60 seconds. Unknown configuration fields are rejected; there are no `connections`, `operations`, or `protocol` fields.

The loader supports `//` line comments, but not environment-variable substitution or an external secret store. Tokens are plaintext in the project file: restrict its permissions and do not commit real credentials. Profile descriptions are optional single-line routing hints (up to 240 characters). The per-turn model catalog includes up to 20 profiles with names, descriptions, host/port, cwd, and policy, but not their tokens.

## Commands and execution

- `/remote-init` creates and session-approves the new template; it does not deploy a server.
- `/remote-status` reports loaded profiles and configuration errors; use `/reload` after editing a loaded configuration.
- `/remote-doctor` checks whether the project config exists and prints setup guidance; it does not probe a server or fully validate the config.
- `/remote-doctor <profile>` loads approved configuration and sends an authenticated `GET /health`. It does not execute a diagnostic command or verify the configured cwd/programs. This explicit probe does not use the execution tool's first-host approval.

For example, the agent can call:

```json
{"profile":"production","command":"journalctl -u api.service -n 100","timeout":30}
```

The command is parsed into a single static Bash AST, converted to verified `program + args`, and evaluated before `POST /exec`. The proxy executes argv directly, not `bash -c`. Pipelines, chains, redirects (even to `/dev/null`), expansions, unquoted globs, background jobs, assignments, and nested interpreters are blocked rather than confirmed.

`cwd` selects a start directory, **not a filesystem sandbox**. The optional tool cwd must stay lexically beneath the profile cwd; command arguments can still name absolute paths or follow symlinks with the proxy process account's permissions. Use a suitably restricted server account or OS-level isolation when needed.

## Safety and limits

- Configuration must be project-trusted or approved for the session. Execution also requires a first-use approval keyed by hostname for that service/session, shared across profiles on that hostname (not keyed by port/token). Without interactive confirmation, execution is blocked.
- `read-only` permits only rule-classified automatic commands; commands requiring confirmation are blocked. `confirm-write` auto-runs those commands and confirms recognized changing/sensitive cases. `confirm-all` confirms every otherwise permitted command. All modes retain unconditional blocks; unknown commands are blocked, not merely confirmed.
- High-risk rules block nested execution, recursive forced deletion, host power/account/firewall changes, specified disk/network mutations, protected-path writes, and selected Docker operations. Rules are command/argument-specific, not a universal guarantee that every harmful option is detected. See [DESIGN.md](./DESIGN.md).
- Results arrive after execution, not as live remote stdout/stderr. Output is bounded and visibly truncated. Secret scanning only annotates metadata; it does not redact output, command arguments, or server logs.
- Client abort/timeout stops waiting; Linux server code attempts process-group termination on request cancellation/timeout. There is no separate remote-cancel endpoint or acknowledgement, and daemonized descendants may escape. End-to-end cancellation is not an acceptance guarantee.

Current behavior above is checked against local source, not a live deployment. TLS, secure deployment, and end-to-end timeout/cancellation behavior require separate verification; file upload/download remains unimplemented and awaiting design.

## Development

From `extensions/remote-ops`:

```bash
npm install --ignore-scripts
npm run check
```
