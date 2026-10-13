# CLI samples for the advanced settings' detection defaults (#367)

What the CLIs really show, for the unit tests (`tests/advanced*.test.ts`) that check Hive's default detection patterns (Settings → Advanced) against them. Each `.txt` is the visible terminal screen, 120 × 40, rendered by `@xterm/headless` from the CLI's output in a pty (rows joined by `\n`, trailing spaces trimmed); folder paths shown on screen are replaced with `C:\work\alpha`.

| File | CLI and version | What it shows |
|---|---|---|
| `trust-claude-2.1.296.txt` | Claude Code 2.1.296 | The folder trust question (`Yes, I trust this folder`) |
| `trust-codex-0.162.1.txt` | Codex 0.162.1 | The folder trust question (`Trust this folder? …`) |
| `trust-copilot-1.0.95.txt` | GitHub Copilot CLI 1.0.95 | The folder trust question (`Do you trust the files in this folder?`) |
| `ready-copilot-1.0.95.txt` | GitHub Copilot CLI 1.0.95 | At its prompt after answering Yes, with the footer (`· / commands ·`) |
| `signin-error-copilot-1.0.95.txt` | GitHub Copilot CLI 1.0.95 | After one prompt (`say hi`) when the model API answers 401 |
| `signin-error-copilot-1.0.95.jsonl` | GitHub Copilot CLI 1.0.95 | The `session.error` record that turn wrote to `session-state/*/events.jsonl` |
| `statusline-claude-2.1.296.json` | Claude Code 2.1.296 | One status line command's input, with the plan limits (`rate_limits.five_hour`, `rate_limits.seven_day`) |
| `safeguards-claude-2.1.296.jsonl` | Claude Code 2.1.296 | Its transcript entries for a safeguard stop (#606): the system note and the notice for the model, as HB3's session wrote them on 11 Oct (content cut down) |
| `safeguard-prompt-claude-2.1.296.txt` | Claude Code 2.1.296 | Its question after a safeguard stop ("Model switch", with the choices `1. Switch automatically` and `2. Stay on Opus 5.5`), as HB3's screen showed it (#606) |
| `mcp-list-codex-0.162.1.json` | Codex 0.162.1 | `codex -c 'mcp_servers.hive={command="node",args=["x.js"],tool_timeout_sec=900}' mcp list --json` in the Codex test home: Codex reads Hive's timeout for the hive tools (only the hive entry kept) |
| `footer-claude-2.1.296-<mode>.txt` | Claude Code 2.1.296 | At its prompt in each mode Hive had no screen of (#696): `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` (`⏸ plan mode on (shift+tab to cycle)`); manual and auto are on `screen-claude-2.1.296-idle.txt` and `-hive-idle.txt` |
| `footer-copilot-1.0.95-<mode>.txt` | GitHub Copilot CLI 1.0.95 | At its prompt in each mode Hive had no screen of (#696): `plan`, `autopilot`, `allow-all` (`· Plan · Manual Approval ·`); Ask is on `ready-copilot-1.0.95.txt` |

How they were recorded (12 Oct 2026), each in a new empty folder, with an environment built from an allowlist (no inherited variables). The screens used no sign-in and sent nothing to a real model; the status line is the one exception, below.

- Claude Code: its own `CLAUDE_CONFIG_DIR` set up as `ownClaudeHome()` in `tests/e2e/lib.cjs` does (onboarding done, a made-up API key approved); ended at the question, unanswered. The footers (13 Oct, #696): the same, started with `--permission-mode <mode>`, the trust question (and Bypass permissions' warning) answered Yes, ended at its prompt; the screens show a 401 from loading remote managed settings with the made-up key.
- Codex: the Codex test home (`CODEX_HOME`, `lib.cjs`), in a new `git init` folder it didn't trust (Codex asks only in a Git repository); ended at the question, unanswered, so its `config.toml` was not changed.
- Copilot: offline (`COPILOT_OFFLINE=true`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL=gpt-4.1`) against the stand-in model API (`tests/e2e/fake-copilot-api.cjs`), with `copilotTestEnv()`'s own home, profile and empty `GH_CONFIG_DIR`, `gh` off PATH. The footers (13 Oct, #696): the same, started with `--plan`, `--autopilot` or `--allow-all`, the trust question answered Yes, ended at its prompt. The sign-in error used a stand-in of the probe's own that answers every request with 401 and a JSON error body; Copilot reports it as `errorType: "authentication"` (`statusCode: 401`).
- Claude Code status line: the signed-in Claude Code test home (`CLAUDE_TEST_HOME`, `lib.cjs`; no API key), `claude --model haiku --settings <file>` whose `statusLine` command dumped its input, one prompt (`say ok`), then `/exit`. Paths are replaced with `C:\work\alpha` (and `C:\work\transcript.jsonl`, `C:\work\scratchpad`), the session and prompt ids with `00000000-0000-4000-8000-00000000000n`.
- Safeguard stops (#685), the exceptions to the date and the folders: Claude Code's entries and question are #606's, recorded from HB3's real session on 11 Oct (they were in `tests/safeguards.test.ts`, which now reads the question from here). Claude Code's records of a flagged request and Codex's safeguard events have no real recording yet (#697): a name in a CLI's binary isn't one.

Record them again when a CLI's screen changes, named with the new version, and point the tests at them.

Values Hive gives a CLI (hook timeouts, Codex's title items and tool timeout) are checked against recordings of the CLI taking them: the hooks arriving (`tests/fixtures/turns-*.json`, `tests/fixtures/console/copilot.json`), Codex's title spinner (`tests/fixtures/codex-startup-0.160.0.json`) and the list above.
