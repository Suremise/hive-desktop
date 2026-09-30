---
name: split-work
description: Plan how several agents can work on one task side by side without getting in each other's way. Use when the user wants to run more than one agent on a project, parallelise a task, or asks how to divide work between agents.
---

# Split work

Hive can run up to four agents on one project. They work fastest when each one owns its own part of the code. Agents in the project folder share files (Hive's file locks stop two of them editing the same file at once, so one waits); agents in their own worktree have a separate copy on a separate branch, merged back later.

Your job is to produce a plan the user can hand to each agent. Don't start the work yourself.

## Steps

1. **Understand the task.** Read the request and the code it touches. Ask the user if the goal or the boundaries are unclear.
2. **Find the seams.** Split the work into parts that can proceed independently: separate modules, layers (API, UI, tests, docs) or features. A good part has a clear goal, a small set of files it owns, and few dependencies on the other parts.
3. **Order what can't be parallel.** Shared foundations (a new type, an interface, a schema, a shared helper) should land first, done by one agent, before the others start on top of them. Say so explicitly.
4. **Choose where each part works.**
   - **Project folder**: small or tightly connected changes, or when the parts touch different files anyway.
   - **Worktree**: larger or riskier parts, experiments, or parts that must change files another part also changes. Worktrees cost a merge at the end, so don't use them for trivial parts.
5. **Plan the merge.** Say in what order the parts come back together and who checks the result as a whole (often a final review with the `review-agent-work` skill).

## The plan

For each part, write:

- **Part name** and a one-line goal.
- **Owns**: the files or folders only this part changes.
- **Reads but doesn't change**: files it depends on.
- **Where**: project folder or worktree, and why.
- **Depends on**: parts that must land first.
- **Done when**: how to tell it's finished (checks pass, behaviour works).
- **Brief**: a short, self-contained prompt the user can give that agent.

Two to four parts is usually right. If the task doesn't split well, say so and suggest doing it with one agent.

## Sharing the plan

Save the plan with `hive_write_shared_note` (for example `plans/<short-task-name>.md`) so every agent, in any worktree, can read it with `hive_read_shared_note`. If the Hive tools aren't available, give the plan to the user in your reply.
