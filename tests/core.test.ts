import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeProjectPath, parseTranscript, recacheEstimate } from '../src/main/agents/transcript'
import { parseSkillFrontmatter } from '../src/main/skills'
import { findSecretWarnings, toLaunchDef } from '../src/main/mcp'
import { splitArgs } from '../src/main/fsutil'
import { compactThreshold, DEFAULT_APP_CONFIG, DEFAULT_SETTINGS, effectiveModelLabel, mergeDefaults, migrateConfig, modelLabel } from '../src/shared/defaults'

const line = (o: unknown): string => JSON.stringify(o)

describe('encodeProjectPath', () => {
  it('matches Claude Code folder naming', () => {
    expect(encodeProjectPath('d:\\Code\\workspace\\hive')).toBe('d--Code-workspace-hive')
    expect(encodeProjectPath('/home/me/my.project')).toBe('-home-me-my-project')
  })
})

describe('parseTranscript', () => {
  const usage = (input: number, read: number, write: number, output: number, oneHour = true) => ({
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    output_tokens: output,
    cache_creation: oneHour ? { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write }
  })
  const transcript = [
    line({ type: 'user', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'hello' }, version: '2.1.283' }),
    // one request written as two content-block entries with the same usage — must be counted once
    line({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-28T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: usage(10, 0, 5000, 100) } }),
    line({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-28T10:00:06.000Z', message: { model: 'claude-opus-5-5', usage: usage(10, 0, 5000, 120) } }),
    line({ type: 'assistant', requestId: 'r2', timestamp: '2026-09-28T10:01:00.000Z', message: { model: 'claude-opus-5-5', usage: usage(2, 5000, 300, 50) } }),
    'not json',
    line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-28T10:02:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 15000 } }),
    line({ type: 'ai-title', aiTitle: 'Fix login bug' }),
    line({ type: 'last-prompt', lastPrompt: 'run the tests' }),
    line({ type: 'unknown-future-entry', foo: 1 })
  ].join('\n')

  const u = parseTranscript(transcript, 'abc')

  it('counts each request once using its final usage', () => {
    expect(u.requests).toBe(2)
    expect(u.outputTokens).toBe(120 + 50)
    expect(u.inputTokens).toBe(12)
    expect(u.cacheWriteTokens).toBe(5300)
    expect(u.cacheReadTokens).toBe(5000)
  })

  it('uses post-compaction size as the current context', () => {
    expect(u.compactions).toEqual([{ timestamp: '2026-09-28T10:02:00.000Z', trigger: 'auto', preTokens: 900000, postTokens: 15000 }])
    expect(u.contextTokens).toBe(15000)
  })

  it('reads metadata', () => {
    expect(u.title).toBe('Fix login bug')
    expect(u.model).toBe('claude-opus-5-5')
    expect(u.cliVersion).toBe('2.1.283')
    expect(u.lastPrompt).toBe('run the tests')
    expect(u.userMessages).toBe(1)
    expect(u.cacheTtlSeconds).toBe(3600)
    expect(u.lastActivity).toBe('2026-09-28T10:02:00.000Z')
  })

  it('detects the 5-minute cache', () => {
    const t = line({ type: 'assistant', requestId: 'x', timestamp: '2026-09-28T10:00:00Z', message: { usage: usage(1, 0, 100, 1, false) } })
    expect(parseTranscript(t, 'x').cacheTtlSeconds).toBe(300)
  })

  it('custom titles win over AI titles', () => {
    const t = [line({ type: 'ai-title', aiTitle: 'AI' }), line({ type: 'custom-title', customTitle: 'Mine' })].join('\n')
    expect(parseTranscript(t, 'x').title).toBe('Mine')
  })
})

describe('recacheEstimate', () => {
  const base = parseTranscript(line({ type: 'assistant', requestId: 'a', timestamp: '2026-09-28T10:00:00.000Z', message: { usage: { input_tokens: 5, cache_read_input_tokens: 80000, cache_creation_input_tokens: 1000, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1000 } } } }), 'a')

  it('is warm within the TTL', () => {
    const r = recacheEstimate(base, 'auto', Date.parse('2026-09-28T10:03:00.000Z'))
    expect(r.warm).toBe(true)
    expect(r.secondsLeft).toBe(120)
    expect(r.tokens).toBe(81005)
  })

  it('expires after the TTL and honours overrides', () => {
    expect(recacheEstimate(base, 'auto', Date.parse('2026-09-28T10:06:00.000Z')).warm).toBe(false)
    expect(recacheEstimate(base, '1h', Date.parse('2026-09-28T10:06:00.000Z')).warm).toBe(true)
  })
})

describe('parseSkillFrontmatter', () => {
  it('reads simple and block values', () => {
    expect(parseSkillFrontmatter('---\nname: my-skill\ndescription: "Does things"\n---\nbody')).toEqual({ name: 'my-skill', description: 'Does things' })
    expect(parseSkillFrontmatter('---\r\nname: x\r\ndescription: >\r\n  line one\r\n  line two\r\n---\r\n')).toEqual({ name: 'x', description: 'line one line two' })
    expect(parseSkillFrontmatter('# no frontmatter')).toEqual({})
  })
})

describe('MCP definitions', () => {
  it('flags literal secrets but not env references', () => {
    expect(findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } })).toHaveLength(0)
    expect(findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } })).toHaveLength(1)
    expect(findSecretWarnings({ command: 'x', env: { API_KEY: 'supersecretvalue' } })).toHaveLength(1)
    expect(findSecretWarnings({ url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } })).toHaveLength(0)
    expect(findSecretWarnings({ command: 'x', args: ['--key', 'sk-ant-12345'] })).toHaveLength(1)
    expect(findSecretWarnings({ command: 'x', env: { LOG_LEVEL: 'debug' } })).toHaveLength(0)
  })

  it('strips description and expands HIVE_MCP_DIR', () => {
    expect(toLaunchDef({ description: 'd', command: 'node', args: ['${HIVE_MCP_DIR}/srv/index.js'] }, 'C:\\ws\\.hive\\mcp')).toEqual({ command: 'node', args: ['C:/ws/.hive/mcp/srv/index.js'] })
  })
})

describe('splitArgs', () => {
  it('honours quotes', () => {
    expect(splitArgs('--add-dir "../my lib" --verbose \'a b\'')).toEqual(['--add-dir', '../my lib', '--verbose', 'a b'])
    expect(splitArgs('   ')).toEqual([])
  })
})

describe('mergeDefaults', () => {
  it('fills new settings and keeps saved ones', () => {
    const merged = mergeDefaults(DEFAULT_SETTINGS, { general: { closeToTray: false }, claude: { defaultModel: 'opus' } })
    expect(merged.general.closeToTray).toBe(false)
    expect(merged.general.confirmOnQuit).toBe('working')
    expect(merged.claude.defaultModel).toBe('opus')
    expect(merged.agentApi.port).toBe(DEFAULT_SETTINGS.agentApi.port)
  })
})

describe('migrateConfig', () => {
  const load = (confirmOnQuit: unknown) =>
    migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), { settings: { general: { confirmOnQuit } } })).settings.general.confirmOnQuit

  it('maps the old on/off quit confirmation', () => {
    expect(load(true)).toBe('working')
    expect(load(false)).toBe('never')
  })
  it('keeps valid choices and repairs unknown ones', () => {
    expect(load('always')).toBe('always')
    expect(load('never')).toBe('never')
    expect(load('sometimes')).toBe('working')
    expect(migrateConfig(structuredClone(DEFAULT_APP_CONFIG)).settings.general.confirmOnQuit).toBe('working')
  })
})

describe('modelLabel', () => {
  it('names aliases and model ids', () => {
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)')
    expect(modelLabel('some-custom-model')).toBe('some-custom-model')
  })
  it('marks inherited models as the default', () => {
    expect(effectiveModelLabel('sonnet', 'opus', 'claude-opus-5-5')).toBe('Sonnet')
    expect(effectiveModelLabel('inherit', 'opus', 'claude-opus-5-5')).toBe('Opus (default)')
    expect(effectiveModelLabel('inherit', '', 'claude-opus-5-5')).toBe('Opus 5.5 (default)')
    expect(effectiveModelLabel('inherit', '', null)).toBe('Claude Code default')
  })
})

describe('compactThreshold', () => {
  it('uses the project value, or inherits the global one', () => {
    expect(compactThreshold({ compactSuggestTokens: null }, 200000)).toBe(200000)
    expect(compactThreshold({ compactSuggestTokens: 50000 }, 200000)).toBe(50000)
    expect(compactThreshold({ compactSuggestTokens: 0 }, 200000)).toBe(0)
    expect(compactThreshold(undefined, 150000)).toBe(150000)
  })
})

describe('sessionStartCommand', () => {
  it('forwards the hook JSON from stdin to the hook server with the token', async () => {
    const { sessionStartCommand } = await import('../src/main/agents/claude-code')
    const cmd = sessionStartCommand('http://127.0.0.1:5000/hook', 'abc123')
    expect(cmd).toContain('--data-binary @-')
    expect(cmd).toContain('"Authorization: Bearer abc123"')
    expect(cmd).toContain('"http://127.0.0.1:5000/hook"')
    expect(cmd).not.toContain('\\')
  })
})

describe('ConversationParser', () => {
  const lines = [
    line({ type: 'user', timestamp: 't0', message: { role: 'user', content: 'Fix the zebra test' } }),
    line({ type: 'assistant', timestamp: 't1', message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }] } }),
    line({ type: 'assistant', timestamp: 't1', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
    line({ type: 'assistant', isSidechain: true, timestamp: 't1', message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'zebra failed', is_error: true }] } }),
    line({ type: 'assistant', timestamp: 't3', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'b', name: 'mcp__hive__hive_notify', input: { message: 'done' } }] } }),
    line({ type: 'user', timestamp: 't4', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } }),
    line({ type: 'user', isMeta: true, timestamp: 't4', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: C:\\p\\.hive\\images\\x.png]' }] } }),
    line({ type: 'user', isMeta: true, timestamp: 't4', message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: 't5', compactMetadata: { trigger: 'manual', preTokens: 100000, postTokens: 5000 } }),
    line({ type: 'user', isCompactSummary: true, timestamp: 't5', message: { role: 'user', content: 'Summary: zebra fixed' } }),
    line({ type: 'user', timestamp: 't5', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args>keep notes</command-args>' } }),
    line({ type: 'user', timestamp: 't5', message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted\u001b[22m</local-command-stdout>' } }),
    line({ type: 'assistant', timestamp: 't6', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'All good.' }], usage: { input_tokens: 1, cache_read_input_tokens: 40000, cache_creation_input_tokens: 99 } } }),
    line({ type: 'user', timestamp: 't7', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
  ]
  const text = lines.join('\n') + '\n'

  it('turns entries into messages, tool calls, commands and compactions', async () => {
    const { ConversationParser } = await import('../src/main/agents/conversation')
    const p = new ConversationParser('C:\\p')
    p.feed(Buffer.from(text))
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'user', 'compaction', 'command', 'assistant', 'notice'])
    const [, bash, mcp, user, compaction, command] = p.items as any[]
    expect(bash.tool).toMatchObject({ name: 'Bash', summary: 'Run tests', input: 'npm test', result: 'zebra failed', isError: true })
    expect(mcp.tool).toMatchObject({ name: 'hive · hive_notify', summary: 'done', result: null })
    expect(user.images).toEqual([{ id: 0, path: 'C:\\p\\.hive\\images\\x.png' }])
    expect(compaction).toMatchObject({ trigger: 'manual', preTokens: 100000, postTokens: 5000, nextRequestTokens: 40100, summary: 'Summary: zebra fixed' })
    expect(command).toMatchObject({ name: '/compact', args: 'keep notes', output: 'Compacted' })
    expect(p.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Interrupted by you' })
    expect(p.images[0].path).toEqual([1])
  })

  it('reads appended bytes and leaves a partial last line for later', async () => {
    const { ConversationParser } = await import('../src/main/agents/conversation')
    const whole = new ConversationParser()
    whole.feed(Buffer.from(text))
    const parts = new ConversationParser()
    const buf = Buffer.from(text)
    const cut = buf.indexOf('zebra failed') // in the middle of a line
    expect(parts.feed(buf.subarray(0, cut))).toBeLessThan(cut)
    parts.feed(buf.subarray(parts.offset))
    expect(parts.offset).toBe(buf.length)
    expect(parts.items).toEqual(whole.items)
    expect(parts.images).toEqual(whole.images)
  })

  it('searches every kind of item and exports Markdown', async () => {
    const { ConversationParser, searchItems, transcriptMarkdown } = await import('../src/main/agents/conversation')
    const p = new ConversationParser()
    p.feed(Buffer.from(text))
    const { hits, more } = searchItems(p.items, 'ZEBRA')
    expect(hits.map((h) => h.kind)).toEqual(['user', 'tool', 'compaction'])
    expect(more).toBe(false)
    expect(searchItems(p.items, 'zebra', 1)).toMatchObject({ more: true })
    expect(searchItems(p.items, '  ').hits).toEqual([])
    const md = transcriptMarkdown(p.items, 'Zebra', 'sub')
    expect(md).toContain('# Zebra')
    expect(md).toContain('<summary>Bash: Run tests</summary>')
    expect(md).toContain('**Error:**')
    expect(md).toContain('**Conversation compacted** (manual)')
    expect(md).toContain('> `/compact keep notes`')
  })
})

describe('toolSummary', () => {
  it('describes common tools in one line', async () => {
    const { toolSummary } = await import('../src/main/agents/conversation')
    expect(toolSummary('Read', { file_path: 'D:\\proj\\src\\a.ts' }, 'D:\\proj')).toBe('src/a.ts')
    expect(toolSummary('Read', { file_path: 'E:\\other\\a.ts' }, 'D:\\proj')).toBe('E:\\other\\a.ts')
    expect(toolSummary('Grep', { pattern: 'foo', path: 'D:\\proj\\src' }, 'D:\\proj')).toBe('foo in src')
    expect(toolSummary('Bash', { command: 'git status\ngit log' })).toBe('git status')
    expect(toolSummary('Agent', { description: 'Find usages', prompt: 'long' })).toBe('Find usages')
  })
})

describe('model choices', () => {
  it('knows which models have a 1M-context version', async () => {
    const { supportsOneM, withOneM, isOlderModel, baseModel } = await import('../src/shared/defaults')
    expect(supportsOneM('opus')).toBe(true)
    expect(supportsOneM('haiku')).toBe(false)
    expect(supportsOneM('claude-opus-5-5')).toBe(true)
    expect(supportsOneM('claude-opus-4-5')).toBe(false)
    expect(supportsOneM('claude-sonnet-4-5')).toBe(true)
    expect(supportsOneM('claude-haiku-4-5')).toBe(false)
    expect(withOneM('claude-sonnet-5', true)).toBe('claude-sonnet-5[1m]')
    expect(withOneM('claude-sonnet-5[1m]', false)).toBe('claude-sonnet-5')
    expect(withOneM('haiku', true)).toBe('haiku')
    expect(baseModel('opus[1m]')).toBe('opus')
    expect(isOlderModel('claude-opus-4-8[1m]')).toBe(true)
    expect(isOlderModel('claude-opus-5-5')).toBe(false)
  })
  it('labels effort from the session, the project or the default', async () => {
    const { effortLabel } = await import('../src/shared/defaults')
    expect(effortLabel('xhigh', 'low', '')).toBe('Extra high')
    expect(effortLabel(undefined, 'low', 'high')).toBe('Low')
    expect(effortLabel(undefined, 'inherit', 'high')).toBe('High')
    expect(effortLabel(undefined, 'inherit', '')).toBeNull()
  })
})

describe('plan usage', () => {
  it('reads rate limits from the status line payload', async () => {
    const { parsePlanUsage } = await import('../src/main/planUsage')
    const now = new Date('2026-09-29T10:00:00Z')
    const u = parsePlanUsage({ rate_limits: { five_hour: { used_percentage: 34.4, resets_at: 1790000000 }, seven_day: { used_percentage: 12 } } }, now)
    expect(u).toEqual({ fiveHour: { usedPercent: 34.4, resetsAt: new Date(1790000000 * 1000).toISOString() }, sevenDay: { usedPercent: 12, resetsAt: null }, updatedAt: now.toISOString() })
    expect(parsePlanUsage({ model: {} })).toBeNull()
    expect(parsePlanUsage({ rate_limits: { five_hour: { used_percentage: 'x' } } })).toBeNull()
  })
  it('warns once per level per reset period', async () => {
    const { nextWarning } = await import('../src/main/planUsage')
    const r = '2026-09-29T15:00:00.000Z'
    expect(nextWarning({ usedPercent: 50, resetsAt: r }, undefined)).toBeNull()
    expect(nextWarning({ usedPercent: 81, resetsAt: r }, undefined)).toBe(80)
    expect(nextWarning({ usedPercent: 85, resetsAt: r }, { resetsAt: r, level: 80 })).toBeNull()
    expect(nextWarning({ usedPercent: 96, resetsAt: r }, { resetsAt: r, level: 80 })).toBe(95)
    expect(nextWarning({ usedPercent: 99, resetsAt: '2026-09-29T15:00:20.000Z' }, { resetsAt: r, level: 95 })).toBeNull()
    expect(nextWarning({ usedPercent: 82, resetsAt: '2026-09-29T20:00:00.000Z' }, { resetsAt: r, level: 95 })).toBe(80)
  })
})

describe('agents', () => {
  it('always has Agent 1 first, in the project folder', async () => {
    const { projectAgents } = await import('../src/shared/defaults')
    expect(projectAgents({ agents: [] }).map((a) => a.id)).toEqual(['main'])
    const list = projectAgents({ agents: [{ id: 'a2', name: 'Reviewer' }, { id: 'main', name: 'Lead', worktree: { path: 'x', branch: 'b', base: 'main' } }] })
    expect(list.map((a) => a.name)).toEqual(['Lead', 'Reviewer'])
    expect(list[0].worktree).toBeUndefined()
  })

  it('keeps the old terminal key for Agent 1', async () => {
    const { agentPtyKey } = await import('../src/shared/defaults')
    expect(agentPtyKey('D:\\WS\\Demo')).toBe('session:d:\\ws\\demo')
    expect(agentPtyKey('D:\\WS\\Demo', 'a2')).toBe('session:d:\\ws\\demo#a2')
  })

  it('shows the most urgent state in the combined dot', async () => {
    const { mostUrgent } = await import('../src/shared/defaults')
    expect(mostUrgent([])).toBeNull()
    expect(mostUrgent([{ status: 'finished' }, { status: 'working' }, null])!.status).toBe('working')
    expect(mostUrgent([{ status: 'working' }, { status: 'waiting' }])!.status).toBe('waiting')
    // Something unseen on any agent keeps the dot glowing.
    const s = mostUrgent([{ status: 'working', unseen: false }, { status: 'finished', unseen: true }])!
    expect(s.status).toBe('working')
    expect(s.unseen).toBe(true)
  })

  it('slugifies names for branches and folders', async () => {
    const { slugify } = await import('../src/shared/defaults')
    expect(slugify('Agent 2')).toBe('agent-2')
    expect(slugify('  Code Review!! ')).toBe('code-review')
    expect(slugify('***')).toBe('agent')
  })

  it('matches worktree copy patterns', async () => {
    const { copyPatterns } = await import('../src/main/worktrees')
    const rx = copyPatterns('.env*\nconfig/local.json, secrets/**')
    const hit = (p: string): boolean => rx.some((r) => r.test(p))
    expect(hit('.env')).toBe(true)
    expect(hit('.env.local')).toBe(true)
    expect(hit('packages/api/.env')).toBe(true)
    expect(hit('config/local.json')).toBe(true)
    expect(hit('other/config/local.json')).toBe(false)
    expect(hit('secrets/a/b.key')).toBe(true)
    expect(hit('src/env.ts')).toBe(false)
    expect(copyPatterns(' , \n')).toEqual([])
  })

  it('places the worktrees folder next to the workspace', async () => {
    const { worktreesRoot } = await import('../src/main/worktrees')
    expect(worktreesRoot('D:\\Dev\\HIVE')).toBe(join('D:\\Dev', 'HIVE.worktrees'))
  })
})

describe('resumeRecord', () => {
  const P = 'D:\ws\proj'
  const WT = 'D:\ws.worktrees\proj\agent-2'
  const rec = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, lastActiveAt: at, archived: false, ...extra })
  const records = [
    rec('m1', '2026-09-01'),
    rec('m2', '2026-09-03'),
    rec('a3', '2026-09-04', { agentId: 'a3' }),
    rec('w1', '2026-09-05', { agentId: 'a2', cwd: WT }),
    rec('old', '2026-09-06', { archived: true })
  ]
  it("prefers the agent's last session, then its latest", async () => {
    const { resumeRecord } = await import('../src/shared/defaults')
    expect(resumeRecord(P, { id: 'main', lastSessionId: 'm1' }, records, new Set())?.id).toBe('m1')
    expect(resumeRecord(P, { id: 'main' }, records, new Set())?.id).toBe('m2')
    expect(resumeRecord(P, { id: 'a3' }, records, new Set())?.id).toBe('a3')
    expect(resumeRecord(P, { id: 'a4' }, records, new Set())).toBeNull()
  })
  it('skips sessions open in another agent, archived ones and other folders', async () => {
    const { resumeRecord } = await import('../src/shared/defaults')
    expect(resumeRecord(P, { id: 'main', lastSessionId: 'm2' }, records, new Set(['m2']))?.id).toBe('m1')
    expect(resumeRecord(P, { id: 'a4', lastSessionId: 'w1' }, records, new Set())).toBeNull()
    expect(resumeRecord(P, { id: 'a2', worktree: { path: WT, branch: 'hive/agent-2', base: 'main' } }, records, new Set())?.id).toBe('w1')
    expect(resumeRecord(P, { id: 'main', lastSessionId: 'old' }, records, new Set())?.id).toBe('m2')
  })
})

describe('sessionLabel', () => {
  it("uses Claude Code's title while the name is still automatic", async () => {
    const { sessionLabel } = await import('../src/shared/defaults')
    expect(sessionLabel({ id: 'abc12345x', name: 'hive · 29/09/2026, 10:00:00', title: 'Fix the tray' }, 'hive')).toBe('Fix the tray')
    expect(sessionLabel({ id: 'abc12345x', name: 'hive · Agent 2 · 9/29/2026, 10:00 AM', title: 'Docs' }, 'hive')).toBe('Docs')
    expect(sessionLabel({ id: 'abc12345x', name: 'My refactor', title: 'Fix the tray' }, 'hive')).toBe('My refactor')
    expect(sessionLabel({ id: 'abc12345x', name: 'hive · 29/09/2026, 10:00:00', title: null }, 'hive')).toBe('hive · 29/09/2026, 10:00:00')
    expect(sessionLabel({ id: 'abc12345x' }, 'hive')).toBe('Session abc12345')
  })
})

describe('permission modes in a running session', () => {
  it('reads the mode from Claude Code footer output', async () => {
    const { footerMode } = await import('../src/shared/defaults')
    expect(footerMode(' ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents ')).toBe('acceptEdits')
    expect(footerMode('⏸ plan mode on (shift+tab o cycle) · ←foragents')).toBe('plan')
    expect(footerMode('x ⏵⏵ auto mode on (shift+tab to cycle) y ⏸ manual mode on · ← for agents')).toBe('manual')
    expect(footerMode("⏵⏵ don't ask on (shift+tab to cycle)")).toBe('dontAsk')
    expect(footerMode('⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('bypassPermissions')
    expect(footerMode('Claude said: turn plan mode on and then')).toBeNull()
  })
  it('maps hook modes and knows what Shift+Tab can reach', async () => {
    const { hookMode, canSwitchLive } = await import('../src/shared/defaults')
    expect(hookMode('default')).toBe('manual')
    expect(hookMode('acceptEdits')).toBe('acceptEdits')
    expect(hookMode('nonsense')).toBeNull()
    expect(canSwitchLive('auto', 'manual', 'manual')).toBe(true)
    expect(canSwitchLive('dontAsk', 'manual', 'dontAsk')).toBe(false)
    expect(canSwitchLive('bypassPermissions', 'auto', 'manual')).toBe(false)
    expect(canSwitchLive('bypassPermissions', 'auto', 'bypassPermissions')).toBe(true)
  })
})

describe('keyboard shortcuts', () => {
  it('resolves project over global over default, and null removes', async () => {
    const { resolveKeybinding } = await import('../src/shared/defaults')
    expect(resolveKeybinding('a', 'Mod+A', undefined, undefined)).toBe('Mod+A')
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, undefined)).toBe('Mod+B')
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, { a: 'Alt+C' })).toBe('Alt+C')
    expect(resolveKeybinding('a', 'Mod+A', { a: null }, undefined)).toBeUndefined()
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, { a: null })).toBeUndefined()
  })
  it('refuses keys that would break typing or editing', async () => {
    const { keybindingProblem } = await import('../src/shared/defaults')
    expect(keybindingProblem('A')).not.toBeNull()
    expect(keybindingProblem('Shift+A')).not.toBeNull()
    expect(keybindingProblem('Mod+C')).not.toBeNull()
    expect(keybindingProblem('Shift+Tab')).not.toBeNull()
    expect(keybindingProblem('F5')).toBeNull()
    expect(keybindingProblem('Mod+Alt+M')).toBeNull()
    expect(keybindingProblem('Mod+K Mod+S')).toBeNull()
    expect(keybindingProblem('Mod+K S')).not.toBeNull()
  })
})
