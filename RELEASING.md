# Releasing Hive

Hive updates itself from this repository's [GitHub Releases](https://github.com/Suremise/hive-desktop/releases) using [electron-updater](https://www.electron.build/auto-update). A release is only seen by installed copies once it is **published** (not a draft) and the repository is **public**: the updater reads releases without credentials, and Hive never ships a token.

## What a release contains

`npm run release` uploads three files to a draft release tagged `v<version>`:

| File | Purpose |
|---|---|
| `Hive-Setup-<version>.exe` | The NSIS installer, for new installs and updates |
| `latest.yml` | What the updater reads: version, file name, size, SHA-512 and release date |
| `Hive-Setup-<version>.exe.blockmap` | Lets the next update download only the blocks that changed |

The updater checks the downloaded installer against the SHA-512 in `latest.yml` before installing it. The installer is not code-signed yet, so the first install from a browser shows a SmartScreen warning; in-app updates don't.

## Steps

1. **Release candidate first.** Before any version change, build an installer at the **current** version from `main` (`npm run dist`, in the main checkout, at the commit to release) and have the user install and test it. Fixes found now go in before the bump; the bump is step 3.
2. **Push and let CI pass before the bump.** Push the release-candidate commit (the user pushes) and wait for `.github/workflows/ci.yml` to pass on it. The 0.4.0 push found a failure no local run could: #389, 8.3 short paths on GitHub's runner. CI on the pushed commit is the check that counts.
3. **Version and release notes.** Set `version` in `package.json` (semver: `0.2.0`, or `0.2.0-beta.1` for a pre-release) and run `npm install` so `package-lock.json` matches. In `CHANGELOG.md`, turn the **Unreleased** section into `## <version> — <date>`: it is bundled into the app (Docs → Release Notes), and the same text goes in the GitHub release. Commit everything; the script refuses to run on a dirty tree.
4. **The real tier on that commit.** The full fake set must pass on this code first (`npm run e2e -- --all --build --record`). Then the real tier, with the CLIs signed in (the release-hive skill checks that first): `npm run e2e -- --all --real --build --record`. When the fake set already passed on this same code, `npm run e2e -- --all --only-real --build --record` is enough for the manifest (the 0.4.0 manifest came from a 13-of-13 real run). Keep the record. Every real suite must pass: a suite that failed or was skipped for the environment (a sign-in, a usage limit, the network) is rerun on this exact code, with a stable CLI version and its sign-in in place, before step 5. A reviewer's acceptance of a skip doesn't stand in for that: `npm run tested-clis` requires every real suite of each CLI to have run and passed.
5. **The tested-with manifest.** Run `npm run tested-clis` on that record and commit `resources/tested-clis.json` (what Agent Setup shows as "Tested with", #365). It writes each CLI's version from the record, and exits 1 if a CLI's real suites ran different versions or the record doesn't say which. A CLI can update itself during the run (Codex went from 0.160.1 to 0.161.0 during 0.4.0's): then rerun the real tier on one stable version. A new real-tier failure after a CLI update may be a real change in behaviour (#396), not noise. `npm run release` refuses a manifest that isn't from a run on this code, so only the manifest may differ since the run. Each CLI's entry comes from this run's real suites, which run in the test homes (`%LOCALAPPDATA%\hive-test\claude` and `…\codex`), not in your own `~/.claude` or `~/.codex`; the sign-ins are in the release-hive skill and tests/e2e/README.md.
6. **Build and upload:** `npm run release`. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` (titled **Hive <version>**, like the earlier releases) with the three files. It doesn't rewrite `dist/build-info.json`.
7. **Review the draft** on GitHub. Write the release notes (the updater shows them in Hive's update dialog; Markdown works). When the changelog is long, put a short summary at the top for that dialog. Tick **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag.
8. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

## Notes

- `npm run dist` builds the installer locally and never publishes. It writes `dist/build-info.json` (the code, commit and branch it was built from), only if none of them changed while it built (otherwise it says the build must be made again once the code stays put, and copies nothing). Run in an agent's git worktree, it also copies the installer, its blockmap, `latest.yml` and the build info to the **main checkout's** `dist`, where the user looks for them, and says so; it never replaces an installer of the same name there built from other code (`--replace` does), and `--here` keeps it in the worktree only. Worktrees copying at the same time take turns (a lock in the main `dist`), and a copy is whole or not at all. `npm run release` uploads straight from electron-builder and is unaffected: build a release in the main checkout, at the commit being released.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
