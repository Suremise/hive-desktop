---
name: workspace-note
description: Record a lasting decision, convention or gotcha in the workspace's shared notes. Use when asked to remember or document something for later, or when other agents will need what you learned. Not for work in progress.
metadata:
  audience: all
---

# Workspace note

Hive's shared notes (the workspace's `.hive/shared`) are read by every project and agent. They are for knowledge that outlives this conversation: decisions and their reasons, conventions, setup steps, and gotchas that cost time to find.

They are not for:

- the state of work in progress (a handover);
- what only one project's agents need (that project's `CLAUDE.md` or `AGENTS.md`);
- copies of a product's specification or docs (link to them instead).

## Steps

1. **Check what exists.** `hive_list_shared_notes`, then read the notes that may cover this already (`hive_read_shared_note`). Updating a note beats adding a near-duplicate.
2. **Decide where it goes.**
   - An existing note on the topic: update it, keeping its structure. Use `append` only for log-style notes; otherwise rewrite the section.
   - A new topic: a short, descriptive path in a folder by kind: `conventions/` for rules to follow, `decisions/` for choices and their reasons, `setup/` for how-tos, and `plans/` for plans. `handovers/` is Hive's, for handovers.
3. **Write it for a reader with no context.**
   - The point first: the decision, rule or fact, in a sentence or two.
   - Why, and the alternatives rejected, when that matters.
   - Where it applies: which projects, folders or situations.
   - The date, and the project it came from.

   Keep it short, name files, commands and settings exactly, and never include secrets, tokens or personal data.
4. **Save it** with `hive_write_shared_note`.

Tell the user in a line which note you created or changed. Without Hive's tools, show the note in your reply and suggest where it goes.
