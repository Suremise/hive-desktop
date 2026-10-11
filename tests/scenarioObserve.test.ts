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
const { SCENARIOS, helpers } = require('./scenarios/scenarios.cjs') as { SCENARIOS: { id: string; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }[]; helpers: { LANES_RUNNING_TAIL: string } }

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

  it('review-record-trusted (#533): the commands that ran are what count, in every form a tool call has; a review that runs no test fails', () => {
    const sc = scenario('review-record-trusted')
    const whole = "didn't run the whole suite again"
    const affected = 'ran the test the change affects (greet.test.js)'
    const run = (...calls: [string, string][]) => {
      const checks = sc.expect({ ...base, skillsRead: ['review-agent-work'], tools: calls.map(([name, input]) => ({ name, input, result: '', isError: false })) }, {})
      return checks.filter(([n]) => n === whole || n === affected).filter(([, ok]) => !ok).map(([n]) => n)
    }
    // As Hive's transcripts give them: Claude Code's Bash and Codex's shell as the command itself; a Codex script's cmd.
    expect(run(['Bash', 'node --test "greet.test.js"'])).toEqual([])
    expect(run(['Shell', 'node --test .\\greet.test.js'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"git rev-parse --short HEAD; node --test greet.test.js"}))'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({"cmd":"node --test \\"greet.test.js\\""}))'])).toEqual([])
    // And as JSON, should a tool's input come that way: its command only, never its description.
    expect(run(['Bash', JSON.stringify({ command: 'git status --short', description: 'Check the npm test record' })], ['Bash', JSON.stringify({ command: 'node --test "greet.test.js"' })])).toEqual([])
    // The whole suite, however it is run, fails; text that only mentions it (a verdict in a script, a description) doesn't.
    expect(run(['functions.exec_command', JSON.stringify({ cmd: 'npm test' })], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Bash', 'hive-progress --title "Tests" -- npm test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['PowerShell', 'node --test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"npm run test"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.mcp__hive__hive_update_task({number:1,review:"passed",comment:"Trusted the npm test record"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([])
    // No test run at all: the affected test wasn't run.
    expect(run(['Bash', 'git status --short'])).toEqual([affected])
    expect(run()).toEqual([affected])
  })

  it("review-record-stale (#533): only the reviewer's own verdict counts, and it must say the record is for other code", () => {
    const why = 'the verdict says the record is for older code'
    const builder = { by: 'Agent API', text: 'Done: greet.js fixed.\n\nRun record: code 1a2b3c4, nothing uncommitted. `npm test`: 2 files, all passed.' }
    const reason = (...comments: { by: string; text: string }[]) => {
      const checks = scenario('review-record-stale').expect({ ...base, cards: { b: { comments } } }, {})
      return checks.find(([n]) => n === why)![1]
    }
    // The builder's comment (it says "Run record") is the card's, not a verdict.
    expect(reason(builder)).toBe(false)
    // A verdict that gives no reason, or only mentions the record, fails.
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed: no findings. npm test passed; checked the run record.' })).toBe(false)
    // One that says why the record doesn't count passes.
    expect(reason(builder, { by: 'Coder (alpha)', text: "Passed. The builder's record names 1a2b3c4, so it is stale for HEAD 5d6e7f8; I reran npm test." })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed. The run record was made before a later commit (greet: bye), so I ran the tests again.' })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: "Failed: the record's code doesn't match HEAD." })).toBe(true)
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

  // #577: Claude Code 2.1.296 with an OAuth session it couldn't refresh printed this and exited with 1 at launch.
  describe('a CLI that exits at launch (launchEnded)', () => {
    const { launchEnded, startFailureIn } = require('./scenarios/harness.cjs') as {
      launchEnded: (o: { screen?: string; reason?: string; auth?: { loggedIn?: boolean } | null }) => { environment?: string; error?: string }
      startFailureIn: (file: string) => string
    }
    const { writeFileSync } = require('fs') as typeof import('fs')
    const { dirname, join } = require('path') as typeof import('path')
    const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed'

    it('its last screen or the reason Hive gives: skipped for the environment, with the sign-in advice', () => {
      const why = launchEnded({ screen: `Claude Code ${OAUTH}` }).environment
      expect(why).toMatch(/^not signed in: /)
      expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
      expect(launchEnded({ reason: OAUTH }).environment).toMatch(/^not signed in: /)
    })

    it('nothing seen, but its auth status says it is signed out: skipped too', () => {
      expect(launchEnded({ auth: { loggedIn: false } }).environment).toMatch(/^not signed in: its auth status/)
    })

    it('anything else is an error at once, saying what it showed', () => {
      expect(launchEnded({ reason: "error: option '--model <model>' argument 'x' is invalid.", auth: { loggedIn: true } })).toEqual({ error: "the session ended at launch: error: option '--model <model>' argument 'x' is invalid." })
      expect(launchEnded({})).toEqual({ error: 'the session ended at launch' })
    })

    it("reads the reason from Hive's log", () => {
      const log = join(tempDir('hive-start-failure-'), 'hive.log')
      writeFileSync(log, `2026-10-11T08:24:30.000Z [INFO] [pty] spawn x\n2026-10-11T08:24:33.000Z [WARN] [sessions] ⁨alpha · Coder⁩: exited with code 1 before it started: ⁨${OAUTH}⁩\n`)
      expect(startFailureIn(log)).toBe(OAUTH)
      expect(startFailureIn(join(dirname(log), 'none.log'))).toBe('')
    })
  })
})

// A coordinator's watch is scored as it ended its turn (#402): a new watch replaces the last, so a combined one followed
// by a narrower one leaves only the narrower, and earlier calls prove nothing.
describe("the Assistant's live watch (coordinator scenarios)", () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-wake-question')!
  const call = (cards: number[]) => ({ tool: 'hive_wait_for_tasks', ok: true, args: JSON.stringify({ cards, wake: true }) })
  const outcome = (watch: unknown) => ({
    hiveCalls: [call([2, 3]), call([1])],
    status: 'watching',
    watch,
    cards: { a: { decisions: [] } },
    finalReply: 'Coder asks about an empty name.',
    skillsRead: [],
    allCards: [],
    lanes: []
  })
  const ctx = { cards: { a: 1, b: 2, c: 3 } }
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const check = (o: unknown) => sc.expect(o, ctx).find(([name]) => name.startsWith('ended its turn watching again'))![1]

  it('a combined watch replaced by one on the asking card fails, whatever was called before', () => {
    expect(check(outcome({ cards: [1], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(false)
  })

  it("one live watch over both lanes' ends, waking on anything, passes; one waiting for a single column does not", () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'], column: 'done', label: '', since: '', limitAt: '' }))).toBe(false)
    expect(check({ ...outcome({ cards: [2, 3], changes: ANY }), status: 'finished' })).toBe(false)
  })

  it('a narrowed watch fails: column moves only miss a question in a comment and a failed verdict left in Review', () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'verdict'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment', 'verdict'] }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, agents: ['coder'] }))).toBe(false)
  })
})

// Following lanes to the end (#402): every watch checked for what it wakes on, and the sweep is one a wake started.
describe('coordinator-lanes-to-end scoring', () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-lanes-to-end')!
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const call = (name: string, args: unknown = {}) => ({ tool: name, ok: true, args: JSON.stringify(args) })
  const watch = (cards: number[], changes = ANY) => ({ cards, changes })
  const run = (calls: ReturnType<typeof call>[], first = watch([2, 3]), second = watch([2])) => {
    const o = { hiveCalls: calls, status: 'finished', watch: null, finalReply: 'Both lanes are done.', lanes: [], cards: {}, allCards: [], skillsRead: [] }
    const checks = sc.expect(o, { cards: { a: 1, b: 2, c: 3 }, wakes: 2, firstWatch: first, secondWatch: second })
    return (start: string) => checks.find(([name]) => name.startsWith(start))![1]
  }
  const wake = (cards: number[]) => call('hive_wait_for_tasks', { cards, wake: true })

  it('a sweep only before its first watch is not a sweep on a wake', () => {
    expect(run([call('hive_list_tasks'), wake([2, 3])])('swept the board')).toBe(false)
    expect(run([wake([2, 3]), call('hive_list_tasks'), wake([2])])('swept the board')).toBe(true)
  })

  it('a column-only watch, first or after the wake, fails', () => {
    const calls = [wake([2, 3]), call('hive_lane', { action: 'list' }), wake([2])]
    expect(run(calls)('first watched')).toBe(true)
    expect(run(calls, watch([2, 3], ['column']))('first watched')).toBe(false)
    expect(run(calls, watch([2, 3]), watch([2], ['column']))('woken by')).toBe(false)
  })
})

// The coordinator scenarios' simulated wakes end as Hive's real one to the Assistant does while lanes run (#402).
describe("the scenarios' simulated wake", () => {
  it("ends with Hive's own lanes-running tail", async () => {
    const { LANES_RUNNING_TAIL } = await import('../src/shared/watch')
    expect(helpers.LANES_RUNNING_TAIL).toBe(LANES_RUNNING_TAIL)
  })
})

// A decision put to the user counts without a "?" (#566): Codex once ended a plan with "Please choose the export target".
describe('mode-*-plans: a decision put to the user', () => {
  const sc = SCENARIOS.find((x) => x.id === 'mode-coordinator-plans')!
  const ctx = { ws: 'no-such-workspace' }
  const outcome = (finalReply: string, descriptions: string[] = []) => ({
    hiveCalls: descriptions.map((description) => ({ tool: 'hive_create_task', ok: true, args: JSON.stringify({ title: 'Export', description }) })),
    finalReply
  })
  const check = (o: unknown, name: string) => sc.expect(o, ctx).find(([n]) => n.startsWith(name))![1]
  const CODEX = 'Please choose the export target and contents above. I recommend all unarchived cards with ID, title, column, agent, labels and blockers. No cards or agents have been started.'

  it('a request to choose, with no cards, is asking first and surfaces the decision', () => {
    expect(check(outcome(CODEX), 'wrote cards for alpha, or asked first')).toBe(true)
    expect(check(outcome(CODEX), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Let me know which columns you want in the file.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board. Open: I need your decision on the delimiter before this starts.']), 'surfaced a decision')).toBe(true)
  })

  it('a question still counts; a reply that puts nothing to the user does not', () => {
    expect(check(outcome('Which format should the export use?'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('No cards or agents have been started.'), 'wrote cards for alpha, or asked first')).toBe(false)
    expect(check(outcome('Planned it. Let me know if you need anything else.'), 'surfaced a decision')).toBe(false)
  })

  it('a polite closing is not a decision, in the reply or on a card', () => {
    for (const closing of ['Planned it. Please let me know if you need anything else.', 'Please tell me if anything is unclear.', 'Please let me know what else you need.', 'Let me know what you think.']) {
      expect(check(outcome(closing), 'wrote cards for alpha, or asked first')).toBe(false)
      expect(check(outcome(closing), 'surfaced a decision')).toBe(false)
      expect(check(outcome('Done.', [`Export the board to CSV from the board's menu, done when the file opens in Excel. ${closing}`]), 'surfaced a decision')).toBe(false)
    }
    expect(check(outcome('Please let me know which delimiter to use.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board to CSV. Tell me whether archived cards belong in it before this starts.']), 'surfaced a decision')).toBe(true)
  })
})
