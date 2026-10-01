import type { BackgroundTaskEvent } from '../types'

/**
 * Codex's background terminals in rollout lines. A command still running when exec_command returns gives a
 * session_id instead of an exit_code (older Codex: "Process running with session ID n"); Codex records its
 * end as an item_completed CommandExecution with that process_id. Codex isn't told when one ends.
 */
export function codexBackgroundTasks(appended: string): BackgroundTaskEvent[] {
  const out: BackgroundTaskEvent[] = []
  for (const line of appended.split('\n')) {
    if (!/session_id|session ID|process_id/.test(line)) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o.timestamp) || Date.now()
    const p = o.payload
    if (!p || typeof p !== 'object') continue
    if (o.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution' && p.item.process_id != null) {
      out.push({ kind: 'end', id: String(p.item.process_id), at })
      continue
    }
    if (p.type !== 'custom_tool_call_output' && p.type !== 'function_call_output') continue
    const parts: string[] = typeof p.output === 'string' ? [p.output] : Array.isArray(p.output) ? p.output.map((x: any) => (typeof x?.text === 'string' ? x.text : '')) : []
    for (const text of parts) {
      // One result per part: running (a session id) or done (an exit code, which may name the session too).
      const id = /"session_id"\s*:\s*"?(\d+)/.exec(text)?.[1] ?? /Process running with session ID (\d+)/.exec(text)?.[1]
      if (!id) continue
      out.push({ kind: /"exit_code"\s*:|Process exited with code/.test(text) ? 'end' : 'start', id, at })
    }
  }
  return out
}
