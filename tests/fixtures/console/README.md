# Developer console fixtures

What a coding agent's CLI sent Hive, and what Hive made of it, recorded by the developer console (#366, #638). The
contract suites (`tests/e2e/contract-<provider>.cjs`, the real tier) compare what the installed CLI sends now with
these, so a CLI update that renames a hook's field or changes what Hive reads from it is caught before a release. Unit
tests of the adapters can read them too (#367's CLI-facing defaults are tested against them).

| Fixture | CLI | Recorded by |
|---|---|---|
| `copilot.json` | GitHub Copilot CLI, offline against the scripted stand-in model | `contract-copilot`: a launch, `view a.ts then say Done.`, a stop |

## Making one from a recording

1. Turn on **Settings → Advanced → Show developer features** in a test copy of Hive (never with your own work in it),
   open **Help → Developer Console**, pick the agent, and click **Record** *without* ticking text.
2. Do the steps the contract suite does (its header says which), then **Stop recording**. The bar says the file's name;
   **Show in folder** opens `console-recordings` in Hive's profile folder.
3. Convert it:

   ```bash
   npm run console-fixture -- <the recording.jsonl> tests/fixtures/console/<provider>.json
   ```

   The script keeps the CLI's events (hooks, status lines, transcript reads, terminal markers, launch and exit) and
   Hive's reading of each, in order, without times or sequence numbers; every absolute path becomes `<path>`. It refuses
   a recording with prompt and reply text, and a result that still names this machine's user.
4. Read the result before committing it: ids such as a session's are kept (they're random), text is `<text: N chars>`.

The contract suite writes this run's events the same way (`contract-<provider>-live.json`, kept with `--keep-files`), so
a deliberate change can be accepted by recording again as above, or by copying the live file once you've read what
changed.

## What the contract checks

`compareContract` in `src/shared/consoleFixtures.mts`, per event (its kind and name):

- **A change** (the suite fails): a hook, status line, launch, exit or terminal marker that no longer arrives (for a
  marker: Hive no longer recognises the CLI's screen); a field of a hook, status line, launch or exit that is gone or of
  another type (a field gone beside a new one of the same type is named as a likely rename); a reading in the fixture
  that Hive no longer makes: a hook's event kind, status and actions, a marker's, launch's or exit's status, mode and
  flags (`readingOf`; text and what varies between runs are left out).
- **New** (flagged in the log, `FLAG …`, the suite passes): an event, a field or a reading that isn't in the fixture.
- Transcript reads hold whichever records were newest at that moment, so only their arrival as something new is flagged.

The run is scripted, so what arrives is the same each time: a contract that fails on a run that changed nothing is a
bug in the suite (a step that depends on timing), not something to record again.
