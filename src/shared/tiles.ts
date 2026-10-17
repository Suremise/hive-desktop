import { AGENT_STATES, type AgentState } from './agentState'
import type { TileOrder } from './types'

/**
 * The Session tab's Tiles view (#976): a tile per agent, 12 to a page (at least 12 agents on one page; the most a project
 * has, 24, on two), in the order Settings → Sessions → Tile order chooses.
 */
export const TILES_PER_PAGE = 12

/** The tiles that stand out (their border and mark), and that the page control counts on other pages: waiting for you or stalled. */
export const isUrgent = (s: AgentState): boolean => s === 'waiting' || s === 'stalled'

/**
 * The agents' order in the Tiles view, as indexes into them: the panes' own ('panes': lanes stay lined up, and reordering
 * one reorders the other), or by urgency ('urgency': waiting, stalled, working, idle; the panes' order within a state).
 */
export function tileOrder(states: readonly AgentState[], order: TileOrder): number[] {
  const all = states.map((_, i) => i)
  return order === 'urgency' ? all.sort((x, y) => AGENT_STATES.indexOf(states[x]) - AGENT_STATES.indexOf(states[y]) || x - y) : all
}

/** How many pages of tiles `count` agents take (at least one). */
export const tilePageCount = (count: number): number => Math.max(1, Math.ceil(count / TILES_PER_PAGE))

/** A page the view can show: the one asked for, or the last there is (agents removed meanwhile). */
export const tilePageShown = (page: number, count: number): number => Math.max(0, Math.min(Math.floor(page) || 0, tilePageCount(count) - 1))

/** The tiles of one page, from the agents in tile order. */
export const tilesOnPage = <T>(ordered: readonly T[], page: number): T[] => ordered.slice(page * TILES_PER_PAGE, (page + 1) * TILES_PER_PAGE)

/** The page a tile is on, by its place in tile order. */
export const tilePageOf = (index: number): number => Math.max(0, Math.floor(index / TILES_PER_PAGE))

/** How many urgent tiles each page has, from the states in tile order: the count on the page control. */
export function urgentByPage(ordered: readonly AgentState[]): number[] {
  return Array.from({ length: tilePageCount(ordered.length) }, (_, p) => tilesOnPage(ordered, p).filter(isUrgent).length)
}

/**
 * The start of an agent's latest reply as a tile shows it (two lines): its first lines with Markdown's headings, bold and
 * code marks taken out and whitespace run together, cut short.
 */
export const REPLY_START_MAX = 300

export function replyStart(text: string | null | undefined): string | undefined {
  const flat = (text ?? '')
    .slice(0, REPLY_START_MAX * 4)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return undefined
  return flat.length > REPLY_START_MAX ? `${flat.slice(0, REPLY_START_MAX - 1).trimEnd()}…` : flat
}
