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
- **rounds**: how many rounds a card gets before you ask the user (default 5; "rounds: 10"). A round is one build and its review (below);
- **wait**: how long with no change before you tell the user (default 2 hours; "wait: 4h");
- reviewer only: whether you may move a passed card to **Done**. Only if the user said so; otherwise a passed card stays in Review, with your verdict, for the user.

Ask if the role or the cards aren't clear.

## Waiting

Wait with `hive_wait_for_tasks`, `wake: true`:
- builder: the card, `changes: ["verdict", "column"]`, `column: "done"` (a review's verdict, or the card moved into Done);
- reviewer, a new card: the card, `column: "review"` (only its arrival in Review counts, not the builder's comments; at once if it's already there);
- reviewer, after failing a card: the card, `column: "review"`, `changes: ["column"]` (it comes back to Review: it's still there now, so this waits for the builder to move it out and back, or to return it for review);
- `limitMinutes`: the run's wait.

**Start the watch before the step that lets the other side act**, so a quick answer isn't missed: the builder just before moving the card to Review, the reviewer just before posting a failed verdict. Your own move doesn't wake you. Then finish that step and **end your turn**, saying what you're waiting for. Don't poll, don't sleep in a command, and don't start other work: Hive types one line into your session when the card changes ("[Hive] #12 is in Review: Codex failed it; latest comment by …"), or when the wait passes with no change.

When woken, read only what you need: `hive_read_task` with `latestComment: true` (or `comments: n` for the last few). Read the whole card again only when the comment says to.

If a wake isn't possible (the tool says so), wait in the call instead: `hive_wait_for_tasks` without `wake`, `timeoutSeconds` up to 840, and pass the reply's `since` to the next call.

**Never end a turn in a loop without a watch**, unless the loop is over or you're asking the user. Woken with nothing to do yet (a reviewer whose card isn't back in Review), start the same watch again.

**Another agent's card** (one your card depends on): its wake names whose card it is ("[Hive] #12 (Claude's card) is in Done…"). It tells you that card changed, not yours: read it, then carry on with your card, or watch again. **Done means it passed review, not that it's merged**: it's merged when the user says so, or main has it. When your card needs another one merged, check main has it (e.g. `git merge-base --is-ancestor <its commit> main`) or ask the user before going on.

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill: Doing first. Just before moving it to Review, start the watch for its verdict (above); then move it to Review with a summary comment and end your turn.
2. Hive wakes you with the verdict.
3. **Passed** (a passing verdict, or moved to Done): take the next card.
4. **Failed**: if the card has now failed as many reviews as **rounds** (with rounds: 2, its second failed review), that was its last round: don't fix it, stop and ask (below). Otherwise move it to Doing, fix the **blocking** findings, comment on what changed, start the watch again, and move it back to Review: the next round, which wakes the reviewer (a failed card moved to Review without leaving it is returned for review, which wakes it too). Suggestions that aren't blocking can become follow-up cards (`hive_create_task`) rather than another round.

**Checks in a round:** each move to Review carries a run record (work-on-card). After a round's fixes, rerun the checks those fixes affect (the project's notes may have a way to pick them), not every check again; but before a card can pass, the card's full checks must have run on its final code. The reviewer trusts the record and adds its own probes (review-agent-work).

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `review: "start"`, then your verdict as the reviewer.
3. **Blocking findings**: start the watch for its return (above), then `review: "failed"` with them in the comment, numbered, each with what to fix, and end your turn. Points that aren't blocking become follow-up cards, not another round.
4. **Passed**: move it to Done if the user allowed that, otherwise leave it in Review saying it passed. Take the next card.

## Rounds and when to ask

A round is one build and its review: round 1 is the first build and the first review, and each fix with its review is the next round. A card that passes its first review passed in round 1. Count each card's rounds.

- **When the review of round *rounds* fails** (as many failed reviews as **rounds**): stop and ask, don't give up. The reviewer says in that failed verdict that it was the last round; the builder doesn't fix it again but `hive_notify`s the user with a line per round (what was found, and whether it was fixed), asking: carry on (how many more rounds), split the card, accept it with follow-up cards, or take it over.
- **A finding that comes back** (the fix missed part of it): the reviewer says so in the failed verdict ("recurring from round 2") and the loop carries on; the line per round at the limit shows it. A finding the builder **disputes**, rather than missed, is a design question: stop and ask.
- **Stop and ask** on a design question the card doesn't answer, on a blocked card, or when the wait passes with no change (Hive wakes you to say so). Stopping and asking is always `hive_notify` to the user, saying what you need decided, and no further verdict or round meanwhile: a comment on the card alone doesn't reach them.

## At the end

Report each card: its rounds, how it ended (passed, Done, waiting for the user), and any follow-up cards you created.
