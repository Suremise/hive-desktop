/**
 * A hand-over at a good moment (#1057). A long transcript's notice and footer used to offer Hand Over at once, which could
 * end a working agent's conversation, or a card loop's, part-way through a card. Now an agent that is busy, or on a card
 * of a running lane, is offered a hand-over after this card: queued on its session (handOverAfter) and done by Hive when
 * the card is through review (or the lane has ended), or, outside a lane, when its turn is next over, and never while it
 * merges. An idle agent outside a lane gets Hand Over to… as before; the Assistant starts a new conversation once idle.
 */
import { msg } from './i18n/msg'
import { laneRunning } from './laneBar'
import { tasksWillWake } from './providers'
import type { DeliveryNeed } from './deliveries'
import type { LaneInfo, LiveSessionState } from './types'

type Live = Pick<LiveSessionState, 'status' | 'provider' | 'backgroundTasks' | 'mergeSlot' | 'handOverAfter'>

/**
 * Whether a hand-over asked for now should wait for a good moment rather than happen at once: the agent works, waits
 * for the user or for its background tasks, merges, or is on a running lane. Not running: no (Hand Over to… hands over
 * the latest handover, ending nothing).
 */
export function handOverWaits(st: Live | null | undefined, inLane: boolean): boolean {
  if (!st || st.status === 'stopped') return false
  return inLane || !(st.status === 'ready' || st.status === 'finished') || tasksWillWake(st) || !!st.mergeSlot
}

/** Why a queued hand-over waits, or what to do now (see handOverMoment). */
export type HandOverDecision = { do: 'now' | 'between' } | { wait: 'merging' | 'card' | 'lane-end' | 'turn' | 'none' }

/**
 * A queued hand-over: wait (and why), hand over now (its turn is over and nothing waits for it), or hand over between a
 * loop's steps (its lane card is through review, it watches for the next step). `lane` is the queued lane as it is now
 * (null: gone); `ready` the readiness check for a line of that need (main's readyFor).
 */
export function handOverDecision(st: Live | null | undefined, lane: LaneInfo | null, ready: (need: DeliveryNeed) => boolean): HandOverDecision {
  const h = st?.handOverAfter
  if (!st || !h) return { wait: 'none' }
  // Never during a merge: holding the merge slot, or in line for it.
  if (st.mergeSlot) return { wait: 'merging' }
  if (h.lane && lane && laneRunning(lane.state)) {
    // Asked for while its lane merged (no card left), or every card passed since (its merge due): once the lane has ended.
    if (h.card === null || !lane.current) return { wait: 'lane-end' }
    const card = lane.cards.find((c) => c.number === h.card)
    const through = !card || card.column === 'passed' || card.column === 'done' || card.column === 'gone'
    if (!through || lane.current === h.card) return { wait: 'card' }
    return ready('idle') ? { do: 'between' } : { wait: 'turn' }
  }
  return ready('free') ? { do: 'now' } : { wait: 'turn' }
}

/** handOverDecision, as what to do: wait, now or between. */
export function handOverMoment(st: Live | null | undefined, lane: LaneInfo | null, ready: (need: DeliveryNeed) => boolean): 'wait' | 'now' | 'between' {
  const d = handOverDecision(st, lane, ready)
  return 'do' in d ? d.do : 'wait'
}

export const HAND_OVER_TEXT = {
  /** The long-transcript notice's text (and the notification's), saying what can be done without pushing. */
  notice: msg({
    id: 'session.long.noticeText',
    defaultMessage: 'Its transcript is {size} (over {limit, number} MB): it may slow down. {when, select, now {It can hand over to a new conversation: Hand Over to… lets you choose.} assistant {It can start a new conversation once it is idle.} other {It can hand over to a new conversation at a good moment, after this card.}}',
    description: "The notice that an agent's conversation is long. {size}: its transcript's size (\"24 MB\"); {limit}: the size it is flagged over, in MB (Settings → Sessions). Then what can be done: now (it is idle: Hand Over to… is a command), assistant (the Hive Assistant: a new conversation once it is idle), other (it is busy or on a card loop's card: hand over after this card)."
  }),
  later: msg({ id: 'session.long.handOverLater', defaultMessage: 'Hand Over After This Card', description: "A button of the long-conversation notice, and an item of an agent's ⋯ menu: Hive hands the agent's work over to a new conversation once its card is through review, or its turn is over, never part-way through." }),
  laterAssistant: msg({ id: 'session.long.newConversationLater', defaultMessage: 'New Conversation When Idle', description: "A button of the Assistant's long-conversation notice: Hive starts the Assistant's new conversation once its turn is over, never part-way through." }),
  cancel: msg({ id: 'session.handOverLater.cancel', defaultMessage: 'Cancel Hand-Over', description: "A button (a notice's, and an item of an agent's ⋯ menu): cancels the hand-over Hive was to do after the agent's card." }),
  queued: msg({ id: 'session.handOverLater.queued', defaultMessage: '{assistant, select, yes {The Assistant starts a new conversation when it is idle} other {{agent} hands over after this card}}', description: "A notice's title: Hive will hand the agent's work ({agent}) over to a new conversation at a good moment; yes: it is the Hive Assistant, which starts a new conversation." }),
  queuedText: msg({
    id: 'session.handOverLater.queuedText',
    defaultMessage: '{when, select, card {Once card #{card} is through review, Hive asks it for a handover and it carries on in a new conversation.} lane {Once its card loop has ended, Hive asks it for a handover and it carries on in a new conversation.} assistant {Once its turn is over, Hive starts its new conversation.} other {Once its turn is over, Hive asks it for a handover and it carries on in a new conversation.}} Never while it merges.',
    description: 'Under the title of the notice that a hand-over is queued (#{card}: a card number): when Hive does it. card: after that card of its card loop; lane: once its card loop has ended; assistant: the Hive Assistant; other: an agent outside a card loop.'
  }),
  failed: msg({ id: 'session.handOverLater.failed', defaultMessage: "{agent}'s hand-over after its card failed", description: "A notice's title: the hand-over Hive did once the agent's ({agent}) card was through failed; the error follows." }),
  /** The footer's hover, and the ⋯ menu's detail, while one is queued. */
  queuedTip: msg({ id: 'panes.footer.handOverQueued', defaultMessage: '{when, select, card {Hands over to a new conversation once card #{card} is through review.} lane {Hands over to a new conversation once its card loop has ended.} assistant {Starts a new conversation once its turn is over.} other {Hands over to a new conversation once its turn is over.}} Never while it merges. Click to cancel.', description: "Hover of a pane footer's transcript warning while a hand-over is queued (#{card}: a card number); card, lane, assistant (the Hive Assistant), other: as the queued notice says it." }),
  /** The ⋯ menu's detail under Cancel Hand-Over. */
  queuedMenu: msg({ id: 'panes.menu.handOverQueued', defaultMessage: '{when, select, card {Queued: once card #{card} is through review} lane {Queued: once its card loop has ended} other {Queued: once its turn is over}}', description: "The detail under Cancel Hand-Over in an agent's menu: when the queued hand-over happens (#{card}: a card number); card, lane: after its card loop's card, or the loop's end; other: once its turn is over." }),
  /** The footer's advice for a long transcript, by what a click does. */
  advice: msg({ id: 'panes.footer.handOverWhen', defaultMessage: '{when, select, now {Hand it over to a new conversation: click for Hand Over to…, and choose the agent itself.} assistant {Click to start a new conversation once its turn is over.} other {Click to hand it over after this card: Hive does it once the card is through review, or its turn is over, never part-way through.}}', description: "What to do about a long transcript, in its hover (pane footer): now (the agent is idle: \"Hand Over to…\" is the agent menu's item, use its translation); assistant (the Hive Assistant); other (it is busy or on a card loop's card)." })
}

/** What a queued hand-over waits for, for its texts' {when}. */
export function handOverWhen(h: NonNullable<LiveSessionState['handOverAfter']>, assistant: boolean): { when: 'card' | 'lane' | 'assistant' | 'other'; card: string } {
  if (assistant) return { when: 'assistant', card: '' }
  if (h.lane && h.card !== null) return { when: 'card', card: String(h.card) }
  return { when: h.lane ? 'lane' : 'other', card: '' }
}
