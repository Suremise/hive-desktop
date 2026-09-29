import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { HiveEvent, ToastAction, ToastLevel, ToastMessage } from '../shared/types'

let win: BrowserWindow | null = null
const listeners = new Set<(e: HiveEvent) => void>()

export function setEventWindow(w: BrowserWindow | null): void {
  win = w
}

/** Sends an event to the renderer and to in-process listeners (e.g. the Agent API event stream). */
export function emit(event: HiveEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('hive:event', event)
  for (const l of listeners) l(event)
}

export function onHiveEvent(listener: (e: HiveEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function sendPty(channel: 'pty:data' | 'pty:exit', key: string, payload: string | number): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, key, payload)
}

export function toast(level: ToastLevel, title: string, message?: string, actions?: ToastAction[], source?: string): ToastMessage {
  const t: ToastMessage = { id: randomUUID(), level, title, message, actions, source, timestamp: new Date().toISOString() }
  emit({ type: 'toast', toast: t })
  return t
}
