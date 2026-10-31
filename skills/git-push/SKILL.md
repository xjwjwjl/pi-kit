---
name: git-push
description: Publishes local commits to a remote branch with an explicit target, optional pre-push rebase, and optional squash. Use when the user asks to push, sync with the remote, or ship committed changes.
compatibility: Uses git via bash; no GitHub or remote required.
---

# Git Push

Safely publish local commits to a remote branch while preserving unrelated worktree changes, staging state, and local history.

## Core principles

- Push only to an explicitly resolved remote and destination branch. Never infer branch protection rules.
- Fetch and inspect the destination before pushing. Rebase only when local commits must be integrated with newer remote commits.
- A dirty worktree alone does not block a normal push of existing commits.
- Use Auto Stash for simple dirty-worktree rebases; use Manual Stash when staging state, untracked files, or a subsequent squash requires greater control.
- If multiple outgoing commits exist, offer an optional squash unless the user has already specified a preference.
- Rebase before squash. Never rewrite unrelated or known-published history without explicit authorization.
- Never force-push, discard changes, skip hooks, or silently change upstream tracking.
- Require explicit confirmation of the final push target and commit range.
- Ask only when the scope is ambiguous, history must be rewritten, or an unconfirmed action is about to run. Do not ask again for a choice already authorized.
- Report meaningful progress, decisions, and blockers without narrating routine Git commands.

## 1. Inspect repository state

```bash
git rev-parse --show-toplevel
git symbolic-ref --quiet --short HEAD
git rev-parse --verify HEAD
git remote -v
git status --porcelain=v1 --untracked-files=all
git branch -vv
```

Also check for unfinished merge, rebase, cherry-pick, revert, or unresolved index entries.

Stop when:

- Not inside a Git repository.
- Detached HEAD or no valid local HEAD commit.
- Another Git history operation is in progress.
- Unmerged entries already exist.
- No usable remote is configured.

Do not automatically run `git stash`, `git reset`, or `git clean` during inspection.

Classify the worktree as clean, unstaged tracked changes, staged changes, untracked files, or a combination. Record the current branch and HEAD SHA.

Do not stop merely because uncommitted changes exist. Whether they need protection depends on the operation determined later.

## 2. Resolve push destination

```bash
branch=$(git symbolic-ref --quiet --short HEAD)
git config --get "branch.$branch.remote"
git config --get "branch.$branch.merge"
```

### Existing upstream

Use the configured remote and destination branch. Do not assume the destination branch has the same name as the local branch.

If the configured upstream refers to a local branch, an invalid remote, or an ambiguous destination, ask the user to select a remote destination.

### No upstream

- Use an explicitly specified destination if provided.
- Otherwise suggest the current branch name on the only configured remote.
- If multiple remotes or plausible destinations exist, ask the user to choose.

For a new destination, include whether upstream tracking should be set in the final push confirmation. Do not modify upstream tracking before a successful push.

### Target invariant

Retain these resolved values (placeholders, not shell to paste):

```text
local_branch  = current local branch
remote        = selected remote
push_branch   = remote destination branch
```

All later operations must use this resolved target. Never substitute a bare `git push` or a hardcoded `origin`.

### Remote configuration safety

```bash
git remote get-url --all "$remote"
git remote get-url --push --all "$remote"
git config --get "remote.$remote.mirror"
git config --get-all "remote.$remote.push"
```

Use explicit refspecs so `push.default` and remote push refspecs cannot silently broaden the scope.

Stop and explain if mirror pushing is enabled, multiple push URLs would update several repositories, the push destination differs from the fetch destination without independent verification, or the remote configuration makes a single-branch push ambiguous. Do not silently override unusual remote configurations.

## 3. Fetch and inspect divergence

```bash
git ls-remote --exit-code --heads "$remote" "refs/heads/$push_branch"
```

Exit 0 means the branch exists, exit 2 means no matching ref, any other result is a network or authentication failure — never treat a network error as a missing branch and "publish a new branch" over it.

For an existing branch, fetch its tip. Read the previous remote-tracking tip **before** the fetch, because the fetch rewrites it:

```bash
prev=$(git rev-parse --verify -q "refs/remotes/$remote/$push_branch" || true)

git fetch --no-tags --no-recurse-submodules "$remote" "refs/heads/$push_branch" || { echo "fetch failed"; exit 1; }
remote_tip=$(git rev-parse --verify -q 'FETCH_HEAD^{commit}') || { echo "no usable FETCH_HEAD"; exit 1; }

if [ -n "$prev" ] && [ "$prev" != "$remote_tip" ]; then
  git merge-base --is-ancestor "$prev" "$remote_tip" \
    || echo "remote rewound: $prev is not an ancestor of $remote_tip"
fi
```

A rewind means the target branch was rewritten since the last local fetch: stop and ask before rebasing onto it or publishing over it.

Use the fetched SHA for later comparisons; do not assume a remote-tracking ref exists or is fresh.

```bash
git merge-base HEAD "$remote_tip" >/dev/null 2>&1 || echo "unrelated histories — stop"
git rev-list --left-right --count "$remote_tip...HEAD"
git log --oneline "$remote_tip..HEAD"
git log --oneline "HEAD..$remote_tip"
```

| State                          | Action                               |
| ------------------------------ | ------------------------------------ |
| Local contains remote tip      | No rebase required                   |
| Remote contains local HEAD     | No outgoing commits; report and stop |
| Both sides have unique commits | Rebase required before push          |
| Unrelated histories            | Stop and ask                         |
| Remote branch absent           | Treat as new-branch publication      |

Call `remote_tip..HEAD` **commits ahead of target**, not necessarily unpublished commits; they may already exist on another remote.

For a new remote branch: do not require a fork point, do not stop because the branch has no commits unique to another branch, determine a base only if squash is requested, and never guess that base from `main` or `master`.

Before any rewrite, check whether affected commits are reachable from known remote-tracking branches or relevant tags. Because the fetch uses `--no-tags`, local tags may be missing — also consult `git ls-remote --tags "$remote"` before concluding a commit is unpublished. If published history may be affected, stop and request explicit authorization. If the candidate history includes merge commits, review the topology and agree on a strategy before using the default linear rebase/squash flow.

## 4. Decide history and worktree strategy

### Squash decision

For more than one commit ahead of the destination, show the commit list and ask:

> 检测到 N 个待推送 Commit。是否合并为一个 Commit 后再推送？

Skip the question when the user already stated a preference. Decide before rewriting but execute after any required rebase. For a new remote branch, offer squash only when a trusted base is known or explicitly selected.

### Dirty-worktree decision

| Situation                                | Strategy                              |
| ---------------------------------------- | ------------------------------------- |
| Push only, no rebase or squash           | Leave worktree untouched              |
| Rebase, clean worktree                   | Normal rebase                         |
| Rebase, only unstaged tracked changes    | Prefer Auto Stash                     |
| Rebase, staged changes must be preserved | Manual Stash with index restoration   |
| Rebase, untracked files may collide      | Manual Stash including untracked files |
| Rebase + squash, dirty worktree          | Manual Stash across both operations   |
| Squash only, dirty worktree              | Manual Stash before squash            |

Untracked files do not always need stashing; leave them untouched when they do not interfere. Auto Stash excludes ordinary untracked files and does not guarantee the original staged/unstaged split. Do not choose Manual Stash merely because untracked files exist.

### Approval policy

- Ordinary push: final push confirmation only.
- Rebase that rewrites local history: explain it and get approval before starting.
- Auto Stash: include the strategy in that approval; do not ask a separate stash question.
- Manual Stash: explain what will be saved and restored, then get approval.
- Squash: get approval for the affected range and the combined message.

## 5. Rebase and stash handling

Skip when no rebase is needed.

```bash
original_head=$(git rev-parse HEAD)
```

### A. Clean worktree

```bash
git rebase --no-autostash --no-update-refs "$remote_tip"
```

`--no-autostash` prevents local configuration from silently stashing; `--no-update-refs` prevents it from moving other branch refs.

### B. Auto Stash

Only when the changes suit Auto Stash and no later operation needs a clean worktree.

```bash
git rebase --autostash --no-update-refs "$remote_tip"
```

Afterward check whether the rebase completed, inspect `git status --porcelain=v1`, verify the original changes were restored, and check for conflicts or a retained auto-stash entry. Do not assume restoration succeeded because the rebase did — `rebase --autostash` exits 0 even when restoration conflicts:

```bash
git ls-files -u                      # non-empty => restoration conflicted
git stash list --format='%gd %gs'   # an `autostash` entry => restoration incomplete
```

In that state no rebase is in progress, so `git rebase --abort`/`--continue` fail with `no rebase in progress`; never follow Git's suggestion of `git reset --hard`. Stop before pushing, report the conflict and the retained entry, and let the user resolve it (or clear it with `git restore --source=HEAD --staged --worktree -- <paths>`, which keeps the stash entry).

### C. Manual Stash

Use it when a rebase or squash needs reliable control of the staging state or untracked files.

Before stashing: inspect staged, unstaged, and relevant untracked changes; record HEAD and the worktree status; decide whether untracked files are included; record the existing stash tip so the new entry is distinguishable.

```bash
pre_oid=$(git rev-parse --verify -q refs/stash || true)
git stash push -m "agent-git-push: pre-rewrite"        # tracked changes
git stash push -u -m "agent-git-push: pre-rewrite"     # also untracked files
stash_oid=$(git rev-parse --verify -q refs/stash || true)

[ -n "$stash_oid" ] && [ "$stash_oid" != "$pre_oid" ] \
  || { echo "stash not created — stop"; exit 1; }
git log -1 --format=%s "$stash_oid" | grep -qx 'On .*: agent-git-push: pre-rewrite' \
  || { echo "unexpected stash entry — stop"; exit 1; }
```

`git stash push` exits 0 with `No local changes to save` and leaves `refs/stash` pointing at the user's older entry; the checks above are what prevents applying — or later dropping — an unrelated stash.

Avoid `-a`, which also captures ignored files, unless separately requested and reviewed. Confirm the worktree is clean and use the recorded `stash_oid` instead of assuming the entry stays `stash@{0}`:

```bash
git status --porcelain=v1 --untracked-files=all
git rebase --no-autostash --no-update-refs "$remote_tip"
```

**Do not restore a Manual Stash until all planned rebase and squash operations are finished.**

### Manual Stash restoration

```bash
git stash apply --index "$stash_oid"
```

`--index` attempts to restore the staged/unstaged split. If index restoration fails, do not retry without `--index` and do not discard the saved staging state; report and ask.

After applying: inspect `git status`, check for unmerged entries, compare the result with the pre-stash state, confirm included untracked files came back, and confirm nothing unintended is staged.

Do not delete the stash when restoration is incomplete. Remove it only when it is positively the entry this workflow created and cleanup was part of the approval; locate it by its recorded SHA first, because `git stash drop` takes a stash reference:

```bash
entry=$(git stash list --format='%H %gd' | awk -v s="$stash_oid" '$1==s{print $2}')
[ -n "$entry" ] && git stash drop "$entry"
```

Never run `git stash clear`, and never touch another stash entry.

### Rebase conflict handling

```bash
git status
git diff --name-only --diff-filter=U
git ls-files -u
git rebase --show-current-patch
```

Review the conflicting files and explain what each side changed. Do not resolve automatically, pick `ours`/`theirs`, or skip commits. Offer:

1. **Abort** — `git rebase --abort`, then inspect HEAD, worktree, and any Auto/Manual Stash state. During an in-progress rebase the auto stash is held under `.git/rebase-merge/` and does not appear in `git stash list`; abort restores it.
2. **Manual resolution** — the user resolves and stages the files; verify the state and continue.

When the user signals completion:

```bash
git ls-files -u
git diff --cached --check
git rebase --continue
```

Continue only when conflicts are resolved and the staged result has been reviewed; repeat if more conflicts appear. Never strip conflict markers blindly, overwrite user edits, or run `git reset --hard`.

On abort, remember that only the rebase itself is rolled back; earlier completed rewrites are not. Restore a Manual Stash only after the rebase has fully ended and the repository is suitable for restoration.

## 6. Optional squash

Run only after any required rebase finished, with an explicitly reviewed and approved range.

### Determine squash base

For an existing destination whose fetched tip is the accepted base: `base="$remote_tip"`. For a new remote branch, require a base that the user selected or that project context reliably establishes, and verify it is an ancestor of HEAD.

Do not squash when the base is uncertain, the range includes unrelated commits, affected commits may already be published without authorization, the history contains unsupported merges, or the index/worktree is not clean. A Manual Stash stays stored through this step.

### Inspect combined changes

```bash
git log --reverse --format='%B' "$base..HEAD"
git diff --stat "$base" HEAD
git diff "$base" HEAD
```

Generate the message from the actual combined changes, not from filenames or the oldest subject. The squash commit is created here rather than by `git-commit`, so its message rules are this skill's responsibility: the `git-commit` precedence chain (project convention → user instruction → repository style → fallback), the `<type>(<scope>): <中文说明>` fallback with `feat` / `fix` / `chore`, a body when the change needs explanation, and no AI attribution unless asked. Show the proposed message and range for approval.

### Execute squash

```bash
pre_squash_head=$(git rev-parse HEAD)
```

Verify the index and worktree are clean immediately before rewriting, then:

```bash
git reset --soft "$base"
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Confirm the staged content matches the approved combined change and contains no unrelated modifications, then commit with the approved message (`-m "<subject>"`, or `-m "<subject>" -m "<body>"`).

If the commit fails, stop and report HEAD, the index state, and `pre_squash_head`. Do not discard staged content. `git reset --soft "$pre_squash_head"` restores HEAD without touching the index, whose content already equals the pre-squash tree — use it only with approval and never combine it with `--mixed` or `--hard`. Verify the resulting commit before restoring any Manual Stash, and finish restoration (section 5) before pushing.

## 7. Review final push

```bash
git status --porcelain=v1 --untracked-files=all
git rev-parse HEAD
git log --oneline -10
```

For an existing destination:

```bash
git log --oneline "$remote_tip..HEAD"
git merge-base --is-ancestor "$remote_tip" HEAD
```

Do not push if the reviewed remote tip is not an ancestor of the final HEAD. For a new destination, review the local history and the proposed branch name. Intentionally preserved uncommitted changes need no new commit or stash before a normal push.

### Final confirmation

```markdown
## Proposed push

Local branch: <branch>
Destination: <remote>/<push_branch>
HEAD: <full SHA>
Remote status: existing / new branch

### Commits
<commit list>

### History operations
Rebase: performed / not needed
Squash: performed / not selected
Stash: none / auto restored / manual restored / requires attention

### Worktree
Clean / remaining local changes preserved

Set upstream: yes / no

Proceed with push?
```

Then capture `approved_head=$(git rev-parse HEAD)` and record the approved remote, destination ref, and last observed remote tip (or confirmed absence). Never push without explicit confirmation.

## 8. Push

Immediately before pushing:

1. Confirm the branch and HEAD still match the approved values.
2. Confirm the remote and destination are unchanged.
3. Recheck the destination branch with `git ls-remote`.
4. Confirm the remote tip still matches the reviewed tip, or the branch is still absent.
5. Confirm no rebase, merge, or unresolved stash conflict remains.

If relevant state changed, stop, inspect again, and request renewed approval.

```bash
# existing branch, or a one-shot new branch
git push --porcelain --no-follow-tags --recurse-submodules=check \
  "$remote" "$approved_head:refs/heads/$push_branch"
```

The explicit source SHA prevents a later local HEAD change from altering the pushed content. `-u` must not be added here: with a bare SHA as the source, `git push -u` silently writes no `branch.*` configuration. When upstream tracking was approved, set it explicitly after a successful push:

```bash
git fetch --no-tags "$remote" "refs/heads/$push_branch:refs/remotes/$remote/$push_branch"
git branch --set-upstream-to="$remote/$push_branch" "$local_branch"
```

`--no-follow-tags` prevents `push.followTags` from pushing tags. `--recurse-submodules=check` only rejects a gitlink whose target commit exists in the local submodule repository but is missing from the submodule's remote: it passes silently when the submodule is not initialized locally or the target SHA is unknown locally, and it never pushes submodule commits. When gitlinks changed, verify reachability yourself before concluding the push is safe.

Do not use `--force`, `--mirror`, `--all`, or implicit push refspecs.

### Push failure handling

- **Non-fast-forward:** fetch the target again, review the changed remote tip, repeat the integration and confirmation steps.
- **Authentication or permission failure:** report and stop.
- **Remote hook or branch-policy rejection:** report it; do not bypass it.
- **Submodule availability failure:** the reliable signal is stderr `The following submodule paths contain changes that can not be found on any remote`, with exit 128 and no porcelain ref line; the accompanying `remote end hung up unexpectedly` belongs to this failure, not to a network problem. Report the paths; do not push submodule commits.
- **Network failure:** verify the actual remote ref before concluding success or failure.

Never retry by force-pushing. An explicit user request for force-push needs a separate high-risk review of the exact target and expected remote SHA; prefer a narrowly scoped `--force-with-lease=<ref>:<expected>` when justified, and never escalate a normal push into a force update on your own.

## 9. Verify and report

```bash
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git ls-remote --heads "$remote" "refs/heads/$push_branch"
git rev-parse --abbrev-ref "$local_branch@{upstream}"   # only when upstream was requested
```

The push result is the primary success signal; the remote check is supporting evidence, and a ref moved again by another writer does not mean the push failed. Verify upstream tracking if requested.

```markdown
Pushed `<short-sha>`: `<branch>` → `<remote>/<push_branch>`.

Commits: <count>
Rebase: performed / not needed
Squash: performed / not selected
Stash: none / auto restored / manual restored / requires attention
Worktree: clean / local changes preserved
```

Also report remaining local changes, a retained Manual Stash and its reference, verification warnings, and unexpected changes from hooks or other processes. Do not claim all local changes were pushed while uncommitted changes remain. Do not create a pull request automatically.

## Red flags

Stop and ask when: the remote target is ambiguous, the destination differs unexpectedly from the configured upstream, remote configuration could broaden the push, the remote history changed since approval, rebase would rewrite known-published commits, the squash base or range is uncertain, unrelated work would be affected, the worktree cannot be safely protected for rewriting, Auto/Manual Stash restoration fails, rebase conflicts remain unresolved, the approved HEAD or destination changes, or the push is rejected for reasons the normal workflow cannot safely resolve.

## Execution boundaries

- Follow applicable project-level instructions such as `AGENTS.md`.
- Never implicitly commit dirty worktree changes via the `git-commit` skill.
- Never push uncommitted changes.
- Never use `git reset --hard`, `git clean`, or destructive stash operations without separate explicit authorization. `git reset --soft` is permitted only for the squash step in section 6.
- Never run `git stash clear`, and never drop a stash entry you have not identified by its recorded SHA.
- Never amend, skip commits, delete branches, or rewrite published history on your own.
- Never change global Git configuration to enable Auto Stash.
- Do not add unrelated remote operations, tag pushes, or PR creation.
- Keep routine inspection concise; report decisions and blockers rather than every command.

## Design notes

**Rebase-only integration.** The ordinary path rebases, never merges; repositories that intentionally preserve merge-based history need an explicitly chosen alternative.

**Auto Stash is temporary.** `--autostash` may restore changes at the end, but it does not cover untracked files, does not guarantee index preservation, and its restoration may conflict.

**Manual Stash spans the whole rewrite.** When both rebase and squash are planned, keep one reviewed Manual Stash until both finish, then restore.

**Squash is optional.** Never squash merely because several commits exist.

**Push scope is explicit.** Only one destination branch is updated; tags and other refs are excluded.

**Confirmation is state-specific.** Approval covers the exact reviewed HEAD and destination, not an open-ended future push.

**Remote state is authoritative.** Remote-tracking refs may be stale or absent; verify the destination before mutating anything.

**No silent recovery.** On failure, preserve recoverable state, report what happened, and ask before any destructive repair.
