---
name: workspace-note
description: Record a decision, convention or gotcha in the workspace's shared notes, where every project and future session can find it. Use when the user says to remember, note or document something for later, or when you learn something other agents will need.
---

# Workspace note

Hive's shared notes (`.hive/shared` in the workspace) are read by every project and every agent. They're the right place for knowledge that outlives this conversation: decisions and their reasons, conventions, setup steps, gotchas that cost time to discover.

They're not the place for handovers of work in progress (use the `handover` skill), or for instructions only one project's agents need (those belong in that project's `CLAUDE.md` or `AGENTS.md`).

## Steps

1. **Check what exists.** Use `hive_list_shared_notes` and read notes that might already cover this topic with `hive_read_shared_note`. Updating a note is better than adding a near-duplicate.
2. **Decide where it goes.**
   - An existing note on the topic: update it, keeping its structure. Use `append` only for log-style notes; otherwise rewrite the relevant section.
   - A new topic: create a note with a short, descriptive path, grouped by folder when it helps (`decisions/`, `conventions/`, `setup/`), for example `conventions/error-handling.md`.
3. **Write it for a reader with no context.**
   - Start with the point: the decision, rule or fact, in one or two sentences.
   - Then why, including alternatives rejected, when that matters.
   - Where it applies: which projects, folders or situations.
   - The date, and the project it came from.

   Keep it short. Name files, commands and settings exactly. Never include secrets, tokens or personal data.
4. **Save it** with `hive_write_shared_note`.

Tell the user in one line which note you created or changed. If the Hive tools aren't available, show the note in your reply and suggest where to put it.
