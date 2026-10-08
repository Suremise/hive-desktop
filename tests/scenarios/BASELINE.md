# Scenario baseline, 3 October 2026

**Fixtures v5** (`scenarios.cjs`), with evidence only of what ran:
- **Hive calls**: the hive MCP server's own log of executed calls. Transcript names count as mentions only.
- **Skill reads**: a successful read showing the skill.
- **Tokens**: the actual values are checked for in tool output and replies.

**Provenance**, recorded in each run's `results.json`:
- the source commit;
- a fingerprint of everything uncommitted (the diff and the contents of untracked files), taken when the run starts and
  checked again at its end;
- the running Hive's guidance and skill revisions before setup;
- what the session itself was given at launch (its guidance and delivered skills).

v3 adds checks that an edited skill was delivered as edited and a deleted one wasn't delivered.

**The latest runs**:
- **Fake Claude Code**: fixtures v5, all 26 pass (`results/2026-10-03T18-21-32-fake`, kept as the baseline
  `baselines/fake-claude.json`); guidance revision `63db94808e669a5e`.
- **Fake Codex**: fixtures v5, all 26 pass (`results/2026-10-03T18-28-52-fake-codex`, baseline
  `baselines/fake-codex.json`). Its board steps and tool calls go through the real hive MCP server, so its benchmark
  measures their replies.
- **Codex** (a model): fixtures v2 (below). No model trial has run under v5 yet; one would be its first benchmark.

v4 added **card-detail** and **oversize-skill**; v5 adds two controlled pairs: **list-compact** / **list-detail** (the same
three cards: 144 characters of compact list against 2,283 of explicit detail with the fake Codex, both correct) and
**skill-unchanged** / **skill-changed** (a skill edited inside the measured window: no misses against a miss and a
change, and the session gets the edited revision). Every run writes `benchmark.json` (README.md, Benchmarks); each sample
keeps its checks, coverage and the revisions its session was given.

**Repeatability** (fakes): v5 runs an hour apart compare as *No change* in every scenario both ran (Performance → Compare's
own rules), for each fake. A run whose source changed while it ran isn't comparable: a run during which only docs were
edited was refused, as it should be, and was run again without touching the tree. The fake Claude Code and the fake Codex
aren't compared with each other (different providers). The two metrics reads per scenario cost 476 ms in a 20-minute fake
Codex run.

Every scenario ran once per provider. Models vary from run to run, so a single result is a sample, not a rate.

## Agent watches: fakes, Codex (`gpt-5.6-luna`), fixtures v19–v20, 8 October 2026

#416 gives `hive_wait_for_agents` a `wake` (an **agent watch**: the Assistant, or an agent, ends its turn and is woken
when an agent finishes, waits for the user or stops), gives the tool to project agents too, and changes coordinate-agents
(an agent watch rather than waiting call after call; a card watch for work on a card) and the Assistant's always-present
line (a watch wakes it too). Fixtures v19 added **assistant-agent-watch** (Coder busy with work that has no card; "tell me
when it's done"): it passes only when the Assistant ends its turn watching (status `watching`), not waiting in the call.
v20 lets assistant-dispatch follow its card with a card watch on that card as well as with `hive_wait_for_agents`.
- **Fakes**, v19, before (main `21c2ff5` with the final fixtures, in a worktree of its own) and after, neither source
  changed while it ran (baselines `b2-416-before-r2b` and `b2-416-after-r2b`): Performance → Compare finds them
  comparable. assistant-agent-watch fails before (main ignores `wake` and holds the call until Coder is done) and passes
  after; every other check is the same. Project agents' tool list grows **+10.3%** (+1,321 bytes a session: the tool is
  new to them); the Assistant's grows +463 bytes (the longer description), its instructions +66 and its skills +352.
  The runs' times went up 2–4 s across the board; three repeats of two scenarios on each side all took 15 s, so that was
  the machine's load.
- **Codex: 2 of 2 pass** under v20 (`2026-10-08T04-23-27-codex`, $0.018): the Assistant read coordinate-agents, watched
  Coder with `wake`, ended its turn watching without polling, and was woken when Coder finished; dispatching a card, it
  followed the card with a card watch. Under v19 (`04-03-07`) assistant-dispatch failed only because its check wanted
  `hive_wait_for_agents` for card work, which the skill now sends to a card watch: v20.
- **Claude Code**: not run (its test home isn't signed in).

## Card decisions: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.1), Claude Code (sonnet), fixtures v18, 7 October 2026

#357 adds a card's **Decisions** and the "new decision" flag on an agent's replies, and changes work-on-card (read decisions
first; read the card again as part of moving it to Review), review-agent-work (a decision the work ignores is blocking),
card-loop (a reviewer back in Review reads the card with `comments: 1`) and coordinate-agents (record the user's decisions
as decisions), plus two tool descriptions (`hive_update_task` `decision`, `hive_read_task` decisions first). Fixtures v16
added **card-decision** and **review-against-decision**, v17 **review-decision-next-round**, v18 loosened card-decision's
model-only file check (it wanted the original `<input name="user">` markup).
- **Fakes**, one source, unchanged while each ran, the before run with only #357's guidance put back (the four skills and
  the two descriptions; baselines `b5-357-before-v18` and `b5-357-after-v18`, results `2026-10-07T13-09-06-fake` and
  `2026-10-07T13-30-28-fake`): the same checks pass both times (154 pass, 40 skipped, 0 fail; the fakes act the decision
  scenarios out by script, so they show Hive's side: the flag in the reply, the board, the costs). The session contract
  and every tool reply are unchanged; the tool list grows **+3.0%** (204,284 → 210,458 bytes over the run); skill text
  read grows +626 bytes in each of the two scenarios that read work-on-card's edited copy.
- **Codex: 3 of 3 pass** (`2026-10-07T13-46-14-codex`, $0.036): the builder read the card again after the decision and
  before Review, the reviewer read the card in full and failed work that ignores the decision, and in round 2 it read the
  card in full before its verdict. (A first try of review-decision-next-round, `12-43-37`, hung for its 6 minutes with no
  tool call after "I'm continuing the card loop…"; it passed when run again, `12-52-39`.)
- **Claude Code (sonnet): 2 of 3 pass** (`2026-10-07T13-44-27-claude-code`, $0.374). Both reviews pass. In card-decision it
  moved the card to Review 6 s after the decision without reading the card again; that reply carried the flag (the card was
  its own when the call began), it read the card at once, changed login.html to match ("Aligned with the new decision")
  and said so, leaving the card in Review rather than moving it back to Doing for the fix. The first trial
  (`12-56-21`, before the flag counted the cards an agent had when a call began) had no flag on that reply and didn't
  notice the decision.

## Long commands get a title: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v11, 6 October 2026

#251 changed the session contract's hive-progress line to `hive-progress --title "<what and why, in a few words>" --
<command>` (and "shows them to the user"); fixtures v11 added the model-only check **gave the run a title for the user**
to progress-long-command and progress-background. #272 measured it cleanly, on one source (`7030a62`, unchanged while
each run ran), the before run with only that line put back as it was:
- **Fakes** (work-on-card and the three progress scenarios; baselines `b6-272-before` and `b6-272-after`, results
  `2026-10-06T13-48-37-fake` and `2026-10-06T13-50-39-fake`): all pass both times, and Performance → Compare finds them
  comparable. The launch guidance grows **+53 bytes** (1,506 → 1,559 characters of the contract; +41 with wrapping off,
  progress-off), so each scenario reads *Larger or worse*; no check passed or ran less often. Everything else is
  unchanged. The fakes skip both "ran through hive-progress" and "gave the run a title": they show the size, not what a
  model does with the line.
- **Codex: 2 of 2 pass** (`results/2026-10-06T13-52-42-codex`, $0.003), one sample each: both ran
  `hive-progress --title "Run full npm test suite" -- npm test` (the background one through `exec_command` with a 1 s
  yield).
- **Claude Code** (sonnet, CLI 2.1.291, its test home): no result. Claude Code answered the prompt with "Login expired ·
  Please run /login" at once (`2026-10-06T13-54-07-claude-code`; the 6 Oct 02:05 and 00:18/00:24 tries, on 2.1.290, were the same),
  and the harness waited out its 6 minutes. The test home needs signing in again, by hand.

## On Hold and Passed: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v10, 6 October 2026

#170 adds the On Hold and Passed columns: the session contract, card-loop, review-agent-work, work-on-card, merge-ready and
coordinate-agents now say a reviewer moves a passing card to Passed, Done means merged and On Hold is the user's. Fixtures
v10 replace **standing-done** with **review-passed** and add **merged-to-done** and **hold-skipped**; **review-interrupted**
no longer offers Done, and **card-loop-two-cards**' passed card is in Passed.
- **Fakes**, before (`card170-before-claude` / `-codex` baselines, results `2026-10-05T23-18-53-fake` and
  `2026-10-05T23-20-02-fake-codex`, v9: 35 of 35 pass) and after (`2026-10-05T23-43-40-fake` and
  `2026-10-06T00-06-02-fake-codex`, v10: 37 of 37 pass). The versions differ, so Performance → Compare only shows them;
  over the 34 scenarios both ran: the session contract +5.5% (about 80 characters a launch), skills +1.0%, the hive tools'
  list +2.1%, tool replies unchanged.
- **Codex: 8 of 8 pass** (`results/2026-10-06T00-07-15-codex`, $0.08): work-on-card, review-card, review-interrupted,
  done-card-more-work, **review-passed** (the reviewer moved it to Passed with its verdict), **merged-to-done**,
  **hold-skipped** (took the Todo card, left the On Hold one alone) and card-loop-two-cards.
- **Claude Code** (CLI 2.1.290, its test home): no result. Two tries (`2026-10-06T00-18-23-claude-code`,
  `2026-10-06T00-24-57-claude-code`) timed out with no reply and no tokens used, the environment rather than the change.

## Card loops: Codex (default `gpt-6.1-sol`, CLI 0.160.0), fixtures v9, 5 October 2026

The card-loop scenarios only (#143: wake lines name a dependency's agent and say Done isn't merged; the skill covers
dependency watches, Done ≠ merged and always re-arming), two samples each, on Codex's default model now that #192
prices it (`results/2026-10-05T05-23-51-codex`, $0.55 API-equivalent):
- **Every behaviour check passes, 8 of 8 samples**: rounds asked the user at the limit, recurring went back for round
  three, recurring-review failed it marking the finding as recurring, disputed asked the user.
- **"read the card-loop skill" fails in 7 of 8, a measuring gap, not the agents**: each sample read it, through a
  code-mode script whose output comes back JSON-escaped, which the harness's `name:` line check misses (#198).
- Fake runs before and after the change (`card143-before-claude`/`-codex` baselines, results `2026-10-05T04-49-10-fake`
  and `2026-10-05T04-57-32-fake-codex`): 33 of 33 pass both times; skill bytes +2.5% (the longer card-loop skill).

## Long commands through hive-progress: Codex (`gpt-5.6-luna`, CLI 0.160.0) and Claude Code (default model, CLI 2.1.289), fixtures v9, 5 October 2026

The new **progress-long-command**, **progress-background** and **progress-off** scenarios and **work-on-card**, two
samples each, after the session contract got its hive-progress line (#167; on by default, off in Settings):
- **Codex: 8 of 8 pass** (`results/2026-10-05T02-19-13-codex`, $0.03): `hive-progress -- npm test` in each "on" run (the
  background one through `exec_command` with a 1 s yield, so it went on in the background); plain `npm test` with the
  setting off.
- **Claude Code: 8 of 8 pass** (`results/2026-10-05T02-24-06-claude-code`, $0.86 API-equivalent): the same, through
  PowerShell (the transcript's command doesn't show whether it was run in the background).

## Card loops: Codex (`gpt-5.6-luna`, CLI 0.160.0) and Claude Code (default model, CLI 2.1.289), fixtures v8, 5 October 2026

The card-loop scenarios only (#173), two samples each, after the skill's rounds became "a round is one build and its
review; at **rounds** failed reviews, ask" and stopping to ask became always `hive_notify`:
- **Codex: 8 of 8 pass** (`results/2026-10-05T01-40-53-codex`, $0.10), **card-loop-rounds** 2 of 2 included.
- **Claude Code: 8 of 8 pass** (`results/2026-10-05T01-49-19-claude-code`, $1.52 API-equivalent).

On the way there (Codex, same four scenarios): with the new count but a prompt saying "it is in round 2", one rounds
sample still read it as "do round 2's fix" (`results/2026-10-05T01-20-09-codex`); and **card-loop-disputed** failed
2 of 2 (`results/2026-10-05T00-58-32-codex`): one reviewer found a real new bug (fixture v7's `sync.js` makes three
attempts while the card said "retry three times", now "try up to three times"), the other stopped but asked in a card
comment instead of `hive_notify`.

## Card loops: Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v7, 4 October 2026

The card-loop scenarios only (#163), two samples each, against the card-loop skill before and after its "a finding that
comes back" rule ($0.17 API-equivalent in all):
- **card-loop-recurring**, **card-loop-recurring-review**, **card-loop-disputed**: 2 of 2 pass after the change
  (`results/2026-10-04T20-51-42-codex`). The two recurring ones also pass 2 of 2 before it
  (`results/2026-10-04T21-05-26-codex`): this model didn't stop early under the old rule either, so these runs show no
  regression rather than the change's effect.
- **card-loop-rounds** fails 2 of 2 both before and after (`results/2026-10-04T21-01-45-codex`): told *rounds: 2* with
  two failed reviews, the builder sends the card round three instead of asking. By the skill's count (each time it goes
  back to Review after failing) the card has had one round, so the scenario and the skill's counting disagree (#173).

The default Codex model (`gpt-6.1-sol`) has no price in `prices.ts`, so a trial with it reports no cost and the budget
stops the run after one trial: use `--model gpt-5.6-luna`, or `--allow-unknown-cost`.

## Codex (`gpt-5.6-luna`, CLI 0.160.0, its test home, Full access)

**20 of 20 pass** under fixtures v2 (`results/2026-10-03T04-44-06-codex`; $0.18 API-equivalent, on a subscription
plan). Its run has guidance revision `63db94808e669a5e`, the same as now, but two pieces of its provenance can't be
recovered:
- Its source fingerprint (`05380a152540`) was taken by the earlier method, which hashed untracked files' names but not
  their contents, so it can't be matched to the current source.
- Its skill revisions were read before setup, so edited-skill and missing-skill don't record what their sessions were
  given.

It wasn't re-run just to refresh them (no paid re-run for a provenance-only change). The next Codex run records both,
and checks v3's delivery checks. That run included:
- **raw-api**: the script ran, listed alpha's card, was refused for beta, and printed no token;
- **assistant-dispatch**: `hive_start_task` worked, then `hive_wait_for_agents`, and the agent finished the card;
- the three new cases: **pick-up-named**, **done-card-more-work** and **progress-log**.

Under fixtures v1, two Codex runs failed and passed when repeated:
- **review-interrupted**: it moved the card to Done after its review ended, before the wording fix below.
- **edited-skill**: it hung for 6 minutes with no tool calls.

## Claude Code: not yet run under fixtures v2

The trials now run Claude Code only in its own test home (`%LOCALAPPDATA%\hive-test\claude`, never the user's
`~/.claude`). That home isn't signed in yet, so `--provider claude-code` prints a skip. Signing in is a one-time step
by hand (README.md).

The earlier Claude runs (fixtures v1, Haiku, CLI 2.1.288; $2.92 over 4 runs) used the user's own Claude home, so its
skills, plugins and settings were part of the run. They also counted hive calls from the transcript. They aren't a
baseline. They're kept below only for what they showed:

- Once Haiku had read a skill, it followed it: work on a card, reviews, fixes, a standing Done instruction,
  prioritising, pick-up, an edited skill, and the Assistant's dispatch and plans.
- Haiku chose skills from their descriptions less reliably:
  - **wrap-up**: re-ran tests it was told had passed.
  - **lasting-decision**: took "remember for every project" as context for the conversation.
  - **plan-only**: used Claude Code's own plan mode.
  - **missing-skill**: skipped Doing in 2 of 3 runs.
- Before the wording fix, it moved an interrupted review's card back to Review and passed it.

## What changed because of the trials

**Guidance**:
- **review-agent-work skill and session contract**: when a card leaves Review during a review, the card is left
  where it is, neither moved back nor on to Done.
- **Board rules**: now separate short lines in the session contract. "Fix or continue" routes to work-on-card.
- **handover skill**: test results the user gives count, so they aren't re-run.
- **split-work description**: also triggers on "how to split work between agents".
- **`hive_start_agent`**: says to use `hive_start_task` for a card.
- **#107**: whether Hive should refuse an agent finishing a card another agent has in Doing (a product decision).

**Harness** (each with unit tests):
- isolated CLI homes;
- the server-side call log;
- strict read evidence;
- token-value checks;
- outcome checks that fail on no-op, failed or out-of-order calls;
- prompts confirmed by the transcript;
- trust questions answered for agents the Assistant starts;
- a fake Codex rollout, so Codex resumes are real.

## Not covered

- **Claude Code under fixtures v2**, until its test home is signed in.
- **Packaged builds.** The trials use the dev build; packaged delivery is covered by `npm run e2e -- packaged-mcp`.
- **The Assistant answering a question an agent asks the user.** A real agent has to reach a question first, which isn't
  deterministic. The tool contract and `coordinate-agents` say never to answer one, and Hive refuses prompts to an agent
  that is waiting.
- **A real npm-installed Codex** (#103 used the fake `.cmd`).
- **Stronger models, and repeat runs for pass rates.** Run with `--model` and `--only` several times when one matters.

## Measured: what each session is given about Hive

From real launches (`node tests/scenarios/measure.cjs`, with the fake CLIs; source `edb813e` with changes
`5baebcf8fd8c`), in UTF-8 bytes; ≈ tokens is bytes / 4 (no tokenizer was run).
- **All 32 combinations** were measured: both providers; the project agent and the Assistant at each control level; a
  short catalog (Hive's own skills) and a long one (40 more of the user's); new and resumed sessions.
- **Every resume was confirmed** from the CLI's own arguments (`--resume <id>`, `codex resume <id>`).
- **Instructions**: for Codex, its developer instructions; for Claude Code, the hive server's instructions plus, for
  the Assistant, its appended prompt.

| Role | Catalog | Instructions | Tools | Skill metadata (skills) | Total | ≈ tokens |
|---|---|---:|---:|---:|---:|---:|
| agent | short | 1,149 | 8,256 | 1,912 (8) | 11,317 | 2,829 |
| agent | long | 1,149 | 8,256 | 7,085 (48) | 16,490 | 4,123 |
| Assistant, Look and advise | short or long | ≈3,250 | 9,769 | 1,197 (5) | ≈14,215 | ≈3,554 |
| Assistant, Control agents | short or long | ≈3,880 | 16,542 | 1,197 (5) | ≈21,620 | ≈5,406 |
| Assistant, Control agents and create projects | short or long | ≈3,950 | 16,804 | 1,197 (5) | ≈21,950 | ≈5,488 |

- **Claude Code and Codex measure the same**, to within 4 bytes (Claude's appended prompt for the Assistant carries
  one more line break).
- **A resumed session measures the same as a new one.**
- **The user's own skills reach project agents only**: the long catalog doesn't change the Assistant's size.
- **The tool schemas are the largest fixed part.**
