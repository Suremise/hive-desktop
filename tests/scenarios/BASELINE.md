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
