// The hive-progress command on every session's PATH: a .cmd (cmd, PowerShell) and an extensionless sh script (Git
// Bash) in Hive's bin folder, each starting hive-progress.js with Hive's own executable as Node. Timings for its
// estimates are kept beside them, in Hive's data (never in the user's project).
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export interface ShimPaths {
  /** Hive's executable (run as Node). */
  exec: string
  /** hive-progress.js, outside the asar. */
  script: string
  /** Where the wrapper keeps its timings. */
  data: string
}

/** The two shims' contents. */
export function shimFiles(p: ShimPaths): Record<'hive-progress.cmd' | 'hive-progress', string> {
  const slash = (s: string): string => s.replace(/\\/g, '/')
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return {
    'hive-progress.cmd': [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "HIVE_PROGRESS_DATA=${p.data}"`,
      `"${p.exec}" "${p.script}" %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n'),
    'hive-progress': ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 HIVE_PROGRESS_DATA=${sq(slash(p.data))} exec ${sq(slash(p.exec))} ${sq(slash(p.script))} "$@"`, ''].join('\n')
  }
}

/** Writes the shims into `dir` (only what changed). Resolves to `dir`, or null when they couldn't be written. */
export async function installShims(dir: string, p: ShimPaths): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(shimFiles(p))) {
      const file = join(dir, name)
      const now = await readFile(file, 'utf8').catch(() => null)
      if (now !== text) await writeFile(file, text, { mode: 0o755 })
    }
    return dir
  } catch {
    return null
  }
}

/** A session's environment with `dir` first on its PATH (whatever case the variable's name has). */
export function withBinOnPath(env: Record<string, string>, dir: string | null, sep = ';'): Record<string, string> {
  if (!dir) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const rest = (env[key] ?? '').split(sep).filter((d) => d && d.toLowerCase() !== dir.toLowerCase())
  return { ...env, [key]: [dir, ...rest].join(sep) }
}
