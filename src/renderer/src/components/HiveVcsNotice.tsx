import { useState } from 'react'
import { HIVE_FOLDER_GUIDE, hiveVcsKey, hiveVcsText } from '@shared/hiveVcsText'
import type { ProjectInfo } from '@shared/types'
import { call, errorMessage } from '../api'
import { rememberProjectPref } from '../projectPrefs'
import { notify, set, useStore } from '../store'
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
  return (
    <div className="banner warn hive-vcs-notice">
      <Icon name="warning" />
      <span>
        <strong>{text.title}.</strong> {text.detail}
      </span>
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
