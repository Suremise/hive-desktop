---
name: handover
description: Write a handover so a later session, another agent or another project can carry on this work. Use when the user asks to wrap up, hand over, stop for the day, or pass the work to someone else.
---

# Handover

A handover is read cold by someone with none of this conversation. Write it so they can continue in minutes, without re-discovering what you already know.

## Before writing

Check the real state rather than relying on memory:

1. `git status` and `git log --oneline -10`: what is committed, what isn't, which branch this is.
2. Run the project's quick checks if you know them (tests, typecheck, lint) and note the result. If you didn't run them, say so.
3. Note anything still running or half-done (a migration, a background job, a file you were in the middle of editing).

## What to write

Use these headings, and keep each one short and concrete:

- **Goal**: what this work is for, in a sentence or two.
- **Done**: what was completed, with commit hashes where there are some.
- **Current state**: branch, uncommitted changes, what passes and what fails (paste the key error line, not the whole log).
- **Decisions**: choices made and why, especially ones that look odd without context. Include what was tried and rejected.
- **Next steps**: an ordered list, the first one small enough to start straight away.
- **Open questions**: anything waiting on the user, with who needs to answer.
- **Files**: the files that matter most, with a word on each.

Leave out the story of how you got here. Name files, functions and commands exactly. Never include secrets, tokens or personal data.

## Saving it

Save it with the `hive_create_handover` tool (title: a few words on the work, content: the note). Hive files it under the workspace's shared notes for this project, and the next session is told it exists.

If the Hive tools aren't available in this session, write the note to `HANDOVER.md` in the project root instead and tell the user where it is.

Finish by telling the user, in one or two lines, where the handover is and what the next step is.
