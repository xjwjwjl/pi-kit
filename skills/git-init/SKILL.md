---
name: git-init
description: Initializes a new local Git repository for a project that is not already under Git, creates a minimal project-specific .gitignore and .gitattributes, pins shell scripts to LF line endings to avoid Linux ^M runtime failures, and makes the first local commit.
compatibility: Uses git and POSIX-style shell commands via bash; no GitHub or remote required.
---

# Git Init

Initialize a local Git repository for the current project and capture the current project state as the first commit.

## When to use

Use this when the user wants to start versioning a project that does not yet have a local Git repository.

Do **not** use this to re-initialize an existing repository. If the directory is already inside a Git repo, stop and offer to create a normal commit instead.

## Core principles

- Never run `git init` inside an existing Git repository.
- Inspect for generated files, dependency directories, vendored artifacts, and secrets before the first commit.
- Create or update `.gitignore` before staging everything.
- Create or update `.gitattributes` before staging everything, and pin shell scripts to LF so Linux does not fail with `^M` line-ending errors.
- Keep generated policy files minimal and project-specific; do not dump generic mega-templates.
- Show the staged status and diff stat before committing.

## Workflow

### 1. Confirm the target directory

```bash
pwd
ls -la
git rev-parse --show-toplevel 2>/dev/null
```

If `git rev-parse --show-toplevel` succeeds, stop. Report the existing repo root and ask whether the user wants a normal commit instead.

### 2. Inspect junk, generated output, and sensitive files

Run a shallow scan before touching Git state:

```bash
find . -maxdepth 3 \( -name .git -o -name node_modules -o -name vendor -o -name dist -o -name build -o -name .next -o -name out -o -name target -o -name __pycache__ -o -name .pytest_cache -o -name .venv -o -name venv \) -prune -print
find . -maxdepth 3 -type f \( -name '.env*' -o -name '*secret*' -o -name '*credential*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' \) -print
```

If suspicious files appear, fix ignore rules first and ask before including anything sensitive. Keep intentional examples such as `.env.example` and `.env.sample` trackable.

### 3. Detect the project stack

Inspect actual stack markers and existing policy files:

```bash
find . -maxdepth 2 \( -name .gitignore -o -name .gitattributes -o -name package.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name pyproject.toml -o -name requirements.txt -o -name Cargo.toml -o -name go.mod -o -name pom.xml -o -name build.gradle -o -name build.gradle.kts -o -name gradlew -o -name '*.csproj' -o -name '*.sln' -o -name composer.json \) -print
```

Read existing `.gitignore` and `.gitattributes` before editing them.

### 4. Create or update `.gitignore` minimally

Infer ignore rules from files and directories actually present. Add only missing rules justified by the current project.

At minimum, consider:

- local secret/env files such as `.env`, `.env.local`, `.env.*.local`
- dependency directories such as `node_modules/`, `.venv/`, `venv/`, `vendor/` when generated locally
- build outputs such as `dist/`, `build/`, `.next/`, `out/`, `target/`
- cache directories such as `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`
- OS/editor noise such as `.DS_Store`, `Thumbs.db`, `.idea/`, `.vscode/` only when appropriate for the project
- local worktree or scratch directories if the project uses them

Do **not** overwrite a curated `.gitignore` with a generic one. Do **not** ignore template files meant to be committed, such as `.env.example` or `.env.sample`.

### 5. Create or update `.gitattributes` for portable line endings

Ensure shell scripts are committed with LF line endings to avoid Linux runtime errors such as `/bin/sh^M` or `bad interpreter: ... ^M`.

Add these rules if they are missing:

```gitattributes
# Keep Unix shell scripts runnable on Linux/macOS.
*.sh text eol=lf
*.bash text eol=lf
*.zsh text eol=lf
*.fish text eol=lf
```

If the project has extensionless executable shell scripts, inspect them and add path-specific rules instead of broad guesses, for example:

```gitattributes
scripts/* text eol=lf
bin/* text eol=lf
```

Do **not** add broad rules that would incorrectly force binary files or Windows-only scripts. Preserve existing `.gitattributes` rules unless they directly conflict.

### 6. Initialize on branch `main`

Initialize only after ignore and attributes rules are safe:

```bash
git init -b main 2>/dev/null || { git init && git symbolic-ref HEAD refs/heads/main; }
git branch --show-current
git status --short
```

If the current branch is not `main`, fix it before the first commit.

If post-init status includes junk, generated files, dependency folders, or suspicious files, update `.gitignore` or `.gitattributes` before staging.

### 7. Stage, inspect, and create the first commit

When the user wants the full current project snapshot and the status looks safe:

```bash
git add -A
git status --short
git diff --cached --stat
git commit -m "chore: initial commit"
```

Before committing, review `git status --short` and `git diff --cached --stat`. If staged files include secrets, dependency folders, build outputs, or line-ending policy mistakes, unstage and fix the policy files first.

### 8. Report the new repo state

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse --short HEAD
```

## Output requirements

```markdown
Initialized Git repository at `<path>` on branch `main`.
Initial commit: `<sha>` (`chore: initial commit`).
Added/updated `.gitignore` and `.gitattributes` for this project.
```

If the workflow stops before committing, explain the blocker and the safest next action.

## Red flags

Stop and ask before proceeding when:

- the directory is already inside a Git repository
- the user appears to want a nested repo inside another repo
- sensitive files appear in unstaged or staged changes
- `.gitignore` or `.gitattributes` would need broad destructive rewriting
- staged changes include dependency directories, build outputs, or generated artifacts that should probably be ignored
- line-ending rules would affect unknown binary or platform-specific files
