---
name: merge-ready
description: "Get a branch ready to review and merge in Hive: commit the task's work, run the checks, compare with the base, summarise. Use when asked to finish up or get a branch or worktree ready to merge. Merging and pushing stay separate."
metadata:
  audience: agents
---

# Merge ready

In Hive an agent often works in its own git worktree on its own branch. The user reviews the branch and merges it from Hive. Make that review quick and the merge safe.

## Steps

1. **Where you are.** `git branch --show-current` and `git worktree list`. This prepares a separate branch. On the project's main branch there is nothing to merge: say so, and do what the user asked (commit there only if they asked you to).
2. **Finish loose work.** `git status`. Commit the work that belongs to this task, with clear messages, and only that. Leave out build output, logs, local config and secrets. List anything you left uncommitted, and why.
3. **Run the checks.** Use the project's own commands (package scripts, a Makefile, the README, CI config): tests, typecheck, lint, and whatever else the change needs. Fix failures this branch caused. Report failures that were there before, without fixing unrelated code.
4. **Compare with the base** (usually `main` or `master`):
   - `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Look for files changed by accident, debug code, commented-out code and leftover TODOs.
   - If the base has moved on, check whether it merges cleanly, for example with `git merge-tree --write-tree <base> HEAD`, and say whether there are conflicts.
5. **Summarise for the reviewer**:
   - **What**: the change in a few sentences.
   - **Why**: the problem it solves (and the card, if there is one).
   - **How to check**: what to try or look at.
   - **Checks**: what you ran, and the results.
   - **Watch out for**: risky areas, follow-ups, anything unfinished.

## Finishing

Give the user the summary and say plainly whether the branch is ready, and if not, what's in the way. Merging is done from Hive, where the user reviews it first. Rebase, merge, push, delete the branch or publish only when the user asks you to. If the user isn't watching this agent, a short `hive_notify` that the branch is ready helps them notice.
