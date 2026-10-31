---
name: git-pull
description: Fetches and integrates remote updates into the current branch with fast-forward first, rebase only when diverged and approved, and staged/untracked changes preserved. Use when the user asks to pull, update from the remote, or check for updates.
compatibility: Uses git via bash; no GitHub or remote required.
---

# Git Pull

Safely update the current local branch from its remote counterpart while preserving local commits, uncommitted changes, and staging state.

## Core principles

- Fetch and inspect before integrating. Never blindly run `git pull`.
- Update only the current branch from an explicitly resolved remote branch.
- Prefer fast-forward when possible. Rebase only when histories have diverged and the user approves.
- Do not create merge commits as part of the default workflow.
- A dirty worktree does not automatically prevent fetching or checking for updates.
- Prefer Auto Stash for simple unstaged tracked changes; use Manual Stash when index preservation or untracked-file protection is needed.
- Never discard changes, rewrite known-published commits, or silently modify other branches.
- Never commit, squash, push, force-update, or change upstream tracking without an explicit separate request.
- Require confirmation for history rewriting, stash operations that affect staging state, and ambiguous sources.
- Ask only when the source is ambiguous, history must be rewritten, or an unconfirmed action is about to run. Do not ask again for a choice already approved.
- Report decisions, conflicts, and recovery information without narrating routine commands.

## 1. Inspect repository state

```bash
git rev-parse --show-toplevel
git symbolic-ref --quiet --short HEAD
git rev-parse --verify HEAD
git remote
git status --porcelain=v1 --untracked-files=all
git branch -vv
```

Check for unfinished rebase, merge, cherry-pick, or revert; unmerged index entries; detached HEAD; staged changes; unstaged tracked changes; untracked files; relevant submodule changes.

Stop when an unresolved Git operation or an invalid current branch exists. Do not automatically abort an existing operation.

```bash
original_head=$(git rev-parse HEAD)
branch=$(git symbolic-ref --quiet --short HEAD)
```

Classify the worktree state, but do not stash anything yet.

If the user only asks to **check for updates**, fetch, inspect divergence, report, and stop without touching the current branch.

## 2. Resolve the remote source

```bash
git config --get "branch.$branch.remote"
git config --get-all "branch.$branch.merge"
```

Use the configured upstream, e.g. `feature/login` tracking `origin/develop` means `origin/develop` is the source — never an inferred `origin/feature/login`.

Without a valid remote upstream:

- Use a remote branch the user named explicitly.
- Otherwise suggest the same-named remote branch when it exists and the remote is unambiguous.
- If several candidates exist, ask which source to use.
- Never fall back to `origin/main` or `origin/master`.
- Never set or change upstream tracking.

Resolve `local_branch`, `remote`, `source_branch`, and `source_ref=refs/heads/<source_branch>`. Reject ambiguous, nonexistent, or unsupported upstream configuration. A local-only upstream is not a remote source — ask the user for a remote branch instead. Never hardcode `origin` once the source is resolved.

## 3. Fetch and inspect changes

```bash
git ls-remote --exit-code --heads "$remote" "$source_ref"
```

Exit 0 means the branch exists, exit 2 means no matching ref, any other result is a network or authentication failure. Do not treat a network error as a missing branch.

```bash
# Read this BEFORE fetching: fetch rewrites the remote-tracking ref, which would
# otherwise make prev equal remote_tip and turn the rewind check into a no-op.
prev=$(git rev-parse --verify -q "refs/remotes/$remote/$source_branch" || true)

git fetch --no-tags --no-recurse-submodules "$remote" "$source_ref" || { echo "fetch failed"; exit 1; }
remote_tip=$(git rev-parse --verify -q 'FETCH_HEAD^{commit}') || { echo "no usable FETCH_HEAD"; exit 1; }

if [ -n "$prev" ] && [ "$prev" != "$remote_tip" ]; then
  git merge-base --is-ancestor "$prev" "$remote_tip" \
    || echo "remote rewound: $prev is not an ancestor of $remote_tip"
fi
```

Use the fetched SHA as the integration target instead of assuming a remote-tracking ref exists or is fresh. `prev` is only the tip recorded by the last local fetch, so this detects rewrites since then — not the remote's full history. A rewind means stop and ask before integrating.

A failed fetch leaves `FETCH_HEAD` unusable, so check both exit codes rather than letting an empty `remote_tip` reach later commands.

```bash
if ! git merge-base HEAD "$remote_tip" >/dev/null 2>&1; then
  echo "unrelated histories — stop"
fi
ahead=$(git rev-list --count "$remote_tip..HEAD")
behind=$(git rev-list --count "HEAD..$remote_tip")
```

| Ahead | Behind | Meaning               | Action                  |
| ----- | ------ | --------------------- | ----------------------- |
| 0     | 0      | Up to date            | Stop                    |
| 0     | >0     | Fast-forward possible | Update                  |
| >0    | 0      | Local commits ahead   | No pull needed          |
| >0    | >0     | Diverged              | Review and offer rebase |

`git merge-base` exits 1 when there is no common ancestor, while `rev-list --count` still returns numbers. Those numbers are meaningless: stop for unrelated histories instead of applying the table (they will look like `>0`/`>0`).

```bash
git log --oneline "HEAD..$remote_tip"   # incoming
git log --oneline "$remote_tip..HEAD"   # local-only, when diverged
```

Summarize the incoming changes. Commits ahead of one remote are not necessarily unpublished; they may exist elsewhere.

## 4. Decide the integration strategy

**A. Up to date** (`ahead=0`, `behind=0`): report `Already up to date with <remote>/<source_branch>.` Do not stash, rebase, merge, or touch the worktree.

**B. Local ahead only** (`ahead>0`, `behind=0`): report that no incoming updates exist and local commits remain ahead. Do not push.

**C. Fast-forward** (`ahead=0`, `behind>0`): the default. It adds commits without creating a merge commit or rewriting anything. No extra approval is needed when the user asked for an update, the source is unambiguous, the worktree is clean, and nothing unusual exists. A dirty worktree requires a stash decision first (section 5).

**D. Diverged** (`ahead>0`, `behind>0`):

1. Show local-only and incoming commits.
2. Check whether rebase would rewrite known-published commits: `git branch -r --contains <sha>` and `git tag --contains <sha>`. Because section 3 fetches with `--no-tags`, local tags may be missing — also run `git ls-remote --tags "$remote"` before concluding a commit is unpublished.
3. Check for merge commits or other unsupported topology.
4. Explain that rebase changes local commit SHAs.
5. Get approval before modifying history.

```text
Local branch and remote have diverged.

Local commits: 2
Incoming commits: 3

Recommended: rebase the 2 local commits onto the fetched remote tip.

Proceed?
```

Never silently rebase published history. If the project requires merge-based integration or preserved merge topology, stop and ask for a separately approved strategy instead of changing this skill's default.

## 5. Choose the stash strategy

Decide this only after integration is known to be necessary. Never stash merely because the worktree is dirty.

| Condition                                 | Strategy               |
| ----------------------------------------- | ---------------------- |
| No integration needed                     | No stash               |
| Clean worktree                            | No stash               |
| Only unstaged tracked changes             | Prefer Auto Stash      |
| Staged changes need protection            | Manual Stash           |
| Untracked files, no collision risk        | Leave them untouched   |
| Untracked files colliding with the update | Manual Stash with `-u` |
| Ignored files colliding with the update   | Stop and ask           |
| Complex or uncertain worktree state       | Explain risks and ask  |

"Collision" is concrete, not a guess — compare the incoming paths against everything Git will not protect:

```bash
git diff --name-only "HEAD..$remote_tip" | sort > "$TMP/incoming"
{ git ls-files --others --exclude-standard; git ls-files --others --ignored --exclude-standard; } \
  | sort > "$TMP/localonly"
comm -12 "$TMP/incoming" "$TMP/localonly"
```

A non-empty intersection of untracked paths needs Manual Stash `-u`. A non-empty intersection of **ignored** paths must stop the update: no stash captures ignored files, and fast-forward overwrites them without the `would be overwritten` warning it gives for untracked files, so the local content is lost silently. Offer a backup, an explicitly approved `-a` stash, or abandoning the update.

Ignored files are included by neither Auto Stash nor `git stash push -u`. Do not use `git stash -a` without separate approval.

### Auto Stash

```bash
git merge --ff-only --autostash "$remote_tip"
git rebase --autostash --no-update-refs "$remote_tip"
```

Auto Stash covers tracked changes only, silently demotes staged changes to unstaged when it restores them, and its restoration can conflict even when integration succeeds. Do not use it with staged changes present; use Manual Stash there.

Afterward, treat "integration finished" and "changes restored" as independent facts — both `merge --ff-only --autostash` and `rebase --autostash` can exit 0 (rebase even prints `Successfully rebased`) while leaving an unmerged index and a retained `autostash` entry:

```bash
git rev-parse --short HEAD
git ls-files -u                      # non-empty => restoration conflicted
git stash list --format='%gd %gs'   # an `autostash` entry => restoration incomplete
```

Do not report an update as successful when either check is non-empty. Report the conflict and any retained stash reference, and follow the recovery in section 7.

### Manual Stash

Use it when staged changes, colliding untracked files, or other conditions need stronger control.

Before stashing: record HEAD and the worktree status, review staged/unstaged/relevant untracked files, decide whether `-u` is needed, record the existing stash tip, explain that `-u` includes all non-ignored untracked files unless path-scoped, and get approval including the cleanup policy.

```bash
pre_oid=$(git rev-parse --verify -q refs/stash || true)
git stash push -u -m "agent-git-pull: pre-update"   # drop -u when only tracked changes are saved
stash_oid=$(git rev-parse --verify -q refs/stash || true)

[ -n "$stash_oid" ] && [ "$stash_oid" != "$pre_oid" ] \
  || { echo "stash not created — stop"; exit 1; }
git log -1 --format=%s "$stash_oid" | grep -qx 'On .*: agent-git-pull: pre-update' \
  || { echo "unexpected stash entry — stop"; exit 1; }
```

`git stash push` exits 0 with `No local changes to save`, and `refs/stash` then still points at the user's older entry — without the equality and subject checks you would apply and later drop an unrelated stash. Confirm the worktree is clean before integrating. Do not assume the entry stays `stash@{0}`.

## 6. Integrate remote changes

Immediately before integrating, verify the branch is unchanged, HEAD still matches the inspected state, the remote tip is valid, and no unexpected operation started. Reassess if anything changed.

### Fast-forward

```bash
git merge --ff-only --no-autostash "$remote_tip"   # clean worktree or prepared via Manual Stash
git merge --ff-only --autostash  "$remote_tip"      # Auto Stash selected
```

Never fall back to a merge commit when fast-forward fails. If local files would be overwritten, stop and reconsider the stash strategy.

### Rebase (only after approval)

```bash
git rebase --no-autostash --no-update-refs "$remote_tip"   # clean or Manual Stash
git rebase --autostash --no-update-refs  "$remote_tip"     # Auto Stash
```

`--no-update-refs` stops `rebase.updateRefs` from moving other branch refs. Do not use `--rebase-merges`, interactive rebase, or automatic conflict resolution without reviewing that strategy separately.

After rebase, check whether commits were unexpectedly skipped, dropped, or became empty; do not assume a one-to-one replacement for every local commit.

### Integration gate

Every integration path ends here before section 7 or 8:

```bash
git rev-parse --short HEAD
git ls-files -u                      # non-empty => unmerged paths remain
git stash list --format='%gd %gs'   # an `autostash` entry => Auto Stash did not restore
git merge-base --is-ancestor "$remote_tip" HEAD || echo "update did not land"
```

The first three lines exist because Success messages and exit code 0 do not prove restoration. Keep the repository in this state, report it, and do not start squash or push work from a partially restored worktree.

## 7. Conflict handling

```bash
git status
git diff --name-only --diff-filter=U
git ls-files -u
git rebase --show-current-patch
```

Analyze and explain the conflicting changes. Do not choose `ours`/`theirs` or overwrite either side. Offer:

**Abort**

```bash
git rebase --abort
```

Then verify the resulting HEAD, inspect the worktree and index, and check whether an Auto Stash was restored or retained. While a rebase is still in progress the auto stash is not in `git stash list` (it lives under `.git/rebase-merge/`), so an empty stash list is normal and does not mean the changes were lost; `git rebase --abort` restores them. Restore a Manual Stash only after the rebase fully ended and restoration is safe. Do not claim the repository is restored without verification.

**Manual resolution**

The user resolves and stages the conflicts; after confirmation:

```bash
git ls-files -u
git diff --cached --check
git rebase --continue
```

Review the resolved result before continuing and repeat the analysis if new conflicts appear. Never skip commits or use destructive resets.

### Fast-forward and stash conflicts

Fast-forward can fail when local changes block checkout, and stash restoration can conflict after the branch update already completed. In both cases do not assume the update was rolled back: report the current HEAD and conflicting files, preserve any retained stash, and never reset the branch or discard local files on your own. Recovery that rewrites or discards state needs user approval.

Auto Stash restoration conflict is not a rebase conflict: the rebase already finished, so `git rebase --abort` and `git rebase --continue` both fail with `fatal: no rebase in progress`. Do not follow Git's own suggestion to run `git reset --hard`. Two approved options:

- Resolve in place: the user edits the conflicted files and stages them; drop the retained `autostash` entry only after the result is verified.
- Defer: `git restore --source=HEAD --staged --worktree -- <paths>` clears the unmerged entries while keeping the `autostash` entry, so the change can be replayed later with `git stash apply`. Verified: the status returns to clean and the entry remains.

A common concrete case: an untracked file that the incoming commits also add. The stash stores it, the merge creates its own version, and restoration then stops with `u.txt already exists, no checkout` / `could not restore untracked files from stash` while the retained entry stays in the stash list. The merge is already complete at that point. Show both versions and let the user choose which content wins; do not re-run the stash with `--force`-style workarounds or delete the entry.

## 8. Restore Manual Stash

Restore after successful integration, after a safely completed abort, or after an abandoned integration that never moved HEAD (confirm `git rev-parse HEAD` still equals the recorded `original_head`). Otherwise the changes stay stranded in the stash while the worktree looks clean.

```bash
git stash apply --index "$stash_oid"
```

`--index` attempts to restore the original staged/unstaged split. Then:

```bash
git status --porcelain=v1 --untracked-files=all
git ls-files -u
```

Confirm the expected tracked modifications are present, staged changes are staged again where restoration succeeded, required untracked files returned, no unresolved conflicts remain, and nothing unexpected changed.

If `--index` fails, do not retry without it — that would lose the staging distinction. Prefer `apply` over `pop` so the entry survives; a failed `apply` also leaves the entry intact.

Failure has two shapes, and they need different reporting:

- `error: conflicts in index. Try without --index.` — nothing was applied; the worktree still matches the post-merge state.
- `CONFLICT ...` / `could not restore untracked files from stash` — **partially applied**: some staged changes are staged again, some files carry markers as unmerged entries, some untracked files are back.

A failed `apply --index` can also drop pre-existing staged entries (`Index was not unstashed.` turns a staged new file into an untracked one). Compare `git ls-files -s` against what you recorded before applying, and report any lost staging state instead of assuming the index is untouched.

Dropping requires locating the entry by its recorded SHA, since `git stash drop` takes a stash reference:

```bash
entry=$(git stash list --format='%H %gd' | awk -v s="$stash_oid" '$1==s{print $2}')
[ -n "$entry" ] && git stash drop "$entry"
```

Drop only when the entry is positively the stash this workflow created and cleanup was approved. Never run `git stash clear` or drop an unidentified entry, and never delete pre-existing user stashes.

## 9. Verify the update

```bash
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git log --oneline -5
git merge-base --is-ancestor "$remote_tip" HEAD
```

HEAD equals the fetched tip after a fast-forward; it differs after a rebase because local commits were replayed. Confirm the update landed, expected local commits remain represented, local changes survived, staged changes were restored, and no conflict or stash recovery remains.

A dirty worktree is not proof of failed restoration — preserved local modifications are the normal outcome. If submodule references changed, report that submodule worktrees may need updating; never initialize, update, reset, or clean submodules automatically.

Run a cheap known project validation after the update when available, and report failures without changing code to fix them. Do not amend commits or modify unrelated files.

## 10. Report

```text
Already up to date with `<remote>/<source_branch>`.
Branch: `<branch>` · Local changes: preserved
```

```text
Updated `<branch>` from `<remote>/<source_branch>`.

Method: fast-forward | rebase
Commits received: <count>
Local commits rebased: <count>      (rebase only)
HEAD: `<short-sha>`
Stash: none / auto restored / manual restored
Local changes: preserved / none
```

For local ahead:

```text
No incoming updates from `<remote>/<source_branch>`.
Local commits ahead: <count> · No pull operation needed.
```

On conflict or failure report the failed operation, current branch and HEAD, conflicting files, rebase/merge state, any retained stash reference, whether local changes appear preserved, and the safe recovery choices. Never claim success while integration or restoration is incomplete.

## Red flags

Stop and ask when: the remote source is ambiguous, no valid upstream exists and the source cannot be determined, remote history appears force-updated, histories are unrelated, rebase would rewrite known-published commits, unsupported merge topology is present, a stash could capture unrelated or sensitive local files, staged changes cannot be preserved safely, untracked or ignored files may be overwritten, rebase or stash restoration conflicts remain, the branch or HEAD changes unexpectedly, an unfinished Git operation exists, or recovery would need destructive commands.

## Execution boundaries

- Follow applicable project instructions such as `AGENTS.md`.
- Never invoke `git-commit` or `git-push` automatically.
- Never create a merge commit as a fallback.
- Never run `git reset --hard` or `git clean`. `git reset --soft` is not used by this skill.
- Never silently discard staged, unstaged, or untracked changes.
- Never delete unrelated stash entries.
- Never change global or repository Git configuration to enable Auto Stash.
- Never modify upstream tracking without explicit authorization.
- Never rewrite unrelated branches or known-published history without separate approval.
- No automatic squash, amend, tag operations, or PR creation.
- Prefer concise, outcome-first reporting over routine command narration.

## Design notes

**Fetch before integration.** Fetching updates remote knowledge without touching the branch, so inspection can precede the strategy choice.

**Fast-forward first.** A branch that is simply behind is advanced, not rebased or merged into a commit.

**Rebase only for divergence.** Replay is used when incoming commits must precede local ones, and it needs approval because it rewrites commit identities.

**Smart Stash.** Auto Stash is the lightweight default for unstaged tracked changes; Manual Stash covers index state and untracked files.

**No unnecessary stash.** Checking for updates, an up-to-date branch, or a local-ahead branch must never trigger stash operations.

**Preserve the index.** Staged changes are user-owned state; never silently alter their staging status.

**No implicit publication.** Updating the branch never implies pushing it.

**Point-in-time update.** Integration targets the fetched tip; if the remote advances again, another fetch reveals it — do not loop indefinitely.

**No silent recovery.** Report conflicts and uncertain restoration instead of forcing completion with destructive commands.
