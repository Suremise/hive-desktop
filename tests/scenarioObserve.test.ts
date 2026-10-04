// The scenario harness (tests/scenarios) must count only what happened:
// - a skill read is a successful read that shows the skill (Claude Code's Skill tool, or a read whose result is that
//   skill's own text, as Codex reads one), never a write to its path, a mention, or a failed read;
// - hive tool calls are the ones the server ran (its test log), while names in a transcript or a script (which may
//   not have run) are only mentions.
// The fixtures' checks fail when nothing was done, a call failed, or the steps came in the wrong order.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { observeTranscript } = require('./scenarios/harness.cjs') as { observeTranscript: (items: unknown[], skills: string[]) => { skillsRead: string[]; hiveMentions: string[]; finalReply: string } }
const { SCENARIOS } = require('./scenarios/scenarios.cjs') as { SCENARIOS: { id: string; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }[] }

const tool = (name: string, input: unknown, result = '', isError = false) => ({ kind: 'tool', tool: { name, summary: '', input: typeof input === 'string' ? input : JSON.stringify(input), result, isError } })
const SKILLS = ['work-on-card', 'review-agent-work', 'handover']
const SKILL_TEXT = (n: string) => `---\nname: ${n}\ndescription: …\n---\n\n# Body`

describe('skills read', () => {
  it("counts Claude Code's Skill tool, and a read whose result is the skill's own text", () => {
    const script = "const r = await tools.exec_command({cmd:\"Get-Content -Raw '.agents\\\\skills\\\\hive-review-agent-work\\\\SKILL.md'\"}); text(r)"
    const o = observeTranscript(
      [
        tool('Skill', { skill: 'hive:work-on-card' }, 'Launching skill: hive:work-on-card'),
        tool('Script', script, SKILL_TEXT('review-agent-work')),
        tool('Read', { file_path: 'C:\\w\\.hive\\launch-a\\plugin\\skills\\handover\\SKILL.md' }, `1\t---\n2\tname: handover\n3\tdescription: x`),
        { kind: 'assistant', text: 'Done.' }
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual(['work-on-card', 'review-agent-work', 'handover'])
    expect(o.finalReply).toBe('Done.')
  })

  it("doesn't count a write to a skill's path, a mention of it, a failed read, or a read of something else", () => {
    const o = observeTranscript(
      [
        tool('Write', { file_path: '.agents/skills/hive-work-on-card/SKILL.md', content: SKILL_TEXT('work-on-card') }, 'File created successfully'),
        tool('Bash', { command: 'echo .agents/skills/hive-work-on-card/SKILL.md' }, '.agents/skills/hive-work-on-card/SKILL.md'),
        tool('Skill', { skill: 'hive:handover' }, 'Unknown skill', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'File does not exist.', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'some other text without its name')
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual([])
  })
})

describe('hive tools named in a transcript are mentions, not calls', () => {
  it('lists names from direct calls and from scripts, including ones a script never reaches', () => {
    const o = observeTranscript(
      [tool('mcp__hive__hive_update_task', { number: 3 }), tool('hive · hive_reorder_tasks', 'column: todo'), tool('Script', 'if (false) { await tools.mcp__hive__hive_wait_for_agents({}); }')],
      SKILLS
    )
    expect(o.hiveMentions).toEqual(['hive_update_task', 'hive_reorder_tasks', 'hive_wait_for_agents'])
    expect('hiveCalls' in o).toBe(false)
  })
})

describe("a run's source fingerprint", () => {
  const { sourceFingerprint } = require('./scenarios/harness.cjs') as { sourceFingerprint: (root: string) => { head: string; dirty: string | null } }
  const fs = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { execFileSync } = require('child_process') as typeof import('child_process')

  it("changes with an untracked file's contents, a tracked change and a new file, not with an ignored one", () => {
    const repo = fs.mkdtempSync(join(require('os').tmpdir(), 'hive-fingerprint-'))
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repo })
    fs.writeFileSync(join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'init')
    expect(sourceFingerprint(repo).dirty).toBeNull()
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version A')
    const a = sourceFingerprint(repo)
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version B')
    const b = sourceFingerprint(repo)
    expect(a.head).toBe(b.head)
    expect(a.dirty).not.toBeNull()
    expect(b.dirty).not.toBe(a.dirty)
    fs.writeFileSync(join(repo, 'ignored.txt'), 'anything')
    expect(sourceFingerprint(repo).dirty).toBe(b.dirty)
    fs.writeFileSync(join(repo, 'a.txt'), 'two\n')
    expect(sourceFingerprint(repo).dirty).not.toBe(b.dirty)
    fs.rmSync(repo, { recursive: true, force: true })
  })
})

describe('the fixtures fail when nothing was done', () => {
  const base = { skillsRead: [] as string[], hiveCalls: [] as unknown[], hiveMentions: [], tools: [] as { name: string; input: string; result: string; isError: boolean }[], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], gitStatus: '', live: [], tokenLeak: false }
  const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
  const failed = (checks: [string, boolean, string?][]) => checks.filter(([, ok]) => !ok).map(([n]) => n)

  it('raw-api: a script that only names the token, never run, passes nothing about running or scope', () => {
    const ctx = { read: (f: string) => (f === 'scripts/cards.ps1' ? '# HIVE_API_TOKEN_FILE\n# no HTTP call' : null) }
    const checks = scenario('raw-api').expect({ ...base, skillsRead: ['use-hive-api'] }, ctx)
    expect(failed(checks)).toEqual(expect.arrayContaining(['it ran, and listed its own card', "it didn't get beta's card, and Hive refused it"]))
    // A run that printed the token fails too.
    expect(failed(scenario('raw-api').expect({ ...base, tokenLeak: true }, ctx))).toContain('no token was printed or said')
  })

  it('assistant-dispatch: names alone, failed calls, or a wait before the start, and a card never finished, all fail', () => {
    const ctx = { read: () => null }
    const run = (hiveCalls: unknown[], cards = { i: { column: 'todo' } }) => failed(scenario('assistant-dispatch').expect({ ...base, skillsRead: ['coordinate-agents'], hiveMentions: ['hive_start_task', 'hive_wait_for_agents'], hiveCalls, cards }, ctx))
    expect(run([])).toEqual(expect.arrayContaining(['started the card with hive_start_task, which worked', 'then waited with hive_wait_for_agents, which worked', 'the agent did it: the card is in Review and the file is there']))
    expect(run([{ tool: 'hive_start_task', ok: false }, { tool: 'hive_wait_for_agents', ok: true }])).toContain('started the card with hive_start_task, which worked')
    expect(run([{ tool: 'hive_wait_for_agents', ok: true }, { tool: 'hive_start_task', ok: true }])).toContain('then waited with hive_wait_for_agents, which worked')
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_agents', ok: true }])).toEqual(['the agent did it: the card is in Review and the file is there'])
  })
})
