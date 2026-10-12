/**
 * Deliveries (#647, plans/2026-10-12-messaging-redesign.md §3.1): everything Hive has for an agent to read is a record
 * with an id, its target, kind, sender, card, body and state, saved in its project's .hive/deliveries.json and offered
 * by one scheduler (main/deliveries.ts). The agent collects them with hive_inbox (received) and acknowledges them once it
 * has acted on them (acked). This file is the pure part: the states and their moves, coalescing, the typed line and the
 * inbox's reply. No imports beyond shared types: hive-mcp.js runs outside the app bundle.
 */
import type { InboxBrief, InboxSummary } from './types'

/** What a delivery is: a task, a re-brief (a message for the work it is on), a card event, the user's answer, a handover, a control notice. */
export const DELIVERY_KINDS = ['task', 'rebrief', 'card-event', 'answer', 'handover', 'control'] as const
export type DeliveryKind = (typeof DELIVERY_KINDS)[number]

/**
 * queued: waiting to be offered; offered: Hive has put it in front of the agent (today, typed into its terminal); received:
 * the agent has it (its CLI took the line it was in, or it fetched it with hive_inbox); acked: the agent says it has acted
 * on it. Ended without that: cancelled (by whom), refused (its sender may no longer send it), expired (too old, or its
 * agent is in another conversation now). uncertain: Hive stopped between offering it and knowing it arrived.
 */
export const DELIVERY_STATES = ['queued', 'offered', 'received', 'acked', 'cancelled', 'refused', 'expired', 'uncertain'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/**
 * Who a delivery is from. The Assistant's names its workspace and the launch that sent it: its permission is worked out
 * again from those and the settings at every step (never a token or a closure, which can't be saved), and a launch that
 * has ended sends nothing more (#645). Hive's own (board events) and the user's need no more.
 */
export type DeliverySender = { kind: 'assistant'; name: string; workspace: string; launch: string } | { kind: 'hive'; name: string } | { kind: 'user'; name: string }

export interface DeliveryRecord {
  /** Short and unique in its project ("m12"): what the agent acks. */
  id: string
  seq: number
  agentId: string
  /** The agent's name when it was made, for what is shown. */
  agentName?: string
  /** The conversation it is for (the provider's session id), when known: another conversation of the agent doesn't get it. */
  conversation: string | null
  kind: DeliveryKind
  from: DeliverySender
  card?: number
  /** What it says (a card event's short line, a message's text). */
  body: string
  state: DeliveryState
  created: string
  expires: string
  offered?: string
  /** How many times it was offered (again after Hive stopped while offering it). */
  offers?: number
  received?: string
  /** How it was received: its CLI took the line it was in, or the agent fetched it. */
  receivedVia?: 'line' | 'inbox'
  /**
   * The offer that is (or was last) in front of the agent: the hash of the exact line typed (promptKey, then sha256), how
   * many items the conversation's transcript had before it was typed, and the launch it was typed into. A receipt by line
   * is a prompt after that point whose whole text is that line, nothing less.
   */
  offerHash?: string
  offerAt?: number
  offerRun?: string
  /** Where it was received by line: the conversation and the transcript item of the prompt that was its line. */
  receivedIn?: { conversation: string; item: number }
  acked?: string
  /** When it was cancelled, refused or expired. */
  ended?: string
  /** Why it ended, or why it is uncertain. */
  detail?: string
}

/** Unacked this long after it was made, a delivery is overdue: shown as such to the user and the Assistant. */
export const OVERDUE_MINUTES = 30
/** How long a delivery waits to be received before it expires. */
export const DELIVERY_EXPIRY_HOURS = 24

const NEXT: Record<DeliveryState, readonly DeliveryState[]> = {
  queued: ['offered', 'received', 'acked', 'cancelled', 'refused', 'expired'],
  // Back to queued: the offer didn't happen after all (nothing was typed). Cancelled: while it is still being typed.
  offered: ['received', 'acked', 'uncertain', 'queued', 'cancelled', 'refused', 'expired'],
  uncertain: ['offered', 'received', 'acked', 'cancelled', 'refused', 'expired'],
  received: ['acked', 'expired'],
  acked: [],
  cancelled: [],
  refused: [],
  expired: []
}

export const canMove = (from: DeliveryState, to: DeliveryState): boolean => NEXT[from].includes(to)
/** Not ended: still for the agent to receive or ack. */
export const isLive = (r: Pick<DeliveryRecord, 'state'>): boolean => r.state === 'queued' || r.state === 'offered' || r.state === 'uncertain' || r.state === 'received'
/** Not received yet: what hive_inbox lists and the pane counts. */
export const isUnread = (r: Pick<DeliveryRecord, 'state'>): boolean => r.state === 'queued' || r.state === 'offered' || r.state === 'uncertain'
/** Waiting to be offered (again): what the scheduler offers. */
export const isWaiting = (r: Pick<DeliveryRecord, 'state'>): boolean => r.state === 'queued' || r.state === 'uncertain'

/** A delivery moved to another state at `at` (ISO), its times filled in; null when that move isn't allowed. */
export function moved(r: DeliveryRecord, to: DeliveryState, at: string, detail?: string): DeliveryRecord | null {
  if (!canMove(r.state, to)) return null
  const next: DeliveryRecord = { ...r, state: to }
  delete next.detail
  if (to === 'offered') {
    next.offered = at
    next.offers = (r.offers ?? 0) + 1
  } else if (to === 'queued') {
    // Not offered after all: as it was before the offer.
    next.offers = Math.max(0, (r.offers ?? 1) - 1)
    if (!next.offers) {
      delete next.offered
      delete next.offers
    }
  } else if (to === 'received') next.received = at
  else if (to === 'acked') {
    next.acked = at
    next.received ??= at
  } else if (to !== 'uncertain') next.ended = at
  if (detail) next.detail = detail
  return next
}

/** Whether a live delivery hasn't been acked OVERDUE_MINUTES (or `overdueMs`) after it was made. */
export const isOverdue = (r: DeliveryRecord, now: number, overdueMs = OVERDUE_MINUTES * 60_000): boolean => isLive(r) && now - Date.parse(r.created) >= overdueMs

/** One item of the inbox: a delivery, or a card's events coalesced ("#607: 3 changes, read the card"). */
export interface InboxItem {
  ids: string[]
  kind: DeliveryKind
  from: string
  card?: number
  text: string
  at: string
}

/** The unread deliveries as the inbox lists them, oldest first: a card's events in one item, where its first one was. */
export function inboxItems(records: readonly DeliveryRecord[]): InboxItem[] {
  const out: InboxItem[] = []
  const byCard = new Map<number, { item: InboxItem; bodies: string[] }>()
  for (const r of [...records].filter(isUnread).sort((a, b) => a.seq - b.seq)) {
    if (r.kind === 'card-event' && r.card) {
      const had = byCard.get(r.card)
      if (had) {
        had.item.ids.push(r.id)
        had.bodies.push(r.body)
        if (!had.item.from.split(' and ').includes(r.from.name)) had.item.from += ` and ${r.from.name}`
        continue
      }
      const item: InboxItem = { ids: [r.id], kind: r.kind, from: r.from.name, card: r.card, text: '', at: r.created }
      byCard.set(r.card, { item, bodies: [r.body] })
      out.push(item)
      continue
    }
    out.push({ ids: [r.id], kind: r.kind, from: r.from.name, ...(r.card ? { card: r.card } : {}), text: r.body, at: r.created })
  }
  for (const { item, bodies } of byCard.values()) item.text = bodies.length === 1 && bodies[0] ? bodies[0] : `${bodies.length} ${bodies.length === 1 ? 'change' : 'changes'}, read the card`
  return out
}

const idList = (ids: readonly string[]): string => ids.join(', ')

/**
 * The line that offers deliveries by typing (today's transport, until Messaging 4 switches channels): their texts, the
 * ids to ack, and the watch that carries on if the agent is watching. One line: the CLI's prompt.
 */
export function offerLine(records: readonly DeliveryRecord[], watchLabel: string | null): string {
  const items = inboxItems(records.map((r) => ({ ...r, state: 'queued' as const })))
  const messages = items.filter((i) => i.kind !== 'card-event')
  const events = items.filter((i) => i.kind === 'card-event')
  const parts: string[] = []
  if (messages.length) {
    const from = [...new Set(messages.map((m) => m.from))].join(' and ')
    parts.push(messages.length === 1 ? `Message from ${from}: ${messages[0].text}` : `${messages.length} messages from ${from}: ${messages.map((m, i) => `(${i + 1}) ${m.text}`).join(' ')}`)
  }
  for (const e of events) parts.push(`#${e.card}: ${e.text}`)
  const ids = items.flatMap((i) => i.ids)
  const one = ids.length === 1
  const ack = ` (${one ? 'Its id' : 'Their ids'}: ${idList(ids)}. Once you've acted on ${one ? 'it' : 'them'}, ack ${one ? 'it' : 'them'} with hive_inbox.)`
  const tail = watchLabel ? ` (Your watch is still on, ${watchLabel.charAt(0).toLowerCase()}${watchLabel.slice(1)}: do what this asks, then end your turn, and Hive wakes you when it changes.)` : ''
  return `[Hive] ${parts.join(' ')}${ack}${tail}`
}

/**
 * A prompt as Hive types it and as a CLI keeps it, for comparing the two: whitespace runs as one space, control
 * characters gone (sessions.sendPrompt flattens a line and strips them from a paste), trimmed.
 */
export const promptKey = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** hive_inbox's reply: what is new (now received), and what was received before and isn't acked yet. */
export function inboxText(items: readonly InboxItem[], unacked: readonly string[]): string {
  const older = unacked.length ? `Received before, not acked yet: ${idList(unacked)}.` : ''
  if (!items.length) return `Nothing new.${older ? ` ${older}` : ''}`
  const rows = items.map((i) => `${i.ids.join(',')} · ${i.from}${i.card ? ` · #${i.card}` : ''}: ${i.text}`)
  return [`${items.length} new:`, ...rows, ...(older ? [older] : []), 'Ack each with hive_inbox (ack: its ids) once you have acted on it.'].join('\n')
}

/** hive_inbox ack's reply. */
export function ackText(acked: readonly string[], unknown: readonly string[]): string {
  const a = acked.length ? `Acked ${idList(acked)}.` : 'Nothing acked.'
  return unknown.length ? `${a} Not in your inbox: ${idList(unknown)}.` : a
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** What an agent's pane shows of its deliveries: those not received yet, and how many are overdue; undefined when neither. */
export function inboxSummary(records: readonly DeliveryRecord[], now: number, overdueMs?: number): InboxSummary | undefined {
  const unread: InboxBrief[] = records
    .filter(isUnread)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ id: r.id, from: r.from.name, text: clip(r.body || (r.card ? `#${r.card} changed` : ''), 120), at: r.created, state: r.state, ...(r.card ? { card: r.card } : {}) }))
  const overdue = records.filter((r) => isOverdue(r, now, overdueMs)).length
  return unread.length || overdue ? { unread, overdue } : undefined
}

/** A delivery as the Agent API and hive_agent_activity show it: its state and times, the start of what it says. */
export interface DeliveryRow {
  id: string
  kind: DeliveryKind
  from: string
  card?: number
  text: string
  state: DeliveryState
  created: string
  offered?: string
  received?: string
  receivedVia?: 'line' | 'inbox'
  acked?: string
  ended?: string
  detail?: string
  overdue?: true
}

export function deliveryRow(r: DeliveryRecord, now: number, textChars = 80, overdueMs?: number): DeliveryRow {
  return {
    id: r.id,
    kind: r.kind,
    from: r.from.name,
    ...(r.card ? { card: r.card } : {}),
    text: clip(r.body, textChars),
    state: r.state,
    created: r.created,
    ...(r.offered ? { offered: r.offered } : {}),
    ...(r.received ? { received: r.received, ...(r.receivedVia ? { receivedVia: r.receivedVia } : {}) } : {}),
    ...(r.acked ? { acked: r.acked } : {}),
    ...(r.ended ? { ended: r.ended } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(isOverdue(r, now, overdueMs) ? { overdue: true as const } : {})
  }
}

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max
const time = (x: unknown): x is string => str(x, 40) && x.length > 0 && Number.isFinite(Date.parse(x))
const optTime = (x: unknown): boolean => x === undefined || time(x)

function readSender(v: unknown): DeliverySender | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (!str(s.name, 200) || !s.name) return null
  if (s.kind === 'assistant') return str(s.workspace, 1024) && s.workspace && str(s.launch, 200) ? { kind: 'assistant', name: s.name, workspace: s.workspace, launch: s.launch } : null
  if (s.kind === 'hive' || s.kind === 'user') return { kind: s.kind, name: s.name }
  return null
}

/** A saved delivery, checked in full (the file can be edited by hand) and rebuilt from what checks out; null if it isn't one. */
export function readDelivery(v: unknown): DeliveryRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!str(r.id, 32) || !/^m\d+$/.test(r.id) || !Number.isInteger(r.seq) || (r.seq as number) < 1 || !str(r.agentId, 128) || !r.agentId) return null
  if (!(DELIVERY_KINDS as readonly unknown[]).includes(r.kind) || !(DELIVERY_STATES as readonly unknown[]).includes(r.state)) return null
  const from = readSender(r.from)
  if (!from || !str(r.body, 8000) || !time(r.created) || !time(r.expires)) return null
  if (!(r.conversation === null || str(r.conversation, 200))) return null
  if (r.card !== undefined && !(Number.isInteger(r.card) && (r.card as number) > 0)) return null
  if (![r.offered, r.received, r.acked, r.ended].every(optTime)) return null
  if (r.offers !== undefined && !(Number.isInteger(r.offers) && (r.offers as number) >= 0)) return null
  if (r.receivedVia !== undefined && r.receivedVia !== 'line' && r.receivedVia !== 'inbox') return null
  if (r.detail !== undefined && !str(r.detail, 500)) return null
  if (r.agentName !== undefined && !str(r.agentName, 300)) return null
  if (r.offerHash !== undefined && !(str(r.offerHash, 64) && /^[0-9a-f]+$/.test(r.offerHash))) return null
  if (r.offerAt !== undefined && !(Number.isInteger(r.offerAt) && (r.offerAt as number) >= 0)) return null
  if (r.offerRun !== undefined && !str(r.offerRun, 200)) return null
  const at = r.receivedIn as { conversation?: unknown; item?: unknown } | undefined
  if (at !== undefined && !(at && str(at.conversation, 200) && at.conversation && Number.isInteger(at.item) && (at.item as number) >= 0)) return null
  const out: DeliveryRecord = { id: r.id, seq: r.seq as number, agentId: r.agentId, conversation: (r.conversation as string | null) || null, kind: r.kind as DeliveryKind, from, body: r.body, state: r.state as DeliveryState, created: r.created, expires: r.expires }
  if (r.agentName) out.agentName = r.agentName as string
  if (r.card) out.card = r.card as number
  for (const k of ['offered', 'received', 'acked', 'ended', 'detail'] as const) if (r[k]) out[k] = r[k] as string
  if (r.offers) out.offers = r.offers as number
  if (r.receivedVia) out.receivedVia = r.receivedVia as 'line' | 'inbox'
  if (r.offerHash) out.offerHash = r.offerHash as string
  if (r.offerAt !== undefined) out.offerAt = r.offerAt as number
  if (r.offerRun) out.offerRun = r.offerRun as string
  if (at) out.receivedIn = { conversation: at.conversation as string, item: at.item as number }
  return out
}
