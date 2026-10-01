import type { BackgroundTaskEvent } from '../types'

/** Notification statuses that report on a task still running (a Monitor's events); any other status ends it. */
const STILL_RUNNING = new Set(['running', 'event', 'progress', 'pending', 'started', 'in_progress'])

/**
 * Claude Code's background tasks in transcript lines. A background Bash call's result has backgroundTaskId (also
 * when a command that ran too long was moved to the background), a Monitor's has taskId and when it expires.
 * A task's end arrives as a <task-notification> naming it (which starts a new turn), or a TaskStop result.
 */
export function claudeBackgroundTasks(appended: string): BackgroundTaskEvent[] {
  const out: BackgroundTaskEvent[] = []
  for (const line of appended.split('\n')) {
    if (!/backgroundTaskId|"taskId"|task-notification|stopped task/.test(line)) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o.timestamp) || Date.now()
    const r = o.toolUseResult
    if (r && typeof r === 'object') {
      if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) out.push({ kind: 'start', id: r.backgroundTaskId, at })
      else if (typeof r.taskId === 'string' && r.taskId && typeof r.timeoutMs === 'number') {
        out.push({ kind: 'start', id: r.taskId, at, ...(r.persistent ? {} : { expiresAt: at + r.timeoutMs }) })
      } else if (typeof r.message === 'string') {
        const stopped = /stopped task:? ([\w-]+)/i.exec(r.message)
        if (stopped) out.push({ kind: 'end', id: stopped[1], at })
      }
    }
    // The notification is in a user message, a queued command or both, possibly more than once: ends repeat harmlessly.
    const text = line.replace(/\\n/g, '\n')
    for (const m of text.matchAll(/<task-notification>\s*<task-id>([\w-]+)<\/task-id>([\s\S]*?)<\/task-notification>/g)) {
      const status = /<status>([\w-]+)<\/status>/.exec(m[2])?.[1]
      if (!status || !STILL_RUNNING.has(status)) out.push({ kind: 'end', id: m[1], at })
    }
  }
  return out
}
