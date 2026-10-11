---
name: run-lanes
description: "Run a team as the Hive Assistant: builder and reviewer lanes on card loops, planned by files, briefed and watched to their end. Use when there are three or more agents, builder and reviewer pairs or worktree agents, when asked for lanes, or woken about one."
metadata:
  audience: assistant
---

# Run lanes

A team works through cards in **lanes**: each a builder and a reviewer taking cards in turn in a card loop (card-loop, the agents' skill). coordinate-agents covers the tools; this is how to run a team well. With one or two agents and no reviewers, coordinate-agents is enough.

## Whose job is what

The loop runs itself: the builder builds each card and sends it to Review, the reviewer reviews it, and Hive wakes each when the other acts. The builder handles failed verdicts, merges at the lane's end and moves its cards to Done. You set lanes up, follow them to their end and handle what the loop can't: a question for the user, a card that keeps failing, a lane that stops. Dispatching each step yourself, or writing separate review cards, gets in the loop's way: a review happens on the card, in Review.

## Plan lanes by files

- Split the cards so that agents sharing a folder never edit the same files: group them by the files they touch. A builder working beside others is best in its own worktree (add one only if the user agrees); a reviewer needs none.
- Cards that depend on each other go in the same lane, in order. Name overlaps between lanes in both briefs ("lane 2 also edits the settings view: merge main before each card and keep to your sections").
- A follow-up card belongs to the lane that owns its files: add it to that builder's list (below), or put it in Todo saying which lane should take it.

## Brief completely

Each agent reads only what you send it, and each lane starts in a new conversation (coordinate-agents, A new lane). A builder's brief, to adapt:

```
Use card-loop as the builder. Cards, in order: #12, #15. Your reviewer is R1. Worktree <folder> (branch <branch>).
First, and before each card: merge main, and install dependencies if the lock file changed.
After each card passes: commit on your branch.
Lane end: claim the merge slot, use merge-ready, merge your branch into main, move the cards to Done, report the merge commit on the last card, release the slot, then stop. No push, release or installer.
Follow-ups go to Todo as new cards.
```

Then what this lane needs: test homes or other safety rules, risky areas, overlaps with other lanes, a merge point mid-lane. Write them in now: anything you add later reaches a busy agent only as a message (`hive_message_agent`), at its next turn. A reviewer's brief: `Use card-loop as the reviewer. Cards, in order: #12, #15. Your builder is B1, in <folder>.`, with what to look at closely on risky cards.

- Give rounds and a wait only when the user did; otherwise the lane takes the project's card-loop settings.
- Agents working in the project folder, with no worktree, have nothing to merge: their brief says to commit, and to move a passed card to Done.
- Explain the goal and the handoffs, give a sensible default and leave room for judgement: ask agents to say when they do something else, and why.
- Start the lane yourself with `hive_lane` `start`, so the user sees it at once.

## Watch to the end

Nothing wakes you but the user and a watch you started, so never leave lanes on "they'll tell you".

- **One lane watch covers the whole team.** `hive_wait_for_tasks` with `lanes: ["all"]`, `wake: true`, `limitMinutes: 360`: it follows every running lane, lanes started later and cards added to a lane too, with no card limit, and wakes you only for what needs you: a failed review, a card blocked (a question for the user) or stalled, a lane whose cards have all passed (its merge is due), a lane ended or abandoned. Add `events` (`passed`, `moved`) only to follow more. You have one watch at a time, and a card watch would replace it: put follow-ups in a lane, or check them on each wake.
- **Check the reply says it is waiting** before you end your turn. If it doesn't, start it again once; if it still doesn't, tell the user.
- On each wake: read what changed (`hive_read_task` with `latestComment`), then sweep the board: new follow-ups, stalled cards, a card waiting for the user, an agent idle while its card waits (check it with `hive_agent_activity`; prompt it once it is idle). Then start the lane watch again, and tell the user in a line or two. Once every lane has ended, say so; there is nothing left to watch.
- An agent asking the user something: pass the question on (coordinate-agents, Leave agents alone), and start the lane watch again before you end your turn: the other lanes carry on while the user decides.

## Changing a running lane

- A comment on a card doesn't reach a builder's loop. To add or reorder cards, wait until the builder is idle, prompt it with the new list, and start the lane again with it (`hive_lane` `start`).
- To move a card to another lane, reassign it (`hive_update_task` with `agent`): Hive ends the old pair's watches on it and tells them. Then prompt the new lane's builder once it is idle.

## Verify, don't trust

- Check what agents report against git and the board: the merge commit is in main (`git log`), merged isn't pushed, a Done card's work really is merged. Correct the record on the card when it's wrong.
- When an agent finds a real problem late, lay out the options with your recommendation rather than letting "nearly done" ship a known break.
