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
2. **Release notes.** Update `CHANGELOG.md`. It is bundled into the app (Docs → Release Notes).
3. **Commit** everything. The script refuses to run on a dirty tree.
4. **Build and upload:** `npm run release`. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` with the three files.
5. **Review the draft** on GitHub: write the release notes (the updater shows them in Hive's update dialog; Markdown works), tick **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag.
6. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

## Notes

- `npm run dist` builds the installer locally and never publishes.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
