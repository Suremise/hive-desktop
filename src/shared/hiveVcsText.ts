// What a project's .hive version control notice says (#345): shared by the window and its tests.
import type { HiveVcs } from './types'

/** The user guide's heading on what .hive holds and how it is kept out of version control. */
export const HIVE_FOLDER_GUIDE = 'What Hive keeps in a project'

/** One situation, so a notice dismissed for it shows again when the situation changes. */
export const hiveVcsKey = (v: HiveVcs): string => `${v.state}|${v.vcs ?? ''}|${v.sync ?? ''}${v.tracked ? '|tracked' : ''}`

/** What the notice says about a project's .hive (#345), or null when version control already keeps it out and nothing syncs it. */
export function hiveVcsText(v: HiveVcs | undefined): { title: string; detail: string; canExclude: boolean; canUntrack?: boolean } | null {
  if (!v || (v.state === 'excluded' && !v.sync && !v.tracked)) return null
  // Committed before it was excluded (#364): excluding keeps new files out, but git goes on committing these.
  if (v.tracked) {
    const n = v.tracked === 1 ? '1 file' : `${v.tracked} files`
    const exclude = v.state === 'excluded' ? '' : " Hive couldn't exclude .hive either: a rule in a .gitignore may bring it back."
    return {
      title: `${n} in .hive ${v.tracked === 1 ? 'is' : 'are'} committed to git`,
      detail: `Excluding .hive keeps new files out of git, but ${v.tracked === 1 ? 'this one was' : 'these were'} committed before, so git still tracks ${v.tracked === 1 ? 'it' : 'them'} and commits ${v.tracked === 1 ? 'its' : 'their'} changes. Run \`git rm -r --cached .hive\` in the project folder, then commit: the files stay on disk.${exclude}`,
      canExclude: v.state === 'not-excluded',
      canUntrack: true
    }
  }
  const why = "It holds this computer's sessions, transcript backups and launch settings, which don't belong in commits or shared copies."
  const synced = v.sync ? `${v.sync} copies the project folder, .hive included: exclude .hive in ${v.sync} if it lets you, or keep the project in a folder it doesn't sync.` : ''
  if (v.state === 'excluded') return { title: `.hive is synced by ${v.sync}`, detail: `Git ignores this project's .hive, but ${synced} ${why}`, canExclude: false }
  const sync = synced ? ` ${synced}` : ''
  const title = ".hive isn't excluded from version control"
  if (v.state === 'not-excluded') return { title, detail: `Hive adds it to the git repository's .git/info/exclude, but git doesn't ignore it: Hive couldn't write that file, or a .gitignore rule brings .hive back. ${why}${sync}`, canExclude: true }
  if (v.state === 'other-vcs') return { title, detail: `This project is in a ${v.vcs} working copy, which Hive doesn't set up: add .hive to its ignore list. ${why}${sync}`, canExclude: false }
  return { title, detail: `No git repository holds this project; if you make one, Hive excludes .hive there by itself. With another version control system, add .hive to its ignore list. ${why}${sync}`, canExclude: false }
}

