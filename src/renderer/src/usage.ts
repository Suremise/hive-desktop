import { useEffect, useMemo, useState } from 'react'
import type { ProjectInfo, SessionUsage } from '@shared/types'
import { afterRefresh, usageFor, type HeldUsage, type LiveUsage } from '@shared/liveUsage'
import { call } from './api'
import { useFocusedAgent, useStore } from './store'

export type { LiveUsage } from '@shared/liveUsage'

/**
 * Token usage of an agent's running session (the focused agent's by default), refreshed whenever its transcript
 * changes. Null until the session's own usage has been read: after switching conversations the previous one's
 * numbers never show for the new one.
 */
export function useLiveUsage(project: ProjectInfo | null | undefined, agentId?: string): LiveUsage | null {
  return useLiveUsageState(project, agentId).usage
}

/** useLiveUsage, and whether the session's usage is still being read (a placeholder shows meanwhile). */
export function useLiveUsageState(project: ProjectInfo | null | undefined, agentId?: string): { usage: LiveUsage | null; pending: boolean } {
  const usageVersion = useStore((s) => (project ? s.usageVersion[project.path] ?? 0 : 0))
  const focused = useFocusedAgent(project)
  const live = (agentId ? project?.agents.find((a) => a.id === agentId) : focused)?.live
  const sessionId = live && !live.settingUp ? live.sessionId : null
  const path = project?.path
  const key = path && sessionId ? `${path}#${sessionId}` : null
  const [held, setHeld] = useState<HeldUsage | null>(null)
  useEffect(() => {
    if (!path || !sessionId || !key) return
    let cancelled = false
    void call('session:usage', path, sessionId).then(
      (usage) => !cancelled && setHeld((h) => afterRefresh(h, key, { usage })),
      // Quietly: a background refresh that failed keeps the session's last numbers, marked stale.
      () => !cancelled && setHeld((h) => afterRefresh(h, key, { failed: true }))
    )
    return () => {
      cancelled = true
    }
  }, [path, sessionId, key, usageVersion])
  return useMemo(() => usageFor(held, key), [held, key])
}

/** Whether the prompt cache is still warm, i.e. compacting (or continuing) now is cheap. */
export function cacheState(usage: SessionUsage, ttlSetting: 'auto' | '5m' | '1h'): { warm: boolean; secondsLeft: number } {
  const ttl = ttlSetting === '5m' ? 300 : ttlSetting === '1h' ? 3600 : usage.cacheTtlSeconds
  const last = usage.lastActivity ? Date.parse(usage.lastActivity) : 0
  const elapsed = last ? (Date.now() - last) / 1000 : Infinity
  return { warm: elapsed < ttl, secondsLeft: elapsed < ttl ? Math.round(ttl - elapsed) : 0 }
}

/** Re-renders every intervalMs, for times shown relative to now. */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
