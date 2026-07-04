# pi-pane

Open a new Windows Terminal pane from inside pi and start another pi instance in
Git Bash in the same working directory.

## Usage

```text
/pane
/pane right
/pane down
```

`/pane` defaults to `right`.

For a faster, clean Pi startup in the new pane:

```text
/pane right fast
/pane down fast
```

`fast` launches `pi` with:

```text
--offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
```

By default, the new pane starts a fresh pi session. If you explicitly want to
fork the current session:

```text
/pane right fork
/pane down fork
```

## Backends

`pi-pane` prefers Windows Terminal:

- Windows Terminal on Windows or when `WT_SESSION` is set
- `tmux` when `TMUX` is set and Windows Terminal is not detected

For Windows Terminal, `pi-pane` launches Git Bash with `bash -c` to avoid the
extra startup cost of a login shell. It first tries your current or default
Windows Terminal profile, then common Git for Windows locations, then `bash.exe`
on `PATH`.

You can force a backend:

```text
/pane right backend=tmux
/pane down backend=windows-terminal
```

Or with an environment variable:

```text
PI_PANE_BACKEND=tmux
PI_PANE_MODE=fresh
PI_PANE_STARTUP=fast
```

If your Git Bash executable is in a custom location:

```text
PI_PANE_SHELL=C:\path\to\Git\bin\bash.exe
```

To pass your own arguments to the child `pi` command:

```text
PI_PANE_PI_ARGS=--offline --no-extensions
```

## Install

```powershell
pi install D:\code\my-pi\extensions\pi-pane -l
```
