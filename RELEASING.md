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

1. **Version.** Set `version` in `package.json` (semver: `0.2.0`, or `0.2.0-beta.1` for a pre-release) and run `npm install` so `package-lock.json` matches.
2. **Release notes.** In `CHANGELOG.md`, turn the **Unreleased** section into `## <version> — <date>`. It is bundled into the app (Docs → Release Notes), and the same text goes in the GitHub release.
3. **Commit** everything. The script refuses to run on a dirty tree. Before building, run the **full e2e set** on that commit with the real tier (`npm run e2e -- --all --real --build --record`, with the real CLIs signed in) and keep its run record: every suite passes, not just the ones the last cards named, and none is skipped for the environment (tests/e2e/README.md). Then **`npm run tested-clis`**: it writes the CLI versions that run used into `resources/tested-clis.json` (what Agent Setup shows as "Tested with", #365), from the record, and says if it couldn't for a CLI (a real suite of it failed, was skipped or didn't run). Commit the manifest; `npm run release` refuses one that isn't from a run on this code (only the manifest may differ since), or lacks a CLI. Between releases the manifest may hold only Codex's entry: the real Claude Code suites run in your own `~/.claude` until #368, so Claude Code's entry is written by this run.
4. **Build and upload:** `npm run release`. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` (titled **Hive <version>**, like the earlier releases) with the three files.
5. **Review the draft** on GitHub: write the release notes (the updater shows them in Hive's update dialog; Markdown works), tick **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag.
6. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

## Notes

- `npm run dist` builds the installer locally and never publishes. It writes `dist/build-info.json` (the code, commit and branch it was built from), only if none of them changed while it built (otherwise it says the build must be made again once the code stays put, and copies nothing). Run in an agent's git worktree, it also copies the installer, its blockmap, `latest.yml` and the build info to the **main checkout's** `dist`, where the user looks for them, and says so; it never replaces an installer of the same name there built from other code (`--replace` does), and `--here` keeps it in the worktree only. Worktrees copying at the same time take turns (a lock in the main `dist`), and a copy is whole or not at all. `npm run release` uploads straight from electron-builder and is unaffected: build a release in the main checkout, at the commit being released.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
