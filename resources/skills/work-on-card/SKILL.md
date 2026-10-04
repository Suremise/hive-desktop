---
name: work-on-card
description: "Carry a card from Hive's task board through its work, from Doing to Review with a summary. Use when given a card to work on (\"work on #12\", a card Hive started you on, more work on one back from Review). Not for reviewing one."
metadata:
  audience: agents
---

# Work on a card

The card is the brief, and the board is how the user, the Hive Assistant and other agents see where the work stands. Keep it true.

## Start

1. **Read the card** with `hive_read_task`: its description, comments, links and the cards it depends on. On a long card back for more work, the description and the newest comments (`comments: 5`) usually say what is wanted now; read further back when they refer to earlier ones.
2. **Work or review?** If you are asked to check work rather than do it, this is a review: use the review-agent-work skill and leave the card where it is.
3. **Can it start?** Cards it depends on (`blockedBy`) that aren't done, or a question only the user can answer, block it: set `blocked` with the reason, tell the user, and don't guess.
4. **Move it to `doing`** with `hive_update_task` before you change anything, which gives it to you. Do this also when it comes back from Review or Done.

## While working

- Comment when something is worth knowing later: a decision and why, a finding that changes the plan, a partial result. Not a running log.
- Work you find but weren't asked to do goes on a new card (`hive_create_task`, described well enough to start from cold), not into this one.
- If you can't go on, set `blocked` with the reason; an empty `blocked` clears it.

## Finish

1. **Check the work**: run the project's checks that matter for this change. Note what you ran, the result, and what you didn't run, as a **run record** a reviewer can trust instead of repeating it: the checks, the exact code they ran on (the commit, and whether there were uncommitted changes; the project's notes may give a command that prints a fingerprint), each result, and where the logs are. When the user asks for it (now or as a standing instruction), run long commands as `hive-progress -- <command>`: Hive's Progress panel then shows the user how far along they are.
2. **Move it to `review`** with a comment saying what you did: what changed, how to check it, the checks and their results, and anything left open. Also when it was in Done before.
3. **Done is the user's call.** Move it to `done` only when the user asks you to, now or as a standing instruction.

## Priorities

A column's order is its priority. Asked to prioritise, put the cards in order on the board (`hive_reorder_tasks`, or `hive_update_task` with `position` or `before`) rather than only listing an order.
