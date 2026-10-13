import { AGENTS_PER_PROJECT, advancedDef, advancedRow } from '@shared/advanced'
import { call } from './api'
import { set, useStore } from './store'

/** Settings → Advanced's state (#367), read again when it changes (an override, advanced.json, the workspace's own). */
export async function loadAdvanced(): Promise<void> {
  try {
    set({ advanced: await call('advanced:state') })
  } catch {
    // A window closing meanwhile: nothing to show.
  }
}

/** An advanced value as Hive uses it in this window (its workspace's own, the override, or the default). */
export function useAdvancedValue<T extends string | number | string[]>(id: string): T {
  const state = useStore((s) => s.advanced)
  return advancedRow(advancedDef(id)!, state).value as T
}

/** How many agents a project of this window's workspace can have (#562): Settings → Advanced → Agents per project. The main process checks it again. */
export function useAgentLimit(): number {
  return useAdvancedValue<number>(AGENTS_PER_PROJECT)
}

/** The same, outside a component. */
export function agentLimit(): number {
  return advancedRow(advancedDef(AGENTS_PER_PROJECT)!, useStore.getState().advanced).value as number
}
