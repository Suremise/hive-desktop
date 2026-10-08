// Unit tests run in plain Node: Hive's modules get this instead of Electron (no binary download in CI).
/* eslint-disable typescript/no-extraneous-class -- stand-ins for Electron's classes */
import { tmpdir } from 'os'

export const app = { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }
export class BrowserWindow {}
export class Notification {
  // Tests that record notifications make it supported and spy on show().
  constructor(readonly options?: { title?: string; body?: string }) {}
  static isSupported(): boolean {
    return false
  }
  on(): this {
    return this
  }
  show(): void {}
}
export const clipboard = {}
export const shell = {}
export const nativeImage = {}
export const dialog = {}
export default { app, BrowserWindow, Notification, clipboard, shell, nativeImage, dialog }
