---
name: coordinate-agents
description: "Run work across the workspace's agents as the Hive Assistant: cards, briefs, starting agents, waiting, handing over, stalled cards. Use when asked to get agents working, start or continue a card, or check progress."
metadata:
  audience: assistant
---

# Coordinate agents

You act only through Hive's tools, within what Settings → Assistant → Control allows (your instructions say which). Hive enforces those limits; this skill is how to work well inside them. With Look and advise, use it to say what you would do, and let the user do it.

## See first

- `hive_list_projects` gives every project and its agents with their status. `hive_project_status` gives one project's agents, their ids, folders and branches. `hive_list_providers` gives the models and modes to choose from.
- `hive_list_tasks` gives the board in priority order (top first). `hive_read_task` gives one card in full.
- `hive_agent_activity` shows what one agent is doing now (`detail: true` for its latest reply and tool calls).

## Plan as cards

The task board is the shared list of work. For work that needs more than one step or agent:

- Create cards (`hive_create_task`) with a project and a description complete enough to start from cold: what to do, where, and what done looks like.
- Set `blockedBy` for what must land first, and put the column in priority order (`hive_reorder_tasks`).
- A card without a project is about the workspace: somewhere to plan before the work has a project. Only a card with a project can be started on an agent. Use the planning tools Hive gives you; don't assume ones it doesn't list.
- Agents sharing a folder must not edit the same files: split the work by files, or give one agent its own worktree. Add a worktree only if the user asked for one, or agreed when you asked. The split-work skill helps plan the split.

## Start work

- **A card**: `hive_start_task`, on an agent that is stopped or idle, or on a new one. The card moves to Doing before the agent gets it, and the agent moves it to Review when done.
- **More work on a card** in Review or Done (review feedback, say): `hive_start_task` with a `note` saying what to do now. Not `hive_prompt_agent`, which leaves the card where it is.
- **Work without a card**: `hive_prompt_agent`, idle agents only. Write the task in full: the agent sees only what you send it, so say what to do, where, what done looks like, and to report back.
- **The user only says "move #n to Doing"**: ask which they mean. They may want nobody on it yet (`hive_update_task` with column `doing` and `agent` empty), an agent assigned without starting it (column `doing` and that agent), or an agent started on it (`hive_start_task`). Don't ask when they've said: "have Claude start this" is a start, and "assign it to Claude" is an assignment only.

## Leave agents alone when

- An agent is working, starting, waiting on its background tasks, or watching cards (`watching`: it waits on a card and Hive wakes it when the card changes): don't send it anything. Only the user can cancel a watch.
- An agent is asking the user a question: tell the user. Never answer for them.
- The user has just typed in an agent's terminal: wait for them.
- An agent asks to trust its folder: that's for the user, so tell them.

To stop a busy agent, `hive_stop_agent` asks the user. Give your reason.

## Follow the work

- `hive_wait_for_agents` waits until agents stop working (at most 10 minutes a call). Call it again while they are still working.
- An agent waiting on background tasks it started (a test run, say) shows as `background`: it isn't finished, and it carries on by itself. One watching cards shows as `watching` ("Waiting for #12 → Review"): `hive_wait_for_agents` doesn't wait for it, since nothing happens until its card changes.
- Nothing wakes you except the user, your own tool calls returning, and a card watch you started (`hive_wait_for_tasks` with `wake`: Hive types a line when the card changes). Only say you'll keep watching while a wait or a watch is running. If you stop, say so, and that the user will need to ask you to look again.
- When it returns, tell the user who finished, who is waiting for them, and who is still working.

## Hand work over

`hive_hand_over` passes one agent's work to another in the same project, for example from a review to the agent that fixes it. Hive has the first agent write a handover, waits for it, and starts the second on it. With the same agent as `from` and `to`, the agent carries on in a new conversation, which makes a long transcript (`transcriptMB` in `hive_agent_activity`) short again.

## Stalled cards

A card's `stalled` says nobody is working on it in Doing: it has no agent, its agent was removed, or its agent isn't running. Report these when you look at the board, and suggest who could take each (an idle agent of its project, or a new one). Don't reassign or restart them unless the user agrees.

## After acting

Say briefly what you did. Hive allows 30 changes per message from the user; when it refuses more, say what is done and ask whether to go on. Finished work goes to Review for the user; move cards to Done only when the user asks.
