import { useState } from 'react'
import { HIVE_FOLDER_GUIDE, hiveVcsKey, hiveVcsText } from '@shared/hiveVcsText'
import type { ProjectInfo } from '@shared/types'
import { call, errorMessage } from '../api'
import { rememberProjectPref } from '../projectPrefs'
import { confirm, notify, set, useStore } from '../store'
import { openGuideAt } from '../tips'
import { BusyButton, Icon, IconButton } from './ui'

/**
 * Says when a project's .hive isn't kept out of version control or is in a sync service's folder (#345). In the
 * Overview it can be dismissed for the situation it describes; Project Settings always shows it.
 */
export function HiveVcsNotice({ project, dismissible = false }: { project: ProjectInfo; dismissible?: boolean }) {
  const key = project.path.toLowerCase()
  const dismissed = useStore((s) => s.hiveVcsNotice[key])
  const [busy, setBusy] = useState(false)
  const v = project.hiveVcs
  const text = hiveVcsText(v)
  if (!v || !text || (dismissible && dismissed === hiveVcsKey(v))) return null
  const exclude = async (): Promise<void> => {
    setBusy(true)
    try {
      set({ workspace: await call('project:excludeHive', project.path) })
      notify('success', `${project.name}: .hive excluded from git`)
    } catch (e) {
      notify('error', "Couldn't exclude .hive", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  // Committed before it was excluded (#364): the user's index changes only after a confirmation listing the files.
  const untrack = async (): Promise<void> => {
    setBusy(true)
    try {
      const files = await call('project:hiveTracked', project.path)
      if (!files.length) {
        set({ workspace: await call('workspace:refresh') })
        return
      }
      const ok = await confirm({
        title: `Untrack ${files.length === 1 ? 'this file' : `these ${files.length} files`}?`,
        message: `Hive runs git rm --cached on ${files.length === 1 ? 'it' : 'them'} in ${project.name}, and nothing else: git stops tracking ${files.length === 1 ? 'it' : 'them'} and stages ${files.length === 1 ? 'its' : 'their'} removal from the repository. ${files.length === 1 ? 'The file stays' : 'The files stay'} on disk. Commit afterwards to finish.`,
        list: files.length > 50 ? [...files.slice(0, 50), `… and ${files.length - 50} more`] : files,
        confirmLabel: 'Untrack',
        busyLabel: 'Untracking…',
        run: async () => set({ workspace: await call('project:untrackHive', project.path, files) })
      })
      if (ok) notify('success', `${project.name}: .hive untracked`, 'Commit the change to finish (git commit). The files are still on disk.')
    } catch (e) {
      notify('error', "Couldn't untrack .hive", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner warn hive-vcs-notice">
      <Icon name="warning" />
      <span>
        <strong>{text.title}.</strong> {text.detail}
      </span>
      {text.canUntrack && (
        <BusyButton className="btn small primary" busy={busy} busyLabel="Checking…" onClick={() => void untrack()}>
          Untrack…
        </BusyButton>
      )}
      {text.canExclude && (
        <BusyButton className="btn small primary" busy={busy} busyLabel="Excluding…" onClick={() => void exclude()}>
          Exclude
        </BusyButton>
      )}
      <button className="btn small subtle" onClick={() => openGuideAt(HIVE_FOLDER_GUIDE)}>
        Learn more
      </button>
      {dismissible && <IconButton icon="close" title="Don't show this here again (Project Settings still says so)" onClick={() => rememberProjectPref('hiveVcsNotice', key, hiveVcsKey(v))} />}
    </div>
  )
}
