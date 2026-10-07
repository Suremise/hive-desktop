import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { mkdir, rm, writeFile } from 'original-fs/promises'
import { join } from 'path'

/**
 * Each launch's own hook token and private folder (#345). The hook server takes a hook call only with the token of the
 * launch it names (`?run=<runId>`), and a launch's token ends with it: a token that leaks can't speak for another
 * session or outlive its own. CLIs that send hooks over HTTP read it from the session's environment (`HIVE_HOOK_TOKEN`);
 * hook commands (curl) read the header from the launch's auth file.
 *
 * The auth file, and whatever else of a launch may hold a secret (Claude Code's settings, with a user's `--settings`
 * and its `env`; its MCP config, with the workspace's servers' own `env` and headers), go in the launch's private
 * folder in Hive's user data, `launches/<runId>`, never in the project: no file Hive generates in a project holds a
 * secret. The folder goes when the launch ends, and all of them when Hive starts.
 */

const tokens = new Map<string, string>()

function launchesDir(): string {
  return join(app.getPath('userData'), 'launches')
}

/** A launch's private folder, outside the project: for its files that may hold secrets. */
export function launchPrivateDir(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Not a run id.')
  return join(launchesDir(), runId)
}

/** The file a launch's hook commands read their Authorization header from (`curl -H @<file>`). */
export function hookAuthFile(runId: string): string {
  return join(launchPrivateDir(runId), 'hook-auth.txt')
}

/** A new token for the launch `runId`, written to its auth file in its private folder (made here). */
export async function newHookToken(runId: string): Promise<{ token: string; file: string; dir: string }> {
  const token = randomBytes(24).toString('hex')
  const dir = launchPrivateDir(runId)
  const file = hookAuthFile(runId)
  tokens.set(runId, token)
  await mkdir(dir, { recursive: true })
  await writeFile(file, `Authorization: Bearer ${token}\n`)
  return { token, file, dir }
}

/** Whether an Authorization header carries the token of the launch `runId` (one that has ended has none). */
export function hookTokenMatches(runId: string | null, header: string | undefined): boolean {
  const token = runId ? tokens.get(runId) : undefined
  if (!token) return false
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** The launch `runId` ended: its token stops working and its private folder goes. */
export function endHookToken(runId: string): void {
  tokens.delete(runId)
  void rm(launchPrivateDir(runId), { recursive: true, force: true }).catch(() => undefined)
}

/** At startup: private folders an earlier run of Hive left (its tokens died with it). */
export async function clearHookAuth(): Promise<void> {
  await rm(launchesDir(), { recursive: true, force: true }).catch(() => undefined)
}
