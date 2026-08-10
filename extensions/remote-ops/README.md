# Remote Ops

Project-scoped SSH remote execution for Pi.

## Scope

The extension adds one agent tool:

- `remote_exec` — guarded command execution on a configured SSH server

And these slash commands:

```text
/remote-init
/remote-status
/remote-doctor
/remote-doctor <remote_exec-profile>
/remote-doctor setup-ssh
/remote-shell <remote_exec-profile>
/remote-shell-pi <remote_exec-profile>   # experimental
```

`/remote-doctor` is the first-run SSH and project configuration guide. With no profile it checks the local Windows OpenSSH tools and prints the complete setup path for a new Linux/WSL environment. `/remote-doctor <profile>` performs a real BatchMode SSH preflight. `/remote-doctor setup-ssh` collects an alias, host, user, port, and optional key path, then appends a new `Host` block to the local `~/.ssh/config` only after confirmation; it never generates keys or modifies the remote host.

`/remote-shell` opens a normal interactive SSH shell. The optional `@pi` assistant is intentionally experimental and is available only through the explicit `/remote-shell-pi` command:

```bash
@pi why does this systemd service keep restarting?
```

`@pi` uses the Pi model selected when the shell opened. Each question includes a small remote Linux environment snapshot: current remote directory, remote user, hostname, OS release, kernel/architecture, Bash version, and PID 1. It does not include local Pi/project environment, remote command output, project files, or the main conversation. The assistant has no tools and cannot execute commands. The experimental command requires Bash and `curl` on the remote Linux host.

## Configuration

Run `/remote-init` in a project to create a `.pi/remote-ops.json` template. It never overwrites an existing configuration.

```json
{
  "version": 3,
  "profiles": {
    "production": {
      "description": "生产 Linux 主机诊断与受保护运维命令",
      "host": "prod-api",
      "cwd": "/root",
      "policy": "confirm-write"
    }
  }
}
```

For `remote_exec`, `cwd` selects the remote process working directory but does **not** provide a filesystem sandbox: absolute paths such as `ls /` remain subject to the remote account's normal permissions. The command is parsed as a Bash AST and only a single static command is accepted; pipelines, chains, redirects, expansions, globs, background jobs, and nested interpreters are blocked. The proxy receives `program + args` and executes with `exec`, not `bash -c`.

SSH uses the local `~/.ssh/config`; use a host alias for port, user, key, jump-host, and host-key configuration. The extension forces non-interactive SSH authentication (`BatchMode=yes`).

## Agent routing

Each operation profile can include a short single-line `description`. Remote Ops injects the loaded profile catalog into Pi's per-turn system prompt, including the exact tool/profile pair and routing rules.

## Safety behavior

- A project config must be trusted or explicitly approved for the current session.
- Every connection needs a one-time session approval.
- `remote_exec` auto-runs only a narrow read-only allowlist.
- A static single-command AST is converted to a verified `program + args` invocation before policy evaluation.
- Changing or ambiguous commands prompt every time; unsupported shell syntax is blocked rather than confirmed.
- Destructive host, disk, account, SSH, firewall, and similar commands are blocked; use `/remote-shell` manually when needed.
- `remote_exec.cwd` is a default working directory, not a filesystem access boundary.
- `/remote-doctor` is read-only except for the explicit, confirmed local `setup-ssh` write; it never changes remote users, sshd, firewall rules, or authorized keys.
- `/remote-shell` opens only a normal interactive SSH shell and does not create an LLM bridge.
- Experimental `/remote-shell-pi` forwards `@pi` through a temporary loopback-only SSH reverse tunnel protected by a random token; the bridge closes when SSH exits.
- `@pi` is an assistant-only path and does not bypass `remote_exec` safety policy because it has no tools; it receives remote environment facts, not local Pi/project environment.

See [DESIGN.md](./DESIGN.md) for the complete model and security rationale.

## Development

```bash
npm install --ignore-scripts
npm run check
```
