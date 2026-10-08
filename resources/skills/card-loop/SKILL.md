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

Ask if the role or the cards aren't clear.

## Waiting

Wait with `hive_wait_for_tasks`, `wake: true`:
- builder: the card, `changes: ["verdict", "column"]`, `column: "passed"` (a review's verdict, or the card moved into Passed);
- reviewer, a new card: the card, `column: "review"` (only its arrival in Review counts, not the builder's comments; at once if it's already there);
- reviewer, after failing a card: the card, `column: "review"`, `fresh: true` (its next round: it's still in Review now, so this waits for the builder to move it out and back, or to return it for review; without `fresh`, a card already in the column answers at once);
- `limitMinutes`: the run's wait.

**Start the watch before the step that lets the other side act**, so a quick answer isn't missed: the builder just before moving the card to Review, the reviewer just before posting a failed verdict. Your own move doesn't wake you. **Check the watch's reply** before you end your turn:
- "Waiting for #12 → Review…": the watch is live. Finish that step and **end your turn**, saying what you're waiting for.
- "Already: #12 is in Review…": what you'd wait for has happened. Carry on with it now (no watch needed yet).
- An error, or anything else: start the watch again once. If it still says neither, tell the user (`hive_notify`) instead of saying you're watching. Don't poll, don't sleep in a command, and don't start other work: Hive types one line into your session when the card changes ("[Hive] #12 is in Review: Codex failed it; latest comment by …"), or when the wait passes with no change.

When woken, read only what you need: `hive_read_task` with `latestComment: true` (or `comments: n` for the last few). A reviewer whose card is back in Review reads it with `comments: 1` instead: its decisions, listed first, may have changed since the last round. Read the whole card again only when the comment says to, or a reply says the card has a new decision (then check the work against it before your next step). The line names every watched card that changed; when you wait on more than one (cards reviewed together), check each one's column and latest verdict before watching again, not only the one you expected, and watch them all in one watch.

If a wake isn't possible (the tool says so), wait in the call instead: `hive_wait_for_tasks` without `wake`, `timeoutSeconds` up to 840, and pass the reply's `since` to the next call.

**Never end a turn in a loop without a watch**, unless the loop is over or you're asking the user. Woken with nothing to do yet (a reviewer whose card isn't back in Review), start the same watch again.

**Another agent's card** (one your card depends on): its wake names whose card it is ("[Hive] #12 (Claude's card) is in Passed…"). It tells you that card changed, not yours: read it, then carry on with your card, or watch again. **Passed means it passed review, not that it's merged**; Done means merged. When your card needs another one merged, check it is in Done or main has it (e.g. `git merge-base --is-ancestor <its commit> main`), or ask the user, before going on.

**A card that left your watch** ("[Hive] #12 was reassigned to …", "… is reviewed by …" or "… is blocked …", "your watch on it ended"): it isn't yours to wait for any more. Drop it from your list and carry on with your next card, without asking.

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill: Doing first. Just before moving it to Review, start the watch for its verdict (above); then move it to Review with a summary comment and end your turn.
2. Hive wakes you with the verdict.
3. **Passed** (a passing verdict, or moved to Passed): take the next card. Once your work is merged (merge-ready, when the user asks: it says how to merge, taking turns at the merge slot, when other branches merge too), your Passed cards go to Done.
4. **Failed**: if the card has now failed as many reviews as **rounds** (with rounds: 2, its second failed review), that was its last round: don't fix it, stop and ask (below). Otherwise move it to Doing, fix the **blocking** findings, comment on what changed, start the watch again, and move it back to Review: the next round, which wakes the reviewer (a failed card moved to Review without leaving it is returned for review, which wakes it too). Suggestions that aren't blocking can become follow-up cards (`hive_create_task`) rather than another round.

**Checks in a round:** each move to Review carries a run record (work-on-card). After a round's fixes, rerun the checks those fixes affect (the project's notes may have a way to pick them), not every check again; but before a card can pass, the card's full checks must have run on its final code. The reviewer trusts the record and adds its own probes (review-agent-work).

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `review: "start"`, then your verdict as the reviewer.
3. **Blocking findings**: start the watch for its return (above), then `review: "failed"` with them in the comment, numbered, each with what to fix, and end your turn. Points that aren't blocking become follow-up cards, not another round.
4. **Passed**: move it to Passed with the verdict (`review: "passed"`, `column: "passed"`): it passed review and waits to be merged. Done is for merged work, not yours to move. Take the next card.

## Rounds and when to ask

A round is one build and its review: round 1 is the first build and the first review, and each fix with its review is the next round. A card that passes its first review passed in round 1. Count each card's rounds.

- **When the review of round *rounds* fails** (as many failed reviews as **rounds**): stop and ask, don't give up. The reviewer says in that failed verdict that it was the last round; the builder doesn't fix it again but `hive_notify`s the user with a line per round (what was found, and whether it was fixed), asking: carry on (how many more rounds), split the card, accept it with follow-up cards, or take it over.
- **A finding that comes back** (the fix missed part of it): the reviewer says so in the failed verdict ("recurring from round 2") and the loop carries on; the line per round at the limit shows it. A finding the builder **disputes**, rather than missed, is a design question: stop and ask.
- **Stop and ask** on a design question the card doesn't answer, on a blocked card, when the wait passes with no change (Hive wakes you to say so), or when a card of the loop is archived or gone (the wake line says so: only the user brings it back). Stopping and asking is always `hive_notify` to the user, saying what you need decided, and no further verdict or round meanwhile: a comment on the card alone doesn't reach them.

## At the end

Report each card: its rounds, how it ended (Passed, Done once merged, waiting for the user), and any follow-up cards you created.
