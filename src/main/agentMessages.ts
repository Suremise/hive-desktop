import type { DeliverySender, DeliveryState } from '../shared/deliveries'
import { createDelivery, cancelDeliveries, deliveryNow, offerNow, TooManyWaiting, waitingCount } from './deliveries'
import { sessions } from './sessions'

/**
 * Messages left for an agent (#530: hive_message_agent), now deliveries (#647, deliveries.ts): a re-brief for the work it
 * is on, saved in its project's .hive/deliveries.json and offered by the delivery service. On 10 Oct the user pasted
 * about ten of the Assistant's messages into agents' panes because hive_prompt_agent refused every agent of a running
 * card loop; a message goes in whatever the agent is doing.
 *
 * Offered as the agent's next line, whichever comes first: a wake (a card or agent watch's line, a loop wake), which it
 * rides at the front of, so the agent has it before it acts on the wake; or a line of its own once the agent is idle
 * (ready, finished or watching), typed as a wake is (nobody typing there, no earlier line waiting). A watching agent is
 * idle, so a message wakes it at once and its watch carries on (the line says so). Several waiting go in one line, in
 * order, with their ids to ack. The agent can also fetch them first, with hive_inbox.
 *
 * Its sender's permission is worked out again before it is typed, before each piece and Enter, and until its CLI takes
 * it: one no longer allowed is refused, never typed or submitted; a line it was in that the CLI hasn't taken is cleared
 * then (when safe), and the wake it rode typed again alone. At most MAX_QUEUED waiting per agent, each at most
 * MESSAGE_MAX_CHARS. They survive the agent's stops and Hive's restarts; the Assistant's are refused once the launch
 * that left them has ended (#645).
 */

export const MESSAGE_MAX_CHARS = 4000
export const MAX_QUEUED = 5

/** What became of a message by the time leaveMessage returns: typed (offered or received), queued, or an end. */
export type MessageFate = 'typed' | 'queued' | 'cancelled' | 'refused' | 'expired'

const fateOf = (s: DeliveryState): MessageFate => (s === 'offered' || s === 'received' || s === 'acked' ? 'typed' : s === 'queued' || s === 'uncertain' ? 'queued' : s === 'cancelled' ? 'cancelled' : s === 'refused' ? 'refused' : 'expired')

/**
 * Leaves a message for a running agent (from: its sender, whose name the line gives). Offered now when it can be, else
 * queued. What became of it by the time this returns, with its id; refused (an Error) when it isn't running, the text is
 * empty or too long, its sender may not send it, or MAX_QUEUED are already waiting.
 */
export async function leaveMessage(projectPath: string, agentId: string, agentName: string, from: DeliverySender, text: string): Promise<{ id: string; fate: MessageFate; queued: number; detail?: string }> {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st) throw new Error(`${agentName} isn't running.`)
  const t = text.trim()
  if (!t) throw new Error('text is required')
  if (t.length > MESSAGE_MAX_CHARS) throw new Error(`A message is at most ${MESSAGE_MAX_CHARS} characters (this one has ${t.length}).`)
  const r = await createDelivery(projectPath, { agentId, agentName, conversation: st.sessionId || null, kind: 'rebrief', from, body: t, maxWaiting: MAX_QUEUED }).catch((e) => {
    if (e instanceof TooManyWaiting) throw new Error(`${agentName} already has ${MAX_QUEUED} messages waiting, the most Hive keeps for an agent: wait until they are delivered (hive_agent_activity), or cancel them.`)
    throw e
  })
  await offerNow(projectPath, agentId)
  const now = deliveryNow(projectPath, r.id) ?? r
  return { id: r.id, fate: fateOf(now.state), queued: waitingCount(projectPath, agentId, 'rebrief'), ...(now.detail && fateOf(now.state) !== 'typed' ? { detail: now.detail } : {}) }
}

/** Cancels an agent's messages waiting (by: who cancelled). How many there were. */
export const cancelMessages = (projectPath: string, agentId: string, by: string): Promise<number> => cancelDeliveries(projectPath, agentId, by, ['rebrief'])
