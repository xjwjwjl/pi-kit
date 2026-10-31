---
name: git-commit
description: Inspects, stages, and creates a reviewed local commit in the current repository. Use when the user asks to commit changes, commit specific files, or create a local checkpoint. Never pushes.
compatibility: Uses git via bash; no GitHub or remote required.
---

# Git Commit

Prepare and create a local commit from reviewed, explicitly approved changes.

## Execution contract

This skill prepares and commits only reviewed, explicitly approved changes. It preserves unrelated worktree and index state, and never performs remote operations.

- Pre-existing staged changes are user-owned: never unstage, reset, or overwrite them without explicit approval.
- Never commit before showing the exact staged snapshot and receiving confirmation.
- Never bypass safety with `--no-verify`, `--force`, history rewrites, or an unsolicited `--amend`.
- Never echo a complete secret value found during review.
- Ask only when the scope is genuinely ambiguous or a decision is still unconfirmed; never re-ask what the user already approved.
- This skill never fetches, pulls, or pushes. When the user also wants remote operations, wait for a separate request instead of doing them here.

## 1. Inspect

```bash
git rev-parse --show-toplevel
git status --porcelain=v2 --branch --untracked-files=all
git diff
git diff --cached
git log --oneline -10 2>/dev/null || true
git rev-parse --verify -q HEAD || echo "no commits yet"
```

`--untracked-files=all` reveals files inside untracked directories. Group the changes by feature or directory, and recommend separate commits when the worktree mixes unrelated work.

Report "nothing to commit" and stop when there is no staged or unstaged change.

### Blocked states

```bash
git diff --name-only --diff-filter=U    # unmerged paths
git rev-parse -q --verify MERGE_HEAD    # merge in progress
git rev-parse -q --verify REBASE_HEAD   # rebase / interrupted rebase
git rev-parse -q --verify CHERRY_PICK_HEAD
git symbolic-ref -q --short HEAD || echo "detached HEAD"
```

- Unmerged paths, merge, rebase, or cherry-pick: no ordinary staging or commit until the user says how to proceed.
- Detached HEAD: confirm the user wants the commit on that HEAD.
- Empty repository: use the fallback message rules instead of treating a `git log` failure as fatal.

## 2. Scope

- No commit request, or a bare "commit" / "看看改动": inspect, summarize change groups, ask what to include.
- "Commit all": after the safety review, prepare every reviewed change unless suspicious files or junk make it a stop.
- Named files, directories, or a feature: that scope only.

Ask only when the scope is genuinely ambiguous.

## 3. Safety review

Path screening is a preliminary filter, not a verdict:

```bash
git -c core.quotepath=false status --short --untracked-files=all | grep -Ei '\.env($|\.)|\.npmrc$|\.netrc$|credential|secrets?\.|\.pem$|\.key$|\.pfx$|\.p12$|id_(rsa|dsa|ecdsa|ed25519)|password|passwd|htpasswd|keystore|\.jks$' || true
```

`core.quotepath=false` matters: with the default, non-ASCII names such as `中文.env` are printed as `"\344\270\255..."` and the pattern misses them.

Treat suspicious filenames as risk indicators, not automatic blockers: `credentials.example.ts` and `tests/fixtures/test.pem` may be legitimate, while `.env.production` or a `config.json` holding a real key needs real scrutiny. Review the actual content of everything entering the commit: modified files, already staged changes, and untracked files you intend to stage. Read small text files directly; for large, binary, or generated files judge nature, size, and origin instead. If a scoped file's content cannot be reliably reviewed (encrypted data, opaque binary, huge generated artifact), require user confirmation instead of assuming it is safe. Never block solely because an unrelated, unstaged file has a suspicious name.

Content has to be scanned on the staged snapshot, so the secret scan runs in section 6 after staging, not here. Reuse a project secret scanner (`gitleaks`, `trufflehog`, `detect-secrets`) when already available; never add new dependencies for this.

## 4. Index protection

Treat every pre-existing staged change as user-owned state. If `git diff --cached --stat` is non-empty with changes you did not stage in this task, show them and ask whether to include them, keep them for another commit, or restart the scope. Content you staged yourself in this task needs no second confirmation.

- Never run `git reset --hard`, unstage user work (`git restore --staged`, `git reset <path>`), or partially unstage it without approval; a file may be intentionally partially staged. (`git reset --soft` is reserved for the squash step in `git-push`.)
- Unrelated staged changes must be resolved before staging more.
- Immediately before committing, confirm every staged path belongs to the approved scope — `git commit` commits the whole index, not just the files just added.

## 5. Stage

```bash
git add -A                             # only for explicit "commit all" after review
git add -u                             # tracked modifications only
git add -- "path/one" "path/two"       # `--` stops option parsing
git add -- ":(literal)dir/weird*name"  # pathspec metacharacters need literal magic
```

Prefer whole files. Use `git add -p` only in a real interactive terminal; in a non-interactive shell it can block on input.

## 6. Reviewed snapshot

```bash
git status --short
git diff --cached --stat
git diff --cached --name-only   # intent-to-add entries never appear here
git diff --cached
git diff --cached --numstat     # a `-` column means binary: not greppable
git diff --cached --check       # whitespace errors and leftover conflict markers
git write-tree                  # approved tree id — record it
```

A stat-only or filename-only review does not approve a commit. Minimum evidence to show: `git diff --cached --stat`, the full staged path list, explicit callouts for binary/large/generated files, and the tree id. Show the full diff when it is small or the user asks for it.

A path that `git status --short` shows as added but that is missing from `git diff --cached --name-only` is an intent-to-add entry (`git add -N`). It is not in the tree and will not be committed — stage it for real or report it. With only such entries, `git diff --cached` is empty and `git commit` exits 1 with `no changes added to commit`.

Scan the staged additions for secrets. Both greps need `--no-color --no-ext-diff`, otherwise `color.diff=always` or a configured external diff turns the patch into unparsable output and the scan silently sees nothing:

```bash
# Tier 1 — provider tokens and private keys: always stop
git diff --cached --no-color --no-ext-diff -U0 | grep -E '^\+' | grep -vE '^\+\+\+ ' \
  | grep -Ei 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}'

# Tier 2 — keyword assigned a long value: mention, block only if the value is a real literal
git diff --cached --no-color --no-ext-diff -U0 | grep -E '^\+' | grep -vE '^\+\+\+ ' \
  | grep -Ei '(password|passwd|secret|token|api[_-]?key|access[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}'
```

`grep -E '^\+'` then dropping the `+++ ` header keeps content lines that start with `+`; a plain `grep -E '^\+[^+]'` loses every added line beginning with `+`.

- Tier 1 hit inside the commit scope: stop, report the path and line, require explicit confirmation or removal.
- Tier 2 hit: report the line. Block only when the value is a real literal rather than an identifier, call, or placeholder such as `process.env.PASSWORD`, `getToken()`, or `${SECRET}`.
- A hit outside the commit scope: mention it; do not block.
- No hit is not proof of safety: say that the scan ran and over which paths. Binary files (`-` in `--numstat`) are not greppable and need judgment or explicit user confirmation.

`git write-tree` captures the exact staged tree — content, paths, modes, and binary blobs — as one content-addressed id. Record it as the approved snapshot. Alternatives such as `git ls-files --stage -z` also identify index blobs (id, mode, path); `write-tree` is preferred because it is direct and mirrors the commit snapshot. It may create unreachable tree objects when a proposal is abandoned or the staged content changes; these are harmless and eligible for `git gc`. A tree that ends up in the commit is reachable, not dangling.

## 7. Verify

Run the cheapest relevant project check before proposing: an explicit command from `AGENTS.md` or the project manifest (`go build ./...`, `cargo check`, `npm run lint`, targeted tests). Do not run full suites by default.

Report what ran and its result. Tests exercise the worktree, so state it when unstaged edits to the same files are excluded from the commit.

## 8. Message

Precedence: explicit project convention → the user's instruction this turn → recent repository style (`git log --oneline -10`) → the fallback below.

Fallback format `<type>(<scope>): <中文说明>` with only these types:

- `feat`: new capabilities
- `fix`: bug fixes and incorrect behavior
- `chore`: everything else — dependencies, build, scripts, config, docs, tests, refactors

Derive the subject from the actual diff, not from filenames alone. Keep it imperative and specific; omit the scope when unclear; add a body (`git commit -m "<subject>" -m "<body>"`) for background, impact, compatibility, migration, or verification. No AI attribution unless asked.

## 9. Propose and confirm

```markdown
## Proposed commit

Branch: `<branch>`
Message: `<subject>`
Staged: `<git diff --cached --shortstat>` (tree `<tree>`)
Files: `<staged paths; call out binary, large, or generated files>`
Excluded: `<changes intentionally left in the worktree>`
Checks: `git diff --cached --check` passed · `<command>` passed / not run

Proceed with this commit?
```

Stop here when the user only asked for inspection or preparation.

## 10. Commit and verify

```bash
git write-tree     # must equal the approved tree; otherwise stop and re-review
git commit -m "<subject>"
git rev-parse --short HEAD
git rev-parse 'HEAD^{tree}'
git status --short
```

- Tree changed since approval: do not commit; re-inspect the staged diff and request renewed approval. The abandoned tree object needs no cleanup.
- Commit tree differs from the approved tree: a hook (formatter, message rewrite) altered the result. Report it and ask before continuing.
- Hook failure: report the hook output and never add `--no-verify`. A failing `pre-commit` hook may also have rewritten and re-added files, so the approved tree is stale: re-run `git diff --cached`, `git write-tree`, and re-approve before retrying. Signing failures such as `gpg failed to sign the data` land here too.
- `fatal: no changes added to commit`: the index does not hold the approved content (often an intent-to-add entry from section 6). Re-stage and re-approve; do not report it as a hook failure.

```markdown
Committed `<short-sha>`: `<subject>`
Tree: `<HEAD^{tree}>` matches the approved tree
Checks: `<command>` passed / not run
Worktree: clean / `<n>` paths intentionally left uncommitted
```

Leftover dirty files are usually changes the user chose to exclude. Compare them with the pre-commit state instead of amending; report them and offer a separate follow-up commit, or an amend only if the user asks for it.
