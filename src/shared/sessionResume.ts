import type { ProviderId, SessionListItem } from './types'
import { providerName } from './providers'

/**
 * Why a session can't be resumed, for the Sessions tab's marker and its disabled Resume buttons (the reason is their
 * tooltip), or null when it can. From what Hive already knows: the session (a sub-session, its transcript), its
 * provider (turned on, installed) and the agents that could run it now.
 */
export interface ResumeContext {
  /** It is running now (in an agent of this project, or any window). Shown as running rather than resumable. */
  live: boolean
  /** Its provider is turned on in Settings → Providers. */
  providerEnabled: boolean
  /** Its provider's CLI was found; null while not known yet. */
  providerInstalled: boolean | null
  /** The agents that can run it now (its provider, the folder it ran in). */
  runners: readonly { id: string; name: string }[]
  /** Resume may add an agent for it (a session from the project folder, and room for another agent). */
  canAddAgent: boolean
  /** The Hive Assistant's conversations: the provider it runs now (it has one agent). */
  assistantProvider?: ProviderId
}

type Resumable = Pick<SessionListItem, 'provider' | 'sub' | 'hasTranscript' | 'hasBackup' | 'cwd' | 'agentId' | 'agentName'>

export function resumeBlock(s: Resumable, ctx: ResumeContext): string | null {
  const who = providerName(s.provider)
  if (s.sub) return `A ${s.sub.kind} ${who} ran for another session, not a conversation of its own: it can't be resumed.`
  if (ctx.live) return 'It is running now.'
  if (!s.hasTranscript && !s.hasBackup) return `Neither ${who} nor Hive has its transcript any more, so there is nothing to resume.`
  if (!ctx.providerEnabled) return `${who} is turned off. Turn it on in Settings → Providers to resume it.`
  if (ctx.providerInstalled === false) return `${who} isn't installed. Set it up in Agent Setup to resume it.`
  if (ctx.assistantProvider !== undefined) {
    return ctx.assistantProvider === s.provider ? null : `It ran in ${who}, and the Assistant now runs ${providerName(ctx.assistantProvider)}. Switch its provider in Assistant Settings to resume it.`
  }
  if (!ctx.runners.length && !ctx.canAddAgent) {
    return s.cwd ? `It ran in a worktree no ${who} agent uses any more (${s.cwd}). Add a ${who} agent for that worktree to resume it.` : `No ${who} agent can run it, and the project has no room for another agent.`
  }
  return null
}

/** For a resumable session whose agent was removed: which agent resumes it now ("Its agent Coder was removed: it resumes in Helper."). */
export function removedAgentNote(s: Resumable, agents: readonly { id: string }[], target: { name: string } | null): string | null {
  if (!s.agentId || agents.some((a) => a.id === s.agentId)) return null
  const was = s.agentName ? `Its agent ${s.agentName}` : 'Its agent'
  return target ? `${was} was removed: it resumes in ${target.name}.` : `${was} was removed: Resume adds a ${providerName(s.provider)} agent for it.`
}
