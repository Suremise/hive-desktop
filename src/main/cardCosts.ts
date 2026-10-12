import { basename } from 'path'
import { config } from './config'
import { sessions } from './sessions'
import { allTasks } from './tasks'
import { listLanes } from './lanes'
import { inWorkspace, type WorkspaceService } from './workspace'
import { projectAgents } from '../shared/defaults'
import { addPart, cardRounds, emptyPart, holdsFromHistory, mergeSpans, roundPart, sliceSession, subtractSpans, type CardCost, type CostPart, type LaneCost, type SessionSlice, type Span } from '../shared/cardCosts'
import type { TaskCard, TaskHold } from '../shared/types'

/**
 * Cost per card and per lane (#602): each card's holds (TaskCard.held) against its agents' sessions' usage over time
 * (sessions.usageTimeline, from the usage cache). Read when asked (the card's panel, a lane's hover, Performance's
 * Cards table), nothing kept: the holds are on the cards and the timelines in the usage cache.
 */

interface AgentSessions {
  /** Each session of the project's agents: whose (agent id and name, as its record has them) and its usage. */
  list: { agentId?: string; agentName?: string; slice: SessionSlice }[]
  /** The project's agents now, for holds named by a name only. */
  agents: { id: string; name: string }[]
}

const ms = (iso: string | undefined | null, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

/** A project's agents' sessions (deleted ones' kept usage too), read once per request. */
async function projectSessions(ws: WorkspaceService, projectPath: string): Promise<AgentSessions> {
  const file = await ws.sessionsFile(projectPath)
  const cfg = await ws.projectConfig(projectPath)
  const ctx = { records: file.sessions, cfg }
  const list: AgentSessions['list'] = []
  for (const rec of file.sessions) {
    if (!rec.agentId && !rec.agentName) continue
    const got = await sessions.usageTimeline(projectPath, rec.id, ctx).catch(() => null)
    const u = got?.usage ?? null
    list.push({ agentId: rec.agentId, agentName: rec.agentName, slice: { usage: u, timeline: got?.timeline ?? null, from: ms(u?.firstActivity ?? rec.createdAt, 0), to: ms(u?.lastActivity ?? rec.lastActiveAt, 0) } })
  }
  for (const k of file.deletedUsage ?? []) {
    if (!k.agentId) continue
    list.push({ agentId: k.agentId, slice: { usage: k.usage, timeline: null, from: ms(k.usage.firstActivity, 0), to: ms(k.usage.lastActivity, 0) } })
  }
  return { list, agents: projectAgents(cfg).map((a) => ({ id: a.id, name: a.name })) }
}

/** The sessions of a hold's agent: by its id, else by its name (the agent named so now, and records that kept the name). */
function sessionsOf(p: AgentSessions, who: { agent?: string; name: string }): SessionSlice[] {
  const name = who.name.toLowerCase()
  const ids = new Set(who.agent ? [who.agent] : p.agents.filter((a) => a.name.toLowerCase() === name).map((a) => a.id))
  return p.list.filter((s) => (s.agentId ? ids.has(s.agentId) : !who.agent && s.agentName?.toLowerCase() === name)).map((s) => s.slice)
}

const holdSpan = (h: TaskHold, now: number): Span => [ms(h.from, now), ms(h.to, now)]

/** What some sessions used in spans of time, summed. */
function usedIn(list: SessionSlice[], spans: Span[]): CostPart {
  const out = emptyPart()
  for (const s of list) {
    const part = sliceSession(s, spans, config.settings)
    if (part) addPart(out, part)
  }
  return out
}

/** A card's holds: kept on it, or (a card no change has saved since #602) from its history. */
const holdsOfCard = (c: TaskCard): TaskHold[] => c.held ?? holdsFromHistory(c)

/** Reads the projects' sessions once each, by the project's folder name. */
async function sessionReader(ws: WorkspaceService): Promise<(project: string) => Promise<AgentSessions | null>> {
  const paths = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  const cache = new Map<string, Promise<AgentSessions | null>>()
  return (project) => {
    const key = project.toLowerCase()
    if (!cache.has(key)) {
      const path = paths.find((p) => basename(p).toLowerCase() === key)
      cache.set(key, path ? projectSessions(ws, path).catch(() => null) : Promise.resolve(null))
    }
    return cache.get(key)!
  }
}

function costOf(card: TaskCard, p: AgentSessions | null, now: number): CardCost {
  const build = emptyPart()
  const review = emptyPart()
  let unmatched = 0
  let last: number | null = null
  const holds = holdsOfCard(card)
  // One agent's holds in a role together, so time it held the card twice over isn't counted twice.
  const groups = new Map<string, { who: TaskHold; spans: Span[] }>()
  for (const h of holds) {
    const key = `${h.role} ${h.agent ?? `name:${h.name.toLowerCase()}`}`
    const g = groups.get(key) ?? { who: h, spans: [] }
    g.spans.push(holdSpan(h, now))
    groups.set(key, g)
    last = Math.max(last ?? 0, ms(h.to, now))
  }
  for (const g of groups.values()) {
    const list = p ? sessionsOf(p, g.who) : []
    const spans = mergeSpans(g.spans)
    if (!list.length) {
      // No session Hive knows of for this agent: what it used is unknown, never $0.
      if (spans.length) {
        unmatched++
        addPart(g.who.role === 'build' ? build : review, { ...emptyPart(), unpriced: 1 })
      }
      continue
    }
    addPart(g.who.role === 'build' ? build : review, usedIn(list, spans))
  }
  return {
    number: card.number,
    title: card.title,
    project: card.project,
    column: card.column,
    rounds: cardRounds(card),
    build: roundPart(build),
    review: roundPart(review),
    total: roundPart(addPart(addPart(emptyPart(), build), review)),
    lastHeld: last === null ? null : new Date(last).toISOString(),
    unmatched
  }
}

/**
 * Each card's cost: the cards named (`numbers`), or every card of a project (or the workspace's) held at some time in
 * [from, to). Archived cards count; a card nobody held has none.
 */
export async function cardCosts(ws: WorkspaceService, o: { numbers?: number[]; project?: string | null; from?: number; to?: number } = {}): Promise<CardCost[]> {
  return inWorkspace(ws, async () => {
    const now = Date.now()
    const want = o.numbers ? new Set(o.numbers) : null
    const cards = (await allTasks(ws)).filter((c) => (want ? want.has(c.number) : !o.project || c.project.toLowerCase() === o.project.toLowerCase()))
    const read = await sessionReader(ws)
    const out: CardCost[] = []
    for (const c of cards) {
      const holds = holdsOfCard(c)
      if (!holds.length) continue
      if (!want && (o.from !== undefined || o.to !== undefined)) {
        const from = o.from ?? 0
        const to = o.to ?? now
        if (!holds.some((h) => ms(h.from, now) < to && ms(h.to, now) >= from)) continue
      }
      out.push(costOf(c, c.project ? await read(c.project) : null, now))
    }
    return out
  })
}

/**
 * Each lane's cost (`ids`, or every lane listed): what its builder and reviewer used from its start to its end (or now),
 * split into the time they held a card and the rest, its overhead.
 */
export async function laneCosts(ws: WorkspaceService, ids?: string[]): Promise<LaneCost[]> {
  return inWorkspace(ws, async () => {
    const now = Date.now()
    const lanes = (await listLanes(ws, { all: !!ids })).filter((l) => !ids || ids.includes(l.id))
    if (!lanes.length) return []
    const cards = await allTasks(ws)
    const read = await sessionReader(ws)
    const out: LaneCost[] = []
    for (const l of lanes) {
      const p = await read(l.project)
      const window: Span[] = [[ms(l.startedAt, now), ms(l.endedAt, now)]]
      const total = emptyPart()
      const onCards = emptyPart()
      const overhead = emptyPart()
      for (const a of [l.builder, ...(l.reviewer ? [l.reviewer] : [])]) {
        const list = p ? sessionsOf(p, { agent: a.id, name: a.name }) : []
        if (!list.length) {
          addPart(total, { ...emptyPart(), unpriced: 1 })
          continue
        }
        // Every card this agent held (the lane's or not), within the lane's time.
        const held = mergeSpans(
          cards
            .filter((c) => c.project.toLowerCase() === l.project.toLowerCase())
            .flatMap(holdsOfCard)
            .filter((h) => (h.agent ? h.agent === a.id : h.name.toLowerCase() === a.name.toLowerCase()))
            .map((h) => holdSpan(h, now))
        )
        const inLane = subtractSpans(window, subtractSpans(window, held))
        const free = subtractSpans(window, held)
        addPart(total, usedIn(list, window))
        addPart(onCards, usedIn(list, inLane))
        addPart(overhead, usedIn(list, free))
      }
      const finished = l.cards.filter((c) => c.column === 'passed' || c.column === 'done').length
      out.push({ id: l.id, total: roundPart(total), onCards: roundPart(onCards), overhead: roundPart(overhead), finished })
    }
    return out
  })
}
