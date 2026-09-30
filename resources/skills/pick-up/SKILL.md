---
name: pick-up
description: Pick up work where a previous session left off, from its handover. Use when the user says to continue, resume, pick up, or read the handover, or when a session starts on unfinished work.
---

# Pick up

A handover describes the state when it was written. Things may have changed since: other agents commit, the user edits, tests break. Check before you trust it.

## Steps

1. **Read the handover.** Use `hive_read_latest_handover` (it finds the latest one for this project). If the Hive tools aren't available, look for `HANDOVER.md` in the project root, or ask the user where it is.
2. **Compare it with reality.**
   - `git status`, the current branch and `git log --oneline -15`: are the commits it mentions there? Is there new work since it was written?
   - Run the checks it mentions (tests, typecheck, lint). Do they still pass or fail the same way?
   - Open the files it names. Are the changes it describes actually there?
3. **Report back briefly** before starting work:
   - what the handover says the next step is;
   - anything that no longer matches (new commits, different failures, missing changes);
   - open questions it lists that still need the user;
   - the step you propose to take first.

Then wait for the user to confirm, unless they've already told you to go ahead. If the handover and reality disagree in a way that changes the plan, say so plainly rather than quietly picking one.

## When there's no handover

Say so, and offer to build a picture from `git log`, uncommitted changes and the project's notes instead. Use `hive_list_shared_notes` to check whether a note for this work exists under another name.
