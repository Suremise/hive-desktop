import type { SessionListItem } from './types'
import { providerName } from './providers'
import { msg, tr } from './i18n'

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
  /** The agents that can run it now: those working in the folder it ran in (it resumes in its own provider, #506). */
  runners: readonly { id: string; name: string }[]
  /** Resume may add an agent for it (a session from the project folder, and room for another agent). */
  canAddAgent: boolean
  /** The Hive Assistant's conversations: its one agent resumes each in the provider it ran in (#506). */
  assistant?: boolean
}

type Resumable = Pick<SessionListItem, 'provider' | 'sub' | 'hasTranscript' | 'hasBackup' | 'cwd' | 'agentId' | 'agentName'>

export function resumeBlock(s: Resumable, ctx: ResumeContext): string | null {
  const who = providerName(s.provider)
  if (s.sub) return tr(msg({ id: 'agents.resume.sub', defaultMessage: "A {kind} {cli} ran for another session, not a conversation of its own: it can't be resumed.", description: "Why a session in the Sessions tab can't be resumed: it was a helper run (a {kind}, as the CLI names it: \"subagent\") that the CLI ({cli}) started for another session." }), { kind: s.sub.kind, cli: who })
  if (ctx.live) return tr(msg({ id: 'agents.resume.running', defaultMessage: 'It is running now.', description: "Why a session in the Sessions tab can't be resumed: it is running." }))
  if (!s.hasTranscript && !s.hasBackup) return tr(msg({ id: 'agents.resume.noTranscript', defaultMessage: 'Neither {cli} nor Hive has its transcript any more, so there is nothing to resume.', description: "Why a session can't be resumed: its conversation's file is gone from the CLI ({cli}) and from Hive's backup." }), { cli: who })
  if (!ctx.providerEnabled) return tr(msg({ id: 'agents.resume.providerOff', defaultMessage: '{cli} is turned off. Turn it on in Settings → Providers to resume it.', description: "Why a session can't be resumed: its CLI ({cli}) is turned off. Settings → Providers is where: use its translated names." }), { cli: who })
  if (ctx.providerInstalled === false) return tr(msg({ id: 'agents.resume.notInstalled', defaultMessage: "{cli} isn't installed. Set it up in Agent Setup to resume it.", description: "Why a session can't be resumed: its CLI ({cli}) isn't installed. Agent Setup is a Help window: use its translated name." }), { cli: who })
  if (ctx.assistant) return null
  if (!ctx.runners.length && !ctx.canAddAgent) {
    return s.cwd
      ? tr(msg({ id: 'agents.resume.goneWorktree', defaultMessage: 'It ran in a worktree no agent uses any more ({folder}). Add an agent for that worktree to resume it.', description: "Why a session can't be resumed: no agent works in the worktree folder it ran in ({folder}, a path)." }), { folder: s.cwd })
      : tr(msg({ id: 'agents.resume.noRoom', defaultMessage: 'No agent works in the project folder, and the project has no room for another agent.', description: "Why a session can't be resumed: no agent works in the project's own folder, and the project has as many agents as it may have." }))
  }
  return null
}

/** For a resumable session whose agent was removed: which agent resumes it now ("Its agent Coder was removed: it resumes in Helper."). */
export function removedAgentNote(s: Resumable, agents: readonly { id: string }[], target: { name: string } | null): string | null {
  if (!s.agentId || agents.some((a) => a.id === s.agentId)) return null
  const agent = s.agentName ?? 'none'
  if (target) return tr(msg({ id: 'agents.resume.removedTo', defaultMessage: '{agent, select, none {Its agent} other {Its agent {agent}}} was removed: it resumes in {target}.', description: "A note on a session in the Sessions tab whose agent ({agent}: its name; none when unknown) was removed: another agent ({target}) resumes it." }), { agent, target: target.name })
  return tr(msg({ id: 'agents.resume.removedAdd', defaultMessage: '{agent, select, none {Its agent} other {Its agent {agent}}} was removed: Resume adds a {cli} agent for it.', description: "A note on a session in the Sessions tab whose agent ({agent}: its name; none when unknown) was removed: Resume (a button) adds an agent of its CLI ({cli}) for it." }), { agent, cli: providerName(s.provider) })
}
