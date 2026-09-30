import { useEffect, useState } from 'react'
import type { ProjectInfo, SessionUsage } from '@shared/types'
import { call } from './api'
import { useFocusedAgent, useStore } from './store'

/** Token usage of an agent's running session (the focused agent's by default), refreshed whenever its transcript changes. */
export function useLiveUsage(project: ProjectInfo | null | undefined, agentId?: string): SessionUsage | null {
  const usageVersion = useStore((s) => (project ? s.usageVersion[project.path] ?? 0 : 0))
  const focused = useFocusedAgent(project)
  const live = (agentId ? project?.agents.find((a) => a.id === agentId) : focused)?.live
  const sessionId = live && !live.settingUp ? live.sessionId : null
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const path = project?.path
  useEffect(() => {
    if (!path || !sessionId) {
      setUsage(null)
      return
    }
    let cancelled = false
    void call('session:usage', path, sessionId)
      .then((u) => !cancelled && setUsage(u))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path, sessionId, usageVersion])
  return usage
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
