// Sub-sessions (#239): sessions a CLI started for another one, read from the transcript's first line by the provider's
// adapter. The first lines below are recorded from real transcripts (Codex 0.13x rollouts, a Claude Code transcript),
// with their long and personal fields (base_instructions, paths, account ids) shortened or replaced.
import { describe, expect, it } from 'vitest'
import { rolloutSubSession } from '../src/main/providers/codex/rollout'
import { SidechainFilter, transcriptSubSession } from '../src/main/providers/claude/usage'

const meta = (payload: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify({ type: 'session_meta', payload })).payload

// A guardian review: Codex judging an action's risk in Approve for me.
const GUARDIAN = meta({
  id: '01a0f3a3-dbe4-7012-9cb6-1603c3fab5b8',
  session_id: '01a0f24c-0627-7111-986a-22f2390ddfdb',
  parent_thread_id: '01a0f24c-0627-7111-986a-22f2390ddfdb',
  timestamp: '2026-10-04T09:12:44.123Z',
  cwd: 'D:\\work\\project',
  originator: 'codex-tui',
  cli_version: '0.135.0',
  source: { subagent: { other: 'guardian' } },
  thread_source: 'guardian_review',
  multi_agent_version: 'disabled',
  subagent_history_start_ordinal: 2,
  model_provider: 'openai',
  history_mode: 'full',
  base_instructions: { text: 'You are judging…' }
})
// An older guardian review: no history ordinal.
const GUARDIAN_OLD = meta({ ...GUARDIAN, subagent_history_start_ordinal: undefined })
// A conversation of its own, started in the terminal or VS Code.
const CLI = meta({ id: '01a0f24c-0627-7111-986a-22f2390ddfdb', session_id: '01a0f24c-0627-7111-986a-22f2390ddfdb', timestamp: '2026-10-04T09:00:00.000Z', cwd: 'D:\\work\\project', originator: 'codex-tui', cli_version: '0.135.0', source: 'cli', thread_source: 'user', model_provider: 'openai' })
const VSCODE = meta({ ...CLI, source: 'vscode' })
// Before thread_source existed: no source detail at all.
const OLD = meta({ id: '0199a0b1-1111-7222-8333-444455556666', timestamp: '2025-09-01T10:00:00.000Z', cwd: 'D:\\work\\project', originator: 'codex_cli_rs', cli_version: '0.40.0' })

describe('Codex sub-sessions (rollout first line)', () => {
  it('a guardian review is a sub-session of the session that started it', () => {
    expect(rolloutSubSession(GUARDIAN)).toEqual({ parentId: '01a0f24c-0627-7111-986a-22f2390ddfdb', kind: 'guardian review' })
    expect(rolloutSubSession(GUARDIAN_OLD)).toEqual({ parentId: '01a0f24c-0627-7111-986a-22f2390ddfdb', kind: 'guardian review' })
  })
  it('a normal rollout is a conversation', () => {
    expect(rolloutSubSession(CLI)).toBeNull()
    expect(rolloutSubSession(VSCODE)).toBeNull()
    expect(rolloutSubSession(OLD)).toBeNull()
  })
  it('another sub-agent is named from its source; one without a parent is still a sub-session', () => {
    expect(rolloutSubSession({ ...CLI, source: { subagent: 'review' }, thread_source: 'subagent', parent_thread_id: GUARDIAN.session_id })).toEqual({ parentId: GUARDIAN.session_id, kind: 'review' })
    expect(rolloutSubSession({ ...CLI, source: { subagent: { other: 'code_explorer' } }, thread_source: 'subagent' })).toEqual({ parentId: null, kind: 'code explorer' })
    expect(rolloutSubSession({ ...CLI, thread_source: 'spawned' })).toEqual({ parentId: null, kind: 'sub-agent' })
  })
  it("a parent that isn't a session id is left out", () => {
    expect(rolloutSubSession({ ...GUARDIAN, parent_thread_id: '../../x' })).toEqual({ parentId: null, kind: 'guardian review' })
    expect(rolloutSubSession({})).toBeNull()
  })
})

describe('Claude Code sub-sessions (transcript first line)', () => {
  const id = 'b3c1d2e4-5f60-4718-8a9b-0c1d2e3f4a5b'
  const parent = '7e2f9a10-3b4c-4d5e-8f60-718293a4b5c6'
  it('a conversation is not a sub-session', () => {
    const user = JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: 'D:\\work\\project', sessionId: id, version: '2.1.287', gitBranch: 'main', type: 'user', message: { role: 'user', content: 'Fix the tray icon' }, uuid: 'u1', timestamp: '2026-10-04T09:00:00.000Z' })
    expect(transcriptSubSession(user, id)).toBeNull()
    expect(transcriptSubSession(JSON.stringify({ type: 'summary', summary: 'Tray icon fix', leafUuid: 'u9' }), id)).toBeNull()
    expect(transcriptSubSession(JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} }), id)).toBeNull()
    expect(transcriptSubSession('', id)).toBeNull()
    expect(transcriptSubSession('{not json', id)).toBeNull()
  })
  it("a sub-agent's transcript names the session that started it", () => {
    const side = JSON.stringify({ parentUuid: null, isSidechain: true, userType: 'external', cwd: 'D:\\work\\project', sessionId: parent, agentId: 'a1b2c3', type: 'user', message: { role: 'user', content: 'Search the code' }, uuid: 's1', timestamp: '2026-10-04T09:01:00.000Z' })
    expect(transcriptSubSession(side, id)).toEqual({ parentId: parent, kind: 'sub-agent' })
    expect(transcriptSubSession(JSON.stringify({ isSidechain: true, sessionId: id }), id)).toEqual({ parentId: null, kind: 'sub-agent' })
  })
})

describe("Claude Code sidechain entries: a sub-agent's work in a conversation, or a sub-agent's own transcript", () => {
  const user = (text: string, side: boolean) => ({ type: 'user', isSidechain: side, timestamp: '2026-10-04T09:00:00.000Z', message: { role: 'user', content: text } })
  it('in a conversation, sub-agent entries are left out (its own transcript has them)', () => {
    const f = new SidechainFilter()
    expect([user('Fix it', false), user('Search the code', true), user('Thanks', false)].map((o) => f.skip(o))).toEqual([false, true, false])
  })
  it("in a sub-agent's own transcript (its first message is a sidechain one), nothing is", () => {
    const f = new SidechainFilter()
    expect([{ type: 'summary' }, user('Search the code', true), user('More', true)].map((o) => f.skip(o))).toEqual([false, false, false])
  })
})
