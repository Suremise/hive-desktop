// The scenario harness (tests/scenarios) must count only what happened:
// - a skill read is a successful read that shows the skill (Claude Code's Skill tool, or a read whose result is that
//   skill's own text, as Codex reads one), never a write to its path, a mention, or a failed read;
// - hive tool calls are the ones the server ran (its test log), while names in a transcript or a script (which may
//   not have run) are only mentions.
// The fixtures' checks fail when nothing was done, a call failed, or the steps came in the wrong order.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { tempDir } from './tempDir'

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

  it("counts a Codex code-mode script whose result carries the skill JSON-escaped, but not one that only names the path", () => {
    // As GPT-6.1-Sol reads skills: exec_command's result object printed by text(), the file in "output" with \r\n escaped.
    const sol = (cmd: string, output: string) =>
      tool('Script', `text(await tools.exec_command({cmd:"${cmd}",max_output_tokens:6000}));`, `Script completed\nWall time 0.5 seconds\nOutput:\n\nWarning: truncated output (original token count: 10719)\nTotal output lines: 2\n\n${JSON.stringify({ chunk_id: '187d35', exit_code: 0, output })}`)
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const read = observeTranscript([sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf(SKILL_TEXT('work-on-card')))], SKILLS)
    expect(read.skillsRead).toEqual(['work-on-card'])
    // Escaped twice (a result nested in another JSON string), and a quoted name, count too.
    const nested = tool('Script', 'text(await tools.exec_command({cmd:"Get-Content .agents/skills/hive-handover/SKILL.md"}))', JSON.stringify({ result: JSON.stringify({ output: crlf(SKILL_TEXT('"handover"')) }) }))
    expect(observeTranscript([nested], SKILLS).skillsRead).toEqual(['handover'])

    const notRead = observeTranscript(
      [
        // The path, echoed back escaped, but no name line.
        sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf("Get-Content : Cannot find path '.agents\\skills\\hive-work-on-card\\SKILL.md'\nbecause it does not exist.")),
        // Another skill's text under this skill's path.
        sol('Get-Content .agents/skills/hive-review-agent-work/SKILL.md', crlf(SKILL_TEXT('handover'))),
        // A skill's name line in a result, but no read of its SKILL.md.
        sol('Get-ChildItem .agents/skills', crlf(SKILL_TEXT('handover')))
      ],
      SKILLS
    )
    expect(notRead.skillsRead).toEqual([])
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
    const repo = tempDir('hive-fingerprint-')
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
  it('merge-main-moved (#306): merging without taking the moved base in, or without checking it again, fails', async () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    const repo = tempDir('hive-merge-moved-')
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
    const ctx: Record<string, unknown> & { merge?: { base: string; moved: string } } = {
      git,
      write: (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text),
      read: (rel: string) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null)
    }
    try {
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      const sc = scenario('merge-main-moved') as unknown as { setup: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
      await sc.setup(ctx)
      const into = ctx.merge!.base
      const o = { ...base, skillsRead: ['merge-ready'] }
      const MERGED = 'the branch is merged into the base'
      const REMERGED = 'it merged the moved base into the branch first'
      const CHECKED = 'the exact tip it merged was checked before merging, against the base as it was then'
      const check = () => execFileSync(process.execPath, ['check.js'], { cwd: repo })
      const start = { base: git('rev-parse', into).trim(), feature: git('rev-parse', 'feature').trim(), runs: fs.readFileSync(path.join(repo, 'check-runs.txt'), 'utf8') }
      /** Back to the scenario's start: the base moved, feature as checked, only the old check run. */
      const reset = () => {
        git('checkout', '-q', into)
        git('reset', '-q', '--hard', start.base)
        git('branch', '-f', 'feature', start.feature)
        fs.writeFileSync(path.join(repo, 'check-runs.txt'), start.runs)
      }
      const remerge = () => {
        git('checkout', '-q', 'feature')
        git('merge', '-q', '--no-edit', into)
      }
      const merge = (ff = false) => {
        git('checkout', '-q', into)
        git('merge', '-q', ff ? '--ff-only' : '--no-ff', '--no-edit', 'feature')
      }
      // Nothing done.
      expect(failed(sc.expect(o, ctx))).toEqual([MERGED, REMERGED, CHECKED])
      // Merged as it was checked: the moved base never went through the checks with it.
      merge()
      expect(failed(sc.expect(o, ctx))).toEqual([REMERGED, CHECKED])
      // The base merged into the branch again, but not checked again.
      reset()
      remerge()
      merge()
      expect(failed(sc.expect(o, ctx))).toEqual([CHECKED])
      // Checked only after the merge, on the base (round 1's false pass) or on the branch: not what was merged, then.
      check()
      git('checkout', '-q', 'feature')
      check()
      git('checkout', '-q', into)
      expect(failed(sc.expect(o, ctx))).toEqual([CHECKED])
      // Checked, then another commit on the branch, and merged: that commit was never checked.
      reset()
      remerge()
      check()
      fs.writeFileSync(path.join(repo, 'late.js'), 'late\n')
      git('add', '-A')
      git('commit', '-qm', 'late')
      merge()
      expect(failed(sc.expect(o, ctx))).toEqual([CHECKED])
      // Checked, then the base moved again before the merge: checked against an older base.
      reset()
      remerge()
      check()
      git('checkout', '-q', into)
      fs.writeFileSync(path.join(repo, 'again.js'), 'again\n')
      git('add', '-A')
      git('commit', '-qm', 'again')
      merge()
      expect(failed(sc.expect(o, ctx))).toEqual([CHECKED])
      // Right: the moved base merged in, the exact tip checked, then merged (a merge commit, or a fast-forward).
      for (const ff of [false, true]) {
        reset()
        remerge()
        check()
        merge(ff)
        expect(failed(sc.expect(o, ctx)), ff ? 'fast-forward' : 'merge commit').toEqual([])
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

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
    const ctx = { read: () => null, cards: { i: 7 } }
    const waited = 'then followed it with a wait or a watch (hive_wait_for_agents, or hive_wait_for_tasks on its card), which worked'
    const run = (hiveCalls: unknown[], cards = { i: { column: 'todo' } }) => failed(scenario('assistant-dispatch').expect({ ...base, skillsRead: ['coordinate-agents'], hiveMentions: ['hive_start_task', 'hive_wait_for_agents'], hiveCalls, cards }, ctx))
    expect(run([])).toEqual(expect.arrayContaining(['started the card with hive_start_task, which worked', waited, 'the agent did it: the card is in Review and the file is there']))
    expect(run([{ tool: 'hive_start_task', ok: false }, { tool: 'hive_wait_for_agents', ok: true }])).toContain('started the card with hive_start_task, which worked')
    expect(run([{ tool: 'hive_wait_for_agents', ok: true }, { tool: 'hive_start_task', ok: true }])).toContain(waited)
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_agents', ok: true }])).toEqual(['the agent did it: the card is in Review and the file is there'])
    // A card watch on the card it started counts (#416); one on another card doesn't.
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[7],"wake":true}' }])).toEqual(['the agent did it: the card is in Review and the file is there'])
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[8],"wake":true}' }])).toContain(waited)
  })
})

// A model trial the environment stops is skipped at once (#302): Hive waiting for a sign-in, or the CLI's own notes
// matched with the e2e runner's list (lib.cjs), never the prompt.
describe('a trial the environment stops (trialEnvironment)', () => {
  const { trialEnvironment, environmentAdvice } = require('./scenarios/harness.cjs') as {
    trialEnvironment: (o: { status?: string | null; replies?: string[]; screen?: string }) => string | null
    environmentAdvice: (why: string, provider: string) => string
  }

  it("Claude Code's expired sign-in is an environment skip", () => {
    const why = trialEnvironment({ status: 'finished', replies: ['Login expired · Please run /login'] })
    expect(why).toMatch(/^not signed in: /)
    expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
  })

  it('so is a usage limit, and Hive showing the session waiting for a sign-in', () => {
    const why = trialEnvironment({ replies: ["You've hit your usage limit · resets 5pm (Europe/London)"] })
    expect(why).toMatch(/^usage or rate limit: /)
    expect(environmentAdvice(why!, 'claude-code')).toBe('run them again once the limit has reset')
    expect(trialEnvironment({ status: 'signin' })).toMatch(/^not signed in/)
  })

  it('a sign-in screen before anything was typed', () => {
    expect(trialEnvironment({ status: 'starting', screen: 'Welcome to Claude Code Select login method: 1. Claude account' })).toMatch(/^not signed in/)
  })

  it('a trial that works is not', () => {
    expect(trialEnvironment({ status: 'working', replies: ['Interrupted by you'] })).toBeNull()
    expect(trialEnvironment({})).toBeNull()
  })
})
