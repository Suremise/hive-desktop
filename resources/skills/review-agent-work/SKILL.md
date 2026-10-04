---
name: review-agent-work
description: Review another agent's work (a card in Review, a branch, commits or uncommitted changes) and report findings without changing it. Use when asked to review, check or verify work.
metadata:
  audience: agents
---

# Review agent work

You are the reviewer: find what's wrong, don't fix it. Leave the code, the branch and the card's assignment as they are. The user decides what gets fixed and by whom.

## 1. Find exactly what to review

- **A card** (#n): read it with `hive_read_task`. Its description says what was meant, and its comments say what was done and where. Start the review on the board: `hive_update_task` with `review: "start"`. The card stays in Review with the agent that did the work. You are recorded as its reviewer, separately.
- **A worktree branch**: `git worktree list`, then `git diff <base>...<branch>` and `git log <base>..<branch>`.
- **Commits**: `git show` for the range named.
- **Uncommitted changes**: `git status`, `git diff` and `git diff --staged` in that folder.

`hive_project_status` shows each agent's folder and branch when you're told an agent's name rather than a branch. Note the exact commit or state you reviewed, so the verdict refers to it. Ask the user if what to review is unclear.

## 2. Know the intent

Check the change against what was asked: the card, the user's request, a handover (`hive_read_latest_handover`) or a plan in the shared notes. A clean change can still do the wrong thing.

## 3. Review

Read the whole change, and the code around it where needed. In order of importance:

1. **Bugs**: wrong logic, missed edge cases (empty, missing, very large, concurrent), broken error handling, leaks.
2. **Missed requirements**: asked for but not done, or done differently.
3. **Risk**: security (injection, secrets, unsafe paths, access checks), data loss, breaking formats or APIs, performance traps.
4. **Tests**: new behaviour without tests, or tests that don't test it.
5. **Clarity**: only where it will cause real trouble later.

Run the checks that matter (tests, typecheck, a repro of a suspected bug) without committing or changing files; scratch files go outside the project. Note what you ran.

**Don't repeat the builder's run.** When the builder posted a run record (which checks ran on exactly which code, with results and logs), check it is for the code you are reviewing, and trust it for those checks. Rerun the quick ones (typecheck, lint, unit tests) and the one or two closest to the riskiest change, and spend the rest of your time on what the builder didn't test: your own probes find what a repeated run doesn't. Rerun more when there's no record, it is for other code, or something in it looks wrong (a flaky check, a pass that doesn't fit the change). The project's notes may say how to check a record.

## 4. Report

Findings, most serious first. For each:

- **file:line**;
- what's wrong;
- a concrete case where it goes wrong (input or steps, and the result);
- the impact;
- a suggested fix in a sentence.

Say how sure you are when you aren't certain. Then give the verdict, with what you checked and what you didn't, so the user knows how far to trust it.

## 5. Verdict on the board

For a card, end your review with `hive_update_task`:

- `review: "passed"` or `"failed"`, with the report as `comment`.
- The card stays in Review either way.
- Move it to `done` in the same change only if the user asked you to (now or as a standing instruction) and it passed.
- Leave a failed card's fixes to whoever the user asks to make them.

If the card leaves Review while you review it (taken back to Doing for more work), your review is over. Leave the card where it is: don't move it back to Review or on to Done (even if you were allowed to finish it), start another review or give a verdict: tell the user what you found, so the newer work is reviewed when it's ready. Only if your own session ended mid-review, with the card still in Review, start the review again.

## Reviewing again

When the card comes back after fixes, review what changed since your last verdict: the new commits, and the comments after yours. Re-run a check only when what it covers has changed, and confirm each earlier finding is fixed or still open.
