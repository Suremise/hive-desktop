// A project's view preferences (the Skills tab's provider and groups, the Sessions tree's branches): shown at once from
// this window's store, and saved by main as this one project's change, merged into what is saved (#245), so another
// window's copy of the maps can't overwrite it. Every window's store follows (ui-pref-changed).
import { withProjectPref, type ProjectPref, type ProjectPrefValue } from '@shared/uiPrefs'
import { call } from './api'
import { get, set } from './store'

/** Sets (or, with null, forgets) one project's preference, by its path in lower case. */
export function rememberProjectPref<P extends ProjectPref>(pref: P, project: string, value: ProjectPrefValue<P> | null): void {
  applyProjectPref(pref, project, value)
  void call('ui:setProjectPref', pref, project, value).catch(() => undefined)
}

/** One project's preference into this window's store: its own change, or another window's. */
export function applyProjectPref(pref: ProjectPref, project: string, value: unknown): void {
  set({ [pref]: withProjectPref(get()[pref] as Record<string, unknown>, project, value) } as never)
}
