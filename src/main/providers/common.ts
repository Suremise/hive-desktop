import { execFile } from 'child_process'
import { join } from 'path'
import type { RecacheEstimate, SessionUsage } from '../../shared/types'

/** Helpers shared by provider adapters. */

export function run(file: string, args: string[], timeoutMs = 15000, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = /\.(cmd|bat)$/i.test(file)
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell, encoding: 'utf8', env }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1 })
    })
  })
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Copies of a CLI that belong to an editor extension (VS Code, Cursor…), which Hive never uses. */
export const EDITOR_EXTENSION_PATH = /[\\/]\.(vscode|vscode-insiders|cursor|windsurf)[\\/]extensions[\\/]/i

export const EDITOR_ROOTS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']

/** Wraps .cmd/.bat launchers so node-pty can start them. */
export function toSpawnable(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }
  }
  return { file, args }
}

/**
 * A shell command that forwards a hook's JSON (stdin) to Hive's hook server with curl, which ships
 * with Windows 10+. For hooks a CLI can only run as commands. The token is written literally so the
 * command works whichever shell the CLI runs it in; forward slashes keep bash from eating backslashes.
 */
export function hookForwardCommand(hookUrl: string, token: string): string {
  const curl = process.platform === 'win32' ? `"${join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe').split('\\').join('/')}"` : 'curl'
  return `${curl} -s -m 5 -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- "${hookUrl}"`
}

/** Estimates how many tokens resuming a session will write to the prompt cache (providers with a cache TTL). */
export function recacheEstimate(usage: SessionUsage, ttlOverride: 'auto' | '5m' | '1h', now = Date.now()): RecacheEstimate {
  const ttlSeconds = ttlOverride === '5m' ? 300 : ttlOverride === '1h' ? 3600 : usage.cacheTtlSeconds
  const last = usage.lastActivity ? Date.parse(usage.lastActivity) : 0
  const elapsed = last ? (now - last) / 1000 : Infinity
  const warm = elapsed < ttlSeconds
  return {
    tokens: usage.contextTokens,
    warm,
    secondsLeft: warm ? Math.max(0, Math.round(ttlSeconds - elapsed)) : 0,
    ttlSeconds
  }
}
