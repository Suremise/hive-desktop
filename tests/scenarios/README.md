# Scenarios: do agents use Hive's skills and keep its rules?

Hive tells agents little up front (its session contract) and leaves its workflows to skills they load when needed
(#102). These scenarios check that this works. Given what a user would say, does the agent or the Assistant:

- read the right skill;
- make the right hive tool calls;
- leave the board, notes and files as they should be?

They check what happened, never the wording of a reply.

Each scenario (`scenarios.cjs`) sets up a throwaway workspace: cards, handovers, notes, a second project, or a deleted
or edited skill. It starts the project's agent **Coder** or the **Hive Assistant** through Hive's dev build with the
scenario's prompt, waits for its turn to end (and for any agent the Assistant started), and reads only evidence of what
ran:

- **Hive tool calls** come from the hive MCP server itself. In development builds it logs each call it ran, with
  whether it worked, to the file named by `HIVE_TEST_MCP_LOG`. Tool names in a transcript, or in a Codex script that
  may never have run, are kept apart as *mentions* and are never counted as calls.
- **Skills read**: a Skill call for the skill that didn't fail, or a read (not a write) of its `SKILL.md` whose result
  is that skill's own text (its `name:` line). Writing to the path, echoing it, or a failed read doesn't count.
- **The board, shared notes and files** afterwards, through the Agent API and `git status`.
- **Whether any Agent API token** (the workspace's, an agent's, or the Assistant's) shows up in a tool's output or a
  reply, checked against the actual token values.
- **Usage and cost** (`session:usage`), the CLI's version, and provenance: the running Hive's guidance and skill
  revisions (`/v1/status`), and the source commit with a fingerprint of uncommitted changes.

The checks are positive and negative:
- **Working on a card**: through Doing to Review, never to Done.
- **A card in Done** needing more work goes back through Doing to Review.
- **A reviewer** marks the card and keeps it in Review with its implementer, changes no files, and doesn't finish a
  card that went back to Doing under it.
- **A standing instruction** lets a passed review go to Done.
- **Handovers**: the latest handover's next step, or the named one's, is done, and the other isn't. A wrap-up writes a
  handover without re-running tests.
- **Notes**: a lasting rule goes to a shared note, while progress goes on the card.
- **A plan** starts nothing.
- **A script against the API** runs with the agent's own token, lists its project's card, is refused for another
  project's, and never prints a token.
- **Ordinary coding** reads no Hive skill.
- **Card loops**: at the round limit the builder asks the user. A finding that comes back is another round: the builder
  fixes it without asking, and the reviewer fails it marked as recurring. A finding the builder disputes stops the reviewer
  to ask.
- **With `work-on-card` deleted**, the board rules still hold, and **an edited skill** is the one followed.
- **The Assistant**:
  - at Look and advise, changes nothing;
  - at Control agents, starts a card (which worked), waits for it, and the card gets done;
  - with full control, plans as cards without starting them.

## Running

```bash
npm run scenarios                             # the fake Claude Code: free, deterministic (a failure fails the run)
npm run scenarios -- --provider fake-codex    # the fake Codex: the same, through Hive's Codex adapter
npm run scenarios -- --save-baseline fake-main                                  # keep this run's benchmark as a baseline
npm run scenarios -- --provider codex --repeat 3 --budget 2                     # a model trial, 3 samples a scenario
npm run scenarios -- --provider claude-code --model haiku --budget 2            # model trials: opt-in
npm run scenarios -- --provider codex --model gpt-5.6-luna --budget 2           # Codex, in its test home
npm run scenarios -- --only work-on-card,review-card --keep                     # some scenarios, keeping their folders
node tests/scenarios/measure.cjs              # what sessions are given about Hive, measured from real launches
```

The scenarios run the dev build in `out/`. A run first checks it is built from the source as it is now (the e2e
runner's build stamp, `tests/e2e/build.mjs`) and rebuilds it if not, so a run or a baseline never measures other code.
Hive's test copies run quiet (`src/main/testQuiet.ts`): no window on screen, no focus taken, no notifications.

- **The fakes** (`fake`, the default, and `fake-codex`) act each scenario out with their scripted commands (`skill NAME`, `boardmove`,
  `boardreview`, `boardcomment`). It checks the harness itself and the board rules Hive enforces, at no cost. Checks
  only a model's own work can meet are skipped there (listed as SKIP).
- **Model trials** cost tokens, and run only in the providers' **test homes**: never the user's own `~/.claude` or
  `~/.codex`, and never a copy of their credentials (refreshing a copy could sign the user out).
  - **Claude Code** uses `%LOCALAPPDATA%\hive-test\claude` (`HIVE_TEST_CLAUDE_HOME` overrides it). Sign in to it once, by
    hand, with the account the trials may use:
    ```powershell
    New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\claude" | Out-Null; $env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude
    ```
    Then `/login` in it. It runs in Accept edits, with `mcp__hive`, `Bash`, `PowerShell` and `Skill` allowed on the
    command line, so it never asks and never needs bypass mode.
  - **Codex** uses its test home (`%LOCALAPPDATA%\hive-test\codex`, signed in once as tests/e2e/README.md says), in
    Full access.
  - **Without a sign-in**, a trial prints `SKIP all scenarios: … isn't signed in to its test home` and does nothing. It
    never opens a login.
  - Each scenario is one session of the chosen model, 6 minutes at most. `--budget` (USD, API-equivalent, above 0,
    default 2) stops the run once the scenarios so far cost that much. A trial that reports no cost makes the spend
    unknown, so no further trial starts unless `--allow-unknown-cost` is given; the summary then says the total is
    unknown (the reported subtotal plus the unpriced trials), never $0.
  - Models vary from run to run: a trial reports, it doesn't fail the run.
- **Several runs at once** (from different worktrees, or the same one) don't touch each other: each run claims a
  **lane** from the e2e runner's pool (`tests/e2e/lanes.mjs`), and its scenarios' profiles and workspaces go in
  `%LOCALAPPDATA%\hive-test\scenarios\lanes\<k>\<scenario>-<provider>` (where `--keep` leaves them), with the lane's
  first port as the test Hive's Agent API port. The run prints its lane when it starts. Ten runs at once (scenario and
  e2e runs together) is the most: the eleventh stops and says so.
- **Results** go to `%LOCALAPPDATA%\hive-test\scenarios\results\<time>-<provider>`: `results.json` (each scenario's
  checks, skills read, executed hive calls and mentions, versions, guidance and source, usage) and `summary.md` (a
  table). `BASELINE.md` here records the latest baseline. Run the trials again after changing Hive's guidance, a skill
  or a tool's description, and compare.

Bump `FIXTURES_VERSION` in `scenarios.cjs` when a scenario's setup or checks change.

## Benchmarks: before and after a change

Each run also writes `benchmark.json` (schema `hive-benchmark/1`, `benchmark.cjs`): for every scenario and sample, whether
it passed its checks and what Hive's own parts cost in it. Hive's performance metrics are read before the launch and after
the turn (`GET /v1/metrics` of the run's own workspace), and the difference is the scenario's:
- **Context Hive gave the session**: launch guidance in parts (core, project, role, persona, the skills' catalog), the
  hive tools' list, and every tool reply (characters and UTF-8 bytes, exact; never tokens).
- **Work**: tool calls (detail ones too), calls the hive server ran, repeated identical calls, failures, Agent API
  requests and bytes (the harness's own reads are left out), time.
- **Skills**: delivered skills' bytes (what was available, not what a model read), skills not delivered, and the skill
  service's scans, misses and bytes read.
- **The provider's usage** of the session (a new one, so its total is the scenario's), compared only when every sample on
  both sides reported it. A fake's tokens mean nothing; a cost is compared only when both sides have one.

Compare two runs in Hive: **Performance → Compare → Import…** each `benchmark.json` (in the Performance view, with the
whole workspace selected: a benchmark is its test workspace's, never a project's or the own work's). Each sample keeps
every check (passed, failed, skipped), the measurement's coverage, and the guidance and skill revisions the session was
given. Scenarios are judged **correctness first**, check by check:
- *Smaller, still correct*: less Hive context; every check that passed still passes and still runs; no more calls,
  failures (failed calls, tool errors, API failures, cancellations) or retries.
- *Smaller but failing*: less context but a check passed or ran less often. A cut that breaks a workflow isn't an
  improvement.
- *Larger or worse*, *No change* (within 1%), *Incomplete* (no completed sample, all checks skipped, or not fully
  measured: recording off, measurements dropped, a part missing), and scenarios only one side ran.
- What wasn't measured is **unknown**, never zero: a total exists only when every part it adds up is known.

Two runs are **comparable** only with the same fixtures version, provider, fake or model (and, for a model, the same model,
effort and mode), and neither's source changed while it ran. Otherwise the page says why and the numbers are only shown.
A fake's token usage is simulated and never compared. A stale launch (the session got other
guidance than the run started with) and incomplete samples are left out, and said. With one sample a side there is no
spread to judge a change by: use `--repeat N` for model trials.

- **Fakes** prove routing, delivery, sizes and failure handling: deterministic, free. Their board steps and
  `hive TOOL {json}` go through the real hive MCP server (`tests/e2e/fake-bridge.cjs`), except the fake Claude Code's
  board moves, which call the Agent API directly (its e2e suites read their answers). So the fake Codex's runs measure
  tool replies for board work and the fake Claude Code's don't. Compare like with like.
- **Model trials** are opt-in, cost tokens, and only report (models vary). They record the model, effort, mode, CLI
  version and that they ran in the provider's test home.
- **Controlled pairs** (fixtures v5): **list-compact** and **list-detail** ask for the same three cards, the compact list
  against the explicit detail form, with the same required correctness (every card listed; detail also has each
  acceptance line), so their reply sizes compare. **skill-unchanged** and **skill-changed** do the same work, the second
  with a skill edited inside the measured window (`beforeLaunch`, after the first metrics read): the skill service's
  hits, misses and changes show the cache's work, and the session must get the edited revision.
- **Baselines**: `--save-baseline NAME` copies the run's `benchmark.json` to `scenarios/baselines/NAME.json`: the new
  one is read first and swapped in atomically, and an existing baseline of that name is archived as
  `NAME.<its time>.json` (`-2`, `-3`… if that name is taken), never overwritten; the 5 newest archives are kept. Each run
  gets a results folder of its own; the newest 30 are kept. Nothing is invented for a run that wasn't recorded.
- `tests/fixtures/benchmarks` holds a baseline from a real fake run, an intentional reduction of it and the same
  reduction that broke `card-detail`. `tests/benchmark.test.ts` checks that the first is "smaller, still correct" and the
  second "smaller but failing".
- **Overhead**: the two metrics reads cost a few milliseconds a scenario (`metricsOverheadMs` in the artifact); the
  collector's own cost is in docs/ARCHITECTURE.md.
