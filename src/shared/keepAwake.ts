import type { SessionStatus } from './types'

/** Settings → General → Keep the PC awake while agents work. */
export type KeepAwakeSetting = 'plugged-in' | 'always' | 'never'

/** Agents that count as working for this: working, or waiting on background tasks that will start them again. */
export function agentsWorking(states: readonly { status: SessionStatus }[]): number {
  return states.filter((s) => s.status === 'working' || s.status === 'background').length
}

/** Whether to keep Windows from sleeping now. The screen may still turn off and lock. */
export function shouldKeepAwake(working: number, setting: KeepAwakeSetting | undefined, onBattery: boolean): boolean {
  if (working <= 0 || setting === 'never') return false
  return setting === 'always' || !onBattery
}

/** The status bar's note while it does. */
export function keepAwakeText(working: number): string {
  return `Keeping the PC awake: ${working === 1 ? '1 agent' : `${working} agents`} working`
}
