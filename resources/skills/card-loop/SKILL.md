---
name: card-loop
description: "Work through cards in turn as their builder or reviewer, waiting at no cost. Use when told to work through or review several cards in order."
metadata:
  audience: agents
---

# Card loop

Two agents take the same cards in turn: the **builder** does each card and sends it to Review; the **reviewer** reviews it and passes it back with findings, or passes it. This skill is one side of that loop. Waiting for the other side costs nothing: you end your turn and Hive wakes you.

## Inputs

From the user's request:
- **role**: `builder` or `reviewer`;
- **cards**: the numbers, in the order given (one at a time, never ahead);
- **rounds**: the most review rounds a card gets before you ask the user (default 5; "rounds: 10");
- **wait**: how long with no change before you tell the user (default 2 hours; "wait: 4h");
- reviewer only: whether you may move a passed card to **Done**. Only if the user said so; otherwise a passed card stays in Review, with your verdict, for the user.

Ask if the role or the cards aren't clear.

## Waiting

Wait with `hive_wait_for_tasks`, `wake: true`:
- builder: the card, `changes: ["verdict", "column"]`, `column: "done"` (a review's verdict, or the card moved into Done);
- reviewer, a new card: the card, `column: "review"` (only its arrival in Review counts, not the builder's comments; at once if it's already there);
- reviewer, after failing a card: the card, `column: "review"`, `changes: ["column"]` (it comes back to Review: it's still there now, so this waits for the builder to move it out and back);
- `limitMinutes`: the run's wait.

**Start the watch before the step that lets the other side act**, so a quick answer isn't missed: the builder just before moving the card to Review, the reviewer just before posting a failed verdict. Your own move doesn't wake you. Then finish that step and **end your turn**, saying what you're waiting for. Don't poll, don't sleep in a command, and don't start other work: Hive types one line into your session when the card changes ("[Hive] #12 is in Review; latest comment by …"), or when the wait passes with no change.

When woken, read only what you need: `hive_read_task` with `latestComment: true` (or `comments: n` for the last few). Read the whole card again only when the comment says to.

If a wake isn't possible (the tool says so), wait in the call instead: `hive_wait_for_tasks` without `wake`, `timeoutSeconds` up to 840, and pass the reply's `since` to the next call.

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill: Doing first. Just before moving it to Review, start the watch for its verdict (above); then move it to Review with a summary comment and end your turn.
2. Hive wakes you with the verdict.
3. **Passed** (a passing verdict, or moved to Done): take the next card.
4. **Failed**: fix the **blocking** findings, comment on what changed, start the watch again, and move it to Review. That is one round. Suggestions that aren't blocking can become follow-up cards (`hive_create_task`) rather than another round.

**Checks in a round:** each move to Review carries a run record (work-on-card). After a round's fixes, rerun the checks those fixes affect (the project's notes may have a way to pick them), not every check again; but before a card can pass, the card's full checks must have run on its final code. The reviewer trusts the record and adds its own probes (review-agent-work).

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `review: "start"`, then your verdict as the reviewer.
3. **Blocking findings**: start the watch for its return (above), then `review: "failed"` with them in the comment, numbered, each with what to fix, and end your turn. Points that aren't blocking become follow-up cards, not another round.
4. **Passed**: move it to Done if the user allowed that, otherwise leave it in Review saying it passed. Take the next card.

## Rounds and when to ask

Count the review rounds of each card (each time it goes back to Review after failing).

- At **rounds**: stop and ask, don't give up. `hive_notify` the user with a line per round (what was found, and whether it was fixed), and ask: carry on (how many more rounds), split the card, accept it with follow-up cards, or take it over.
- **Ask early when a finding comes back**: a review raising again what the builder already fixed, even in round 2.
- **Stop and ask** on a design question the card doesn't answer, on a blocked card, or when the wait passes with no change (Hive wakes you to say so: tell the user with `hive_notify`).

## At the end

Report each card: its rounds, how it ended (passed, Done, waiting for the user), and any follow-up cards you created.
