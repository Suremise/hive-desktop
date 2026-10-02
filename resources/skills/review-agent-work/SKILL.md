---
name: review-agent-work
description: Review work another agent did (a worktree branch, recent commits or uncommitted changes) and report problems without changing anything. Use when the user asks for a review, a second opinion, or to check another agent's work.
---

# Review agent work

In Hive, one agent often writes code while another reviews it. You are the reviewer: find what's wrong, don't fix it. Leave the code exactly as it is unless the user explicitly asks you to make changes.

## 1. Find what to review

Ask the user if it isn't clear. Common cases:

- **Another agent's worktree branch**: `git worktree list` shows the worktrees; review `git diff <base>...<branch>`.
- **Recent commits**: `git log` and `git show` for the range the user names.
- **Uncommitted changes** in this folder: `git diff` and `git diff --staged`.

`hive_project_status` shows the project's agents and where each one works, which helps when the user names an agent rather than a branch.

**A card on the task board** (the user names one, #n): reviewing it isn't working on it. Leave it in Review with the agent that did the work (don't move it to Doing), and call `hive_update_task` with `review: "start"` so the board shows you as its reviewer. Its description and comments say what was meant and what was done.

## 2. Understand the intent

Before judging the code, learn what it was meant to do: the user's request, a handover (`hive_read_latest_handover`), commit messages, or a plan in the shared notes. A change can be clean and still do the wrong thing.

## 3. Review

Read the whole change, and the code around it where needed. Look for, in this order:

1. **Bugs**: wrong logic, missed edge cases (empty, missing, very large, concurrent), broken error handling, resource leaks.
2. **Missed requirements**: things asked for that aren't done, or are done differently.
3. **Risk**: security (injection, secrets, unsafe paths), data loss, breaking changes to formats or APIs, performance traps.
4. **Tests**: new behaviour without tests, tests that don't really test it.
5. **Clarity**: only where it will cause real trouble later. Skip style nits unless asked.

Run the tests if you can, but don't commit or change files.

## 4. Report

List findings most serious first. For each: **file:line**, what's wrong, a concrete case where it goes wrong, and a suggested fix in a sentence. Say how sure you are when you aren't certain. End with a short verdict: ready, ready after small fixes, or needs more work.

If you found nothing significant, say so plainly, and mention what you checked, so the user knows how far to trust it.

For a card, end the review on the board: `hive_update_task` with `review: "passed"` or `"failed"` and your report as the `comment`. The card stays in Review either way; move it to Done only if the user asked you to (now or as a standing instruction), and leave the fixes to whoever the user asks to make them.
