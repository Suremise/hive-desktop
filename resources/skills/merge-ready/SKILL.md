---
name: merge-ready
description: Get a worktree agent's branch ready to be reviewed and merged in Hive. Use when the user asks to finish up, get ready to merge, or wrap up work on a branch or worktree.
---

# Merge ready

In Hive, an agent can work in its own git worktree on its own branch. When the work is done, the user reviews the branch and merges it into the project from Hive. Your job is to make that review quick and the merge safe.

## Steps

1. **Check where you are.** `git branch --show-current` and `git worktree list`. If you are on the project's main branch rather than a worktree branch, stop and tell the user: this skill is for work on a separate branch.
2. **Finish loose work.** Look at `git status`. Commit work that belongs to the task, with clear messages. Don't commit build output, logs, local config or secrets; list anything you left uncommitted and why.
3. **Run the checks.** Find the project's own commands (`package.json` scripts, a Makefile, the README, CI config) and run tests, typecheck and lint. Fix failures that come from this branch. Report failures that were already there before this work, without fixing unrelated code.
4. **Check against the base branch.** `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD` (the base is usually `main` or `master`). Look for files changed by accident, debug code, commented-out code and TODOs left behind. If the base has moved on and the branch conflicts, say so; don't rebase or merge unless the user asks.
5. **Write the summary** for the reviewer:
   - **What**: the change in a few sentences.
   - **Why**: the problem it solves.
   - **How to check**: what to try or look at.
   - **Checks**: what you ran, and the result.
   - **Watch out for**: risky areas, follow-ups, anything unfinished.

## Finishing

Give the user the summary and say whether the branch is ready. Don't merge, push or delete the branch yourself: merging is done from Hive, where the user can review it first. If the Hive tools are available and the user isn't watching this agent, a short `hive_notify` saying the branch is ready helps them notice.
