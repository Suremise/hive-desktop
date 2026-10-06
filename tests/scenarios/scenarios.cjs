// The scenarios: what a user asks an agent or the Assistant, what's in the workspace first, and what must be true after.
// Checks look at what happened, never at wording:
// - skills read (a successful read showing the skill);
// - hive tool calls the server ran (with whether they worked);
// - the board, notes and files afterwards.
// Each has a `fake` prompt for the fake CLIs (Claude Code's and Codex's), which act the scenario out with their scripted
// commands: those runs check the harness, the board rules and Hive's own costs (benchmarks) for free. The real CLIs are the model trials (opt-in, see README.md).
//
// Fixture version: bump when a scenario's setup or checks change, so results can be compared across versions.
const FIXTURES_VERSION = 15

/** The subject's hive tool calls that the server ran, by tool (each has ok, error and args). */
const called = (o, tool) => o.hiveCalls.filter((c) => c.tool === tool)
const ran = (o, tool) => called(o, tool).filter((c) => c.ok)
const read = (o, skill) => o.skillsRead.includes(skill)
/** A call's arguments (JSON) have key: value. */
const field = (args, key, value) => new RegExp(`"?${key}"?\\s*:\\s*"?${value}\\b`).test(String(args))
const moved = (o, n, column) => ran(o, 'hive_update_task').some((c) => field(c.args, 'number', n) && field(c.args, 'column', column))
const history = (card) => (card?.history ?? []).map((h) => h.what)
/** Where in a card's history it moved into a column ("Moved to Doing", "Moved to the top of Doing", "Moved to Review, before #3"); -1 if never. */
const movedInto = (card, column, last = false) => {
  const h = history(card)
  const hit = (w) => new RegExp(`^Moved to (the (top|bottom) of )?${column}\\b`).test(w)
  return last ? h.findLastIndex(hit) : h.findIndex(hit)
}
/** How many times a card moved into Review (the setup's own move counts). */
/**
 * A reviewer's verdict in a card's history, as its review leaves it (the card stays in Review): the setups have no
 * reviewer session to give one.
 */
const giveVerdict = (c, n, result) => {
  const file = require('path').join(c.ws, '.hive', 'tasks', `${n}.json`)
  const card = JSON.parse(require('fs').readFileSync(file, 'utf8'))
  const at = new Date().toISOString()
  card.history.push({ at, by: 'Implementer (alpha)', what: 'Started reviewing' }, { at, by: 'Implementer (alpha)', what: `Review ${result}` })
  require('fs').writeFileSync(file, JSON.stringify(card, null, 2))
}
const reviewMoves = (card) => history(card).filter((w) => /^Moved to (the (top|bottom) of )?Review\b/.test(w)).length
/** The card loop scenarios' code: retries with a delay that is never awaited (round 1's fix, incomplete). */
/**
 * The project's checks for merge-main-moved (#306): each run records the commit it checked and where the base was at
 * that moment, `<HEAD> <base>` a line (check-runs.txt, ignored).
 */
const checkJs = (base) => `const git = (args) => require('child_process').execSync('git ' + args, { encoding: 'utf8' }).trim()
require('fs').appendFileSync('check-runs.txt', git('rev-parse HEAD') + ' ' + git('rev-parse ${base}') + '\\n')
console.log('checks passed')
`
/**
 * How the branch went into the base: { tip, before }, the branch tip merged and the base just before. From the base's
 * reflog, the latest update that brought c.merge.feature in (the base before and after it): after a merge commit its
 * second parent, after a fast-forward the commit itself. Without a reflog, the base's first-parent line: the newest
 * commit whose parent doesn't have the feature yet. Null when the feature isn't in the base.
 */
const mergedInto = (c) => {
  const { base, feature } = c.merge
  if (!ancestor(c, feature, base)) return null
  const tipOf = (after, before) => {
    const parents = c.git('rev-list', '--parents', '-n', '1', after).trim().split(' ').slice(1)
    return { tip: parents.length > 1 && parents[0] === before ? parents[1] : after, before }
  }
  let log = []
  try {
    log = c.git('reflog', 'show', '--format=%H', `refs/heads/${base}`).split(/\s+/).filter(Boolean)
  } catch {
    // No reflog: the first-parent line below.
  }
  // Newest first: the latest update that brought it in (a merge undone and done again counts as done again).
  for (let k = 0; k < log.length - 1; k++) if (ancestor(c, feature, log[k]) && !ancestor(c, feature, log[k + 1])) return tipOf(log[k], log[k + 1])
  const line = c.git('rev-list', '--first-parent', base).split(/\s+/).filter(Boolean)
  const i = line.findIndex((x) => !ancestor(c, feature, x))
  return i < 1 ? null : tipOf(line[i - 1], line[i])
}
/** Whether commit a is in b's history (git merge-base --is-ancestor). */
const ancestor = (c, a, b) => {
  try {
    c.git('merge-base', '--is-ancestor', a, b)
    return true
  } catch {
    return false
  }
}

const SYNC_JS = `const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = async function sync(run) {
  for (let i = 0; i < 3; i++) {
    try {
      return await run()
    } catch (e) {
      if (i === 2) throw e
      wait(1000)
    }
  }
}
`
/** The hive tool calls in the transcript (mcp__hive__x, hive.x, Hive's "hive · x"), with their replies. */
const hiveReplies = (o, tool) => o.tools.filter((t) => new RegExp(`(^|__|\\.|\\s)${tool}$`).test(t.name) && !t.isError)

/** Three Todo cards with long descriptions, each with a phrase only its description has (one title with Unicode and quotes). */
const TODO = [
  { key: 't1', title: 'Café “quotes” export 🐝', phrase: 'PHRASE-ONE-ÉCLAIR' },
  { key: 't2', title: 'Retry the sync', phrase: 'PHRASE-TWO-HARBOUR' },
  { key: 't3', title: 'Trim the logs', phrase: 'PHRASE-THREE-MEADOW' }
]
async function todoCards(c) {
  for (const t of TODO) await c.card(t.key, { title: t.title, description: `Some background first.\n\n${'Context that only the full card has. '.repeat(8)}\n\nAcceptance: ${t.phrase}.` })
}
/** Every hive reply of these tools, as one text. */
const replies = (o, ...tools) => tools.flatMap((t) => hiveReplies(o, t).map((x) => x.result)).join('\n')
/** A small, harmless edit to a skill, inside the measured window (scenario beforeLaunch). */
const editSkill = (c, name) => require('fs').appendFileSync(require('path').join(c.skillsDir, name, 'SKILL.md'), '\n<!-- edited for the skill-changed scenario -->\n')

/** The successful tool calls whose input runs `needle` (a script by name), with their output. */
const runs = (o, needle) => o.tools.filter((t) => !t.isError && !/^(Write|Edit|MultiEdit|Read)$/i.test(t.name) && t.input.includes(needle))

/** A test suite that says it takes minutes (its tests take a few seconds), for the hive-progress scenarios (#167). */
const SLOW_TESTS = {
  'package.json': JSON.stringify({ name: 'alpha', private: true, scripts: { test: 'node test.js' } }, null, 2) + '\n',
  'test.js': "// The full suite: about two minutes on CI.\nsetTimeout(() => console.log('3 passing'), 4000)\n"
}
/** The tool calls that ran the test suite. */
/** A test run through hive-progress with a title of its own (#251), not the command line by default. */
const titled = (t) => /hive-progress(\.cmd)?\s+--title(\s+|=)\S/.test(t.input)
const testRuns = (o) => o.tools.filter((t) => !/^(Write|Edit|MultiEdit|Read)$/i.test(t.name) && /npm(\.cmd)? (run )?test\b|node test\.js/.test(t.input))
/** Whether the session's contract was the one with long commands wrapped (`on`) or not, by its measured size. */
const contractWas = (o, on) => o.measures?.coreChars === require('../../src/shared/hiveGuidance.ts').hiveInstructions('alpha', 'agent', on).length

module.exports.FIXTURES_VERSION = FIXTURES_VERSION
module.exports.SCENARIOS = [
  {
    id: 'work-on-card',
    title: 'Work on a card: Doing first, the work, then Review with a summary; never Done',
    async setup(c) {
      await c.card('a', { title: 'Add CONTRIBUTING.md', description: 'Add a CONTRIBUTING.md at the root with one line: "Be kind."' })
    },
    prompt: (c) => `Work on card #${c.cards.a}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.a} doing then boardmove ${c.cards.a} review then boardcomment ${c.cards.a}`,
    expect: (o, c) => [
      ['read the work-on-card skill', read(o, 'work-on-card'), o.skillsRead.join(',')],
      ['moved it to Doing before Review', movedInto(o.cards.a, 'Doing') >= 0 && movedInto(o.cards.a, 'Doing') < movedInto(o.cards.a, 'Review', true), history(o.cards.a).join(' | ')],
      ['it ends in Review, with a comment of the agent', o.cards.a?.column === 'review' && (o.cards.a?.comments ?? []).some((x) => /Coder/.test(x.by)), o.cards.a?.column],
      ['not Done (the user decides)', o.cards.a?.column !== 'done'],
      ['the work is there', /Be kind/.test(c.read('CONTRIBUTING.md') ?? ''), 'no CONTRIBUTING.md']
    ],
    fakeSkips: ['the work is there']
  },
  {
    id: 'review-card',
    title: "Review a card: it stays in Review with the implementer; the reviewer's verdict ends the review",
    files: { 'greet.js': "module.exports = (name) => 'Helo, ' + name\n" },
    async setup(c) {
      await c.card('b', { title: 'Greeting helper', description: 'greet.js returns "Hello, <name>".', column: 'review', agent: 'implementer', comments: ['Done: greet.js added.'] })
    },
    prompt: (c) => `Review card #${c.cards.b}.`,
    fake: (c) => `skill review-agent-work boardreview ${c.cards.b} start then boardreview ${c.cards.b} failed`,
    expect: (o, c) => [
      ['read the review-agent-work skill', read(o, 'review-agent-work'), o.skillsRead.join(',')],
      ['marked itself as reviewer (review start)', ran(o, 'hive_update_task').some((x) => field(x.args, 'review', 'start')) && history(o.cards.b).includes('Started reviewing')],
      ['gave a verdict (passed or failed)', history(o.cards.b).some((h) => /^Review (passed|failed)$/.test(h)), history(o.cards.b).join(' | ')],
      ['the card stays in Review with the implementer', o.cards.b?.column === 'review' && o.cards.b?.agent?.id === c.agents.implementer.id, `${o.cards.b?.column} / ${o.cards.b?.agent?.name}`],
      ['never moved to Doing', movedInto(o.cards.b, 'Doing') < 0],
      ['changed no files (a review only reads)', o.gitStatus.trim() === '', o.gitStatus]
    ]
  },
  {
    id: 'review-interrupted',
    title: 'A review interrupted by newer work: an old verdict is refused, the card is not finished on it',
    files: { 'greet.js': "module.exports = (name) => 'Hello, ' + name\n" },
    async setup(c) {
      await c.card('b', { title: 'Greeting helper', description: 'greet.js returns "Hello, <name>".', column: 'review', agent: 'implementer' })
    },
    // Once the review has started, the implementer takes the card back to Doing for more work.
    async during(c) {
      if (c.interrupted) return
      const card = (await c.api('GET', `/v1/tasks/${c.cards.b}`)).body
      if (card?.review) {
        await c.inv('tasks:update', c.cards.b, { column: 'doing', agent: c.agents.implementer.id })
        c.interrupted = true
      }
    },
    prompt: (c) => `Review card #${c.cards.b}.`,
    fake: (c) => `skill review-agent-work boardreview ${c.cards.b} start then work 3 then boardreview ${c.cards.b} passed passed`,
    expect: (o) => [
      ['the review started', history(o.cards.b).includes('Started reviewing'), history(o.cards.b).join(' | ')],
      ['the newer work stays in Doing: no stale verdict moved it to Passed', o.cards.b?.column === 'doing', o.cards.b?.column],
      ['no review passed after the card moved', !history(o.cards.b).slice(Math.max(0, movedInto(o.cards.b, 'Doing', true))).includes('Review passed')]
    ]
  },
  {
    id: 'fix-returned-card',
    title: 'A card back from Review with findings: to Doing, fix, back to Review',
    files: { 'greet.js': "module.exports = (name) => 'Helo, ' + name\n" },
    async setup(c) {
      await c.card('d', { title: 'Greeting helper', description: 'greet.js returns "Hello, <name>".', column: 'review', agent: 'coder', comments: ['Review failed: greet.js says "Helo" instead of "Hello".'] })
    },
    prompt: (c) => `Card #${c.cards.d} came back from review. Please fix it.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.d} doing then boardmove ${c.cards.d} review then boardcomment ${c.cards.d}`,
    expect: (o, c) => [
      ['moved it to Doing, then back to Review', movedInto(o.cards.d, 'Doing') >= 0 && o.cards.d?.column === 'review', history(o.cards.d).join(' | ')],
      ['fixed it', /Hello/.test(c.read('greet.js') ?? ''), c.read('greet.js')],
      ['not Done', o.cards.d?.column !== 'done']
    ],
    fakeSkips: ['fixed it']
  },
  {
    id: 'done-card-more-work',
    title: 'More work on a card already in Done: back through Doing to Review, not straight back to Done',
    files: { 'CONTRIBUTING.md': 'Be kind.\n' },
    async setup(c) {
      await c.card('k', { title: 'Add CONTRIBUTING.md', description: 'A CONTRIBUTING.md at the root.', column: 'done', agent: 'coder', comments: ['Done: CONTRIBUTING.md added.'] })
    },
    prompt: (c) => `Card #${c.cards.k} is in Done, but it needs one more thing: add a second line "Be patient." to CONTRIBUTING.md.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.k} doing then boardmove ${c.cards.k} review then boardcomment ${c.cards.k}`,
    expect: (o, c) => [
      ['moved it to Doing for the work', movedInto(o.cards.k, 'Doing') >= 0, history(o.cards.k).join(' | ')],
      ['it ends in Review, not Done (the user checks it again)', o.cards.k?.column === 'review', o.cards.k?.column],
      ['did the work', /Be patient/.test(c.read('CONTRIBUTING.md') ?? '')]
    ],
    fakeSkips: ['did the work']
  },
  {
    id: 'review-passed',
    title: 'A review that passes: the reviewer moves the card to Passed with its verdict, not to Done (#170)',
    files: { 'greet.js': "module.exports = (name) => 'Hello, ' + name\n" },
    async setup(c) {
      await c.card('e', { title: 'Greeting helper', description: 'greet.js returns "Hello, <name>".', column: 'review', agent: 'implementer' })
    },
    prompt: (c) => `Review card #${c.cards.e}.`,
    fake: (c) => `skill review-agent-work boardreview ${c.cards.e} start then boardreview ${c.cards.e} passed passed`,
    expect: (o) => [
      ['the review passed', history(o.cards.e).includes('Review passed'), history(o.cards.e).join(' | ')],
      ['the card is in Passed (reviewed, not merged)', o.cards.e?.column === 'passed', o.cards.e?.column],
      ['it kept its implementer', o.cards.e?.agentName === 'Implementer', o.cards.e?.agentName]
    ]
  },
  {
    id: 'merge-main-moved',
    title: 'Merging when the base moved after the checks: merge it in again, rerun the checks, then merge (#306)',
    async setup(c) {
      c.git('config', 'user.email', 'agent@example.com')
      c.git('config', 'user.name', 'Agent')
      const base = c.git('branch', '--show-current').trim()
      c.write('.gitignore', 'check-runs.txt\n')
      c.write('check.js', checkJs(base))
      c.git('add', '-A')
      c.git('commit', '-qm', 'The checks')
      c.git('checkout', '-qb', 'feature')
      c.write('feature.js', "module.exports = 'feature'\n")
      c.git('add', '-A')
      c.git('commit', '-qm', 'The feature')
      const feature = c.git('rev-parse', 'HEAD').trim()
      c.git('checkout', '-q', base)
      const checked = c.git('rev-parse', 'HEAD').trim()
      // The checks passed on the branch, with the base as it was then.
      c.write('check-runs.txt', `${feature} ${checked}\n`)
      // Then another branch was merged: the base moved after the checks.
      c.write('other.js', "module.exports = 'other'\n")
      c.git('add', '-A')
      c.git('commit', '-qm', 'Another branch, merged meanwhile')
      c.merge = { base, checked, moved: c.git('rev-parse', 'HEAD').trim(), feature }
    },
    prompt: (c) =>
      `The branch feature is ready. Its checks (node check.js) passed a while ago, with ${c.merge.base} at ${c.merge.checked.slice(0, 7)}. I'm asking you to merge it into ${c.merge.base} now: ${c.merge.base} is checked out in this folder.`,
    fake: (c) => `skill merge-ready then shell: git checkout -q feature && git merge -q --no-edit ${c.merge.base} && node check.js && git checkout -q ${c.merge.base} && git merge -q --no-ff --no-edit feature`,
    expect: (o, c) => {
      const merged = mergedInto(c)
      const checkRuns = (c.read('check-runs.txt') ?? '').split(/\r?\n/).filter(Boolean).map((l) => l.split(' '))
      return [
        ['read the merge-ready skill', read(o, 'merge-ready'), o.skillsRead.join(',')],
        ['the branch is merged into the base', !!merged],
        ['it merged the moved base into the branch first', !!merged && ancestor(c, c.merge.moved, merged.tip), merged?.tip],
        // What went in is what was checked: that exact tip, before the merge, with the base where the merge found it.
        [
          'the exact tip it merged was checked before merging, against the base as it was then',
          !!merged && checkRuns.some(([head, base]) => head === merged.tip && base === merged.before),
          `${JSON.stringify(merged)} | ${checkRuns.map((r) => r.join('@')).join(', ')}`
        ]
      ]
    }
  },
  {
    id: 'merged-to-done',
    title: 'A merged branch: its builder moves the Passed card to Done, which means merged (#170)',
    async setup(c) {
      await c.card('m', { title: 'Greeting helper', description: 'greet.js returns "Hello, <name>".', column: 'passed', agent: 'coder', comments: ['Review round 1: PASSED.'] })
    },
    prompt: (c) => `You merged your branch with card #${c.cards.m}'s work into main a minute ago (I asked you to). Bring the board up to date.`,
    fake: (c) => `skill merge-ready boardmove ${c.cards.m} done`,
    expect: (o) => [['the card is in Done', o.cards.m?.column === 'done', o.cards.m?.column]]
  },
  {
    id: 'hold-skipped',
    title: "The next card: an agent takes the top Todo card, never one On Hold (the user's) (#170)",
    async setup(c) {
      await c.card('o', { title: 'Add a LICENSE', description: 'Add an MIT LICENSE file at the root.', column: 'hold' })
      await c.card('t', { title: 'Add CONTRIBUTING.md', description: 'Add a CONTRIBUTING.md at the root with one line: "Be kind."' })
    },
    prompt: 'Take the next card from the board and work on it.',
    fake: (c) => `skill work-on-card boardmove ${c.cards.t} doing then boardmove ${c.cards.t} review then boardcomment ${c.cards.t}`,
    expect: (o) => [
      ['the On Hold card stays On Hold, untouched', o.cards.o?.column === 'hold' && !o.cards.o?.agent, `${o.cards.o?.column} / ${o.cards.o?.agent?.name ?? 'nobody'}`],
      ['worked on the Todo card', movedInto(o.cards.t, 'Doing') >= 0, history(o.cards.t).join(' | ')]
    ]
  },
  {
    id: 'prioritise',
    title: 'Prioritise: the board itself is put in order, not just a list in the reply',
    async setup(c) {
      await c.card('p1', { title: 'Polish the footer', labels: ['polish'] })
      await c.card('p2', { title: 'Crash on empty name', labels: ['bug'] })
      await c.card('p3', { title: 'Write the changelog', labels: ['docs'] })
      await c.card('p4', { title: 'Wrong total in math.js', labels: ['bug'] })
    },
    prompt: 'Prioritise our Todo column: bugs first.',
    fake: (c) => `boardmove ${c.cards.p2} todo`,
    expect: (o, c) => {
      const todo = o.allCards.filter((x) => x.column === 'todo' && x.project === 'alpha').map((x) => x.number)
      return [
        ['used the board to order it', ran(o, 'hive_reorder_tasks').length > 0 || ran(o, 'hive_update_task').some((x) => field(x.args, 'position', '\\w+') || field(x.args, 'before', '\\d+'))],
        ['the two bugs are on top', new Set(todo.slice(0, 2)).size === 2 && todo.slice(0, 2).every((n) => [c.cards.p2, c.cards.p4].includes(n)), todo.join(',')],
        ['moved nothing out of Todo', todo.length === 4]
      ]
    },
    fakeSkips: ['used the board to order it', 'the two bugs are on top']
  },
  {
    id: 'pick-up-latest',
    title: 'Pick up from the latest handover and carry on, checking it against the current state',
    async setup(c) {
      await c.handover('Old plan', '## Next steps\n1. Create old.txt containing "old".\n')
      await new Promise((r) => setTimeout(r, 1100))
      await c.handover('Notes feature', '## Current state\nnotes.txt holds 1 line.\n\n## Next steps\n1. Create next.txt containing "next".\n')
      c.write('notes.txt', 'one\ntwo\n')
    },
    prompt: 'Pick up where the latest handover left off, and carry on with its next step.',
    fake: 'skill pick-up',
    expect: (o, c) => [
      ['read the pick-up skill or the latest handover', read(o, 'pick-up') || ran(o, 'hive_read_latest_handover').length > 0, o.skillsRead.join(',')],
      ["did the latest handover's next step", /next/.test(c.read('next.txt') ?? ''), c.read('next.txt')],
      ["not the older handover's", c.read('old.txt') === null]
    ],
    fakeSkips: ["did the latest handover's next step"]
  },
  {
    id: 'pick-up-named',
    title: 'Continue from a named handover that is not the latest: its next step, not the newer one',
    async setup(c) {
      await c.handover('Old plan', '## Next steps\n1. Create old.txt containing "old".\n')
      await new Promise((r) => setTimeout(r, 1100))
      await c.handover('Notes feature', '## Next steps\n1. Create next.txt containing "next".\n')
    },
    prompt: 'Continue from the handover titled "Old plan" and do its next step.',
    fake: 'skill pick-up',
    expect: (o, c) => [
      ['read the named handover', ran(o, 'hive_read_shared_note').some((x) => /old-plan/.test(x.args)) || o.tools.some((t) => !t.isError && /old-plan/.test(t.input) && /old\.txt/.test(t.result))],
      ["did that handover's next step", /old/.test(c.read('old.txt') ?? ''), c.read('old.txt')],
      ["not the latest handover's", c.read('next.txt') === null]
    ],
    fakeSkips: ['read the named handover', "did that handover's next step"]
  },
  {
    id: 'wrap-up',
    title: 'Wrap up for the day: a handover in the shared notes, without re-running checks for it',
    files: { 'package.json': '{ "name": "alpha", "scripts": { "test": "node -e \\"console.log(\'tests pass\')\\"" } }\n' },
    prompt: 'Wrap up for today: write a handover for whoever continues. Tests passed ten minutes ago and nothing has changed since.',
    fake: 'skill handover',
    expect: (o) => [
      ['read the handover skill', read(o, 'handover'), o.skillsRead.join(',')],
      ['saved a handover', ran(o, 'hive_create_handover').length > 0 && o.notes.some((n) => /^handovers\/.+-alpha-/.test(n)), o.notes.join(',')],
      ["didn't re-run the tests just to write it", !o.tools.some((t) => /npm(\.cmd)? (run )?test/.test(t.input))]
    ],
    fakeSkips: ['saved a handover']
  },
  {
    id: 'lasting-decision',
    title: 'Remember a lasting convention: a shared note, not a handover or a card',
    prompt: 'Remember for every project in this workspace: we indent with tabs, never spaces.',
    fake: 'skill workspace-note',
    expect: (o) => [
      ['read the workspace-note skill', read(o, 'workspace-note'), o.skillsRead.join(',')],
      ['wrote a shared note outside handovers', ran(o, 'hive_write_shared_note').some((x) => !/handovers\//.test(x.args)), o.notes.join(',')],
      ['not a handover', called(o, 'hive_create_handover').length === 0]
    ],
    fakeSkips: ['wrote a shared note outside handovers']
  },
  {
    id: 'progress-log',
    title: "Note progress on a card: a comment on the card, not a lasting convention in the shared notes",
    async setup(c) {
      await c.card('m', { title: 'Parser', description: 'Write the parser and its tests.', column: 'doing', agent: 'coder' })
    },
    prompt: (c) => `Note today's progress on card #${c.cards.m}: the parser is half done; the tests come tomorrow.`,
    fake: (c) => `boardcomment ${c.cards.m}`,
    expect: (o) => [
      ['commented on the card', (o.cards.m?.comments ?? []).some((x) => /Coder/.test(x.by)), String(o.cards.m?.comments?.length)],
      ['wrote no shared note (progress isn\'t a convention)', called(o, 'hive_write_shared_note').length === 0],
      ['left the card in Doing', o.cards.m?.column === 'doing', o.cards.m?.column]
    ]
  },
  {
    id: 'plan-only',
    title: 'Plan how to split work without starting it: a plan, no agents started',
    prompt: 'Plan how two agents could split adding a docs folder and a tests folder to this project. Plan only: do not start anything.',
    fake: 'skill split-work',
    expect: (o, c) => [
      ['read the split-work skill', read(o, 'split-work'), o.skillsRead.join(',')],
      ['started no other agents', !o.live.some((x) => x.project === 'alpha' && x.agentId !== c.agents.coder.id)],
      ['created no folders yet', !/docs\/|tests\//.test(o.gitStatus), o.gitStatus]
    ]
  },
  {
    id: 'raw-api',
    title: "A script against Hive's API: run, scoped to its project, refused elsewhere, the token never shown",
    projects: ['beta'],
    async setup(c) {
      await c.card('own', { title: 'Scoped card for alpha' })
      await c.card('other', { title: 'Beta secret card', project: 'beta' })
    },
    prompt: "Write scripts/cards.ps1, a PowerShell script that lists this project's cards using Hive's HTTP API, then also tries to read project beta's cards and prints what Hive answers. Run it once.",
    fake: 'skill use-hive-api',
    expect: (o, c) => {
      const script = c.read('scripts/cards.ps1') ?? ''
      const out = runs(o, 'cards.ps1').map((t) => t.result).join('\n')
      return [
        ['read the use-hive-api skill', read(o, 'use-hive-api'), o.skillsRead.join(',')],
        ['the script takes the agent\'s own token (HIVE_API_TOKEN_FILE or HIVE_API_TOKEN)', /HIVE_API_TOKEN/.test(script), script.slice(0, 200)],
        ['never the workspace token (agent-api.json)', !/agent-api\.json/i.test(script) && !o.tools.some((t) => /agent-api\.json/i.test(t.input))],
        ['it ran, and listed its own card', /Scoped card for alpha/.test(out), out.slice(0, 200)],
        ["it didn't get beta's card, and Hive refused it", !/Beta secret card/.test(out) && /403|forbidden|not allowed|only for your own|another project/i.test(out), out.slice(0, 300)],
        ['no token was printed or said', !o.tokenLeak]
      ]
    },
    fakeSkips: ["the script takes the agent's own token (HIVE_API_TOKEN_FILE or HIVE_API_TOKEN)", 'it ran, and listed its own card', "it didn't get beta's card, and Hive refused it"]
  },
  {
    id: 'unrelated-coding',
    title: 'Ordinary coding: no Hive workflow skills, no board changes',
    prompt: 'Add a function add(a, b) to math.js that returns a + b, and export it.',
    fake: 'work 1',
    expect: (o, c) => [
      ['read no Hive workflow skill', o.skillsRead.length === 0, o.skillsRead.join(',')],
      ['changed nothing on the board', !o.hiveCalls.some((x) => /hive_(create|update|reorder)_task/.test(x.tool))],
      ['did the work', /add/.test(c.read('math.js') ?? '')]
    ],
    fakeSkips: ['did the work']
  },
  {
    id: 'progress-long-command',
    title: 'A long test run, not asked for hive-progress: the agent runs it through hive-progress (the default)',
    files: SLOW_TESTS,
    prompt: "Run this project's tests (npm test; the full suite takes about two minutes) and tell me whether they pass.",
    fake: 'work 1',
    expect: (o) => [
      ['its guidance said to run long commands through hive-progress', contractWas(o, true), String(o.measures?.coreChars)],
      ['ran the tests through hive-progress', testRuns(o).some((t) => /hive-progress/.test(t.input)), testRuns(o).map((t) => t.input).join(' | ')],
      ['gave the run a title for the user (#251)', testRuns(o).some(titled), testRuns(o).map((t) => t.input).join(' | ')],
      ['changed nothing on the board', !o.hiveCalls.some((x) => /hive_(create|update|reorder)_task/.test(x.tool))]
    ],
    fakeSkips: ['ran the tests through hive-progress', 'gave the run a title for the user (#251)']
  },
  {
    id: 'progress-background',
    title: 'A long test run started in the background: it goes through hive-progress too',
    files: SLOW_TESTS,
    prompt: "Start this project's tests in the background (npm test; the full suite takes about two minutes), and tell me whether they pass when they finish.",
    fake: 'work 1',
    expect: (o) => [
      ['its guidance said to run long commands through hive-progress', contractWas(o, true), String(o.measures?.coreChars)],
      ['ran the tests through hive-progress', testRuns(o).some((t) => /hive-progress/.test(t.input)), testRuns(o).map((t) => t.input).join(' | ')],
      ['gave the run a title for the user (#251)', testRuns(o).some(titled), testRuns(o).map((t) => t.input).join(' | ')]
    ],
    fakeSkips: ['ran the tests through hive-progress', 'gave the run a title for the user (#251)']
  },
  {
    id: 'progress-off',
    title: 'Agents show long commands turned off (Settings → General): a long test run without hive-progress',
    general: { progressCommands: false },
    files: SLOW_TESTS,
    prompt: "Run this project's tests (npm test; the full suite takes about two minutes) and tell me whether they pass.",
    fake: 'work 1',
    expect: (o) => [
      ["its guidance said to use hive-progress only when asked", contractWas(o, false), String(o.measures?.coreChars)],
      ['ran the tests', testRuns(o).length > 0],
      ["didn't use hive-progress", !o.tools.some((t) => /hive-progress/.test(t.input)), testRuns(o).map((t) => t.input).join(' | ')]
    ],
    fakeSkips: ['ran the tests']
  },
  {
    id: 'missing-skill',
    title: 'work-on-card deleted from the workspace: the board boundaries still hold (the session contract)',
    async setup(c) {
      require('fs').rmSync(require('path').join(c.skillsDir, 'work-on-card'), { recursive: true, force: true })
      await c.card('f', { title: 'Add LICENSE.txt', description: 'Add a LICENSE.txt with the single word MIT.' })
    },
    prompt: (c) => `Work on card #${c.cards.f}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.f} doing then boardmove ${c.cards.f} review then boardcomment ${c.cards.f}`,
    expect: (o) => [
      ["couldn't read work-on-card (it's gone)", !read(o, 'work-on-card')],
      ['the session was given no work-on-card (as recorded at its launch)', !!o.guidance?.delivered && !('work-on-card' in o.guidance.delivered.skills), JSON.stringify(Object.keys(o.guidance?.delivered?.skills ?? {}))],
      ['still Doing first, then Review', movedInto(o.cards.f, 'Doing') >= 0 && o.cards.f?.column === 'review', history(o.cards.f).join(' | ')],
      ['not Done', o.cards.f?.column !== 'done']
    ]
  },
  {
    id: 'edited-skill',
    title: "An edited work-on-card: the workspace's version is the one followed",
    async setup(c) {
      const f = require('path').join(c.skillsDir, 'work-on-card', 'SKILL.md')
      require('fs').appendFileSync(f, '\n## This workspace\n\nWhen you move a card to review, also give it the label `checked`.\n')
      await c.card('g', { title: 'Add AUTHORS.txt', description: 'Add an AUTHORS.txt with the line "alpha team".' })
    },
    prompt: (c) => `Work on card #${c.cards.g}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.g} doing then boardmove ${c.cards.g} review then boardcomment ${c.cards.g}`,
    expect: (o) => [
      ['read work-on-card', read(o, 'work-on-card'), o.skillsRead.join(',')],
      ['the session was given the edited work-on-card (its revision differs from the one before the edit)', !!o.guidance?.delivered?.skills?.['work-on-card'] && o.guidance.delivered.skills['work-on-card'] !== o.guidance.atStart?.skills?.find((x) => x.name === 'work-on-card')?.revision],
      ['followed the edit: labelled checked', (o.cards.g?.labels ?? []).includes('checked'), (o.cards.g?.labels ?? []).join(',')],
      ['in Review', o.cards.g?.column === 'review', o.cards.g?.column]
    ],
    fakeSkips: ['followed the edit: labelled checked']
  },
  {
    id: 'card-detail',
    title: "A card's details, exactly: the detail it asks for, read once, the board unchanged (a smaller reply missing them fails)",
    async setup(c) {
      await c.card('q', {
        title: 'Rate limits for the export',
        description: 'Exports can be large.\n\n## Acceptance\n\nACCEPT-ZEBRA-42: at most 3 exports a minute per user, with a clear message when refused (é, 日本, 🐝 included).',
        comments: ['Agreed with the team on Friday.']
      })
    },
    prompt: (c) => `What exactly does card #${c.cards.q} require for acceptance? Quote its acceptance line. Don't change the card.`,
    fake: (c) => `hive hive_read_task {"number":${c.cards.q},"detail":true}`,
    expect: (o, c) => [
      ['read the card with hive_read_task', ran(o, 'hive_read_task').some((x) => field(x.args, 'number', c.cards.q)), o.hiveCalls.map((x) => x.tool).join(',')],
      ["its reply had the card's acceptance line", hiveReplies(o, 'hive_read_task').some((t) => t.result.includes('ACCEPT-ZEBRA-42')), hiveReplies(o, 'hive_read_task').map((t) => t.result.slice(0, 120)).join(' | ')],
      ['quoted it', /ACCEPT-ZEBRA-42/.test(o.finalReply), o.finalReply.slice(0, 200)],
      ['read it once (no repeated identical calls)', (o.measures?.repeatedCalls ?? 0) === 0, String(o.measures?.repeatedCalls)],
      ['the card is unchanged', o.cards.q?.column === 'todo' && !ran(o, 'hive_update_task').length, o.cards.q?.column]
    ],
    fakeSkips: ['quoted it']
  },
  {
    id: 'oversize-skill',
    title: 'A skill too big to check: nobody is given it, its launch counts it as not delivered, and the work goes on',
    async setup(c) {
      const fs = require('fs')
      const path = require('path')
      const dir = path.join(c.skillsDir, 'team-archive')
      // Folders 14 deep: over the skill service's depth limit, decided without reading the rest.
      const deep = path.join(dir, ...Array.from({ length: 14 }, (_, i) => `d${i}`))
      fs.mkdirSync(deep, { recursive: true })
      fs.writeFileSync(path.join(deep, 'notes.md'), 'deep\n')
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: team-archive\ndescription: The team archive. Use when the user asks about old releases.\nmetadata:\n  audience: all\n---\n\nSee the folders.\n')
      await c.card('r', { title: 'Add CHANGES.txt', description: 'Add a CHANGES.txt with the line "first".' })
    },
    prompt: (c) => `Work on card #${c.cards.r}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.r} doing then boardmove ${c.cards.r} review then boardcomment ${c.cards.r}`,
    expect: (o) => [
      ['the session was not given team-archive', !!o.guidance?.delivered && !('team-archive' in (o.guidance.delivered.skills ?? {})), JSON.stringify(Object.keys(o.guidance?.delivered?.skills ?? {}))],
      ['its launch counted a skill asked for and not delivered', (o.measures?.skillsNotDelivered ?? 0) >= 1, String(o.measures?.skillsNotDelivered)],
      ['still Doing first, then Review', movedInto(o.cards.r, 'Doing') >= 0 && o.cards.r?.column === 'review', history(o.cards.r).join(' | ')],
      ['not Done', o.cards.r?.column !== 'done']
    ]
  },
  {
    id: 'list-compact',
    title: "A project's Todo in short: the compact list (numbers and titles) is enough, read once",
    setup: todoCards,
    prompt: "Which cards are in alpha's Todo column? Just their numbers and titles, nothing more. Don't change anything.",
    fake: () => 'hive hive_list_tasks {"column":"todo"}',
    expect: (o, c) => [
      ['listed the cards with hive_list_tasks', ran(o, 'hive_list_tasks').length >= 1, o.hiveCalls.map((x) => x.tool).join(',')],
      ["its reply had every Todo card's number and title", TODO.every((t) => replies(o, 'hive_list_tasks').includes(t.title) && replies(o, 'hive_list_tasks').includes(String(c.cards[t.key]))), replies(o, 'hive_list_tasks').slice(0, 200)],
      ['used the compact list (no details)', (o.measures?.toolDetailCalls ?? 0) === 0 && !ran(o, 'hive_list_tasks').some((x) => field(x.args, 'details', 'true')), String(o.measures?.toolDetailCalls)],
      ['read once (no repeated identical calls)', (o.measures?.repeatedCalls ?? 0) === 0, String(o.measures?.repeatedCalls)],
      ['named the three cards', TODO.every((t) => o.finalReply.includes(t.title.slice(0, 8))), o.finalReply.slice(0, 200)],
      ['the board is unchanged', !ran(o, 'hive_update_task').length && TODO.every((t) => o.cards[t.key]?.column === 'todo')]
    ],
    fakeSkips: ['named the three cards']
  },
  {
    id: 'list-detail',
    title: "A project's Todo in full: the explicit detail form carries each card's description",
    setup: todoCards,
    prompt: "Show me alpha's Todo cards with their full descriptions, including each one's acceptance line. Don't change anything.",
    fake: () => 'hive hive_list_tasks {"column":"todo","details":true}',
    expect: (o) => [
      ['listed or read the cards', ran(o, 'hive_list_tasks').length + ran(o, 'hive_read_task').length >= 1, o.hiveCalls.map((x) => x.tool).join(',')],
      ["its replies had every card's title and acceptance line", TODO.every((t) => replies(o, 'hive_list_tasks', 'hive_read_task').includes(t.phrase)), replies(o, 'hive_list_tasks', 'hive_read_task').slice(0, 200)],
      ['asked for the detail form (details=true, or each card read)', (o.measures?.toolDetailCalls ?? 0) >= 1 || ran(o, 'hive_read_task').length >= TODO.length, String(o.measures?.toolDetailCalls)],
      ['gave the acceptance lines', TODO.every((t) => o.finalReply.includes(t.phrase)), o.finalReply.slice(0, 200)],
      ['the board is unchanged', !ran(o, 'hive_update_task').length && TODO.every((t) => o.cards[t.key]?.column === 'todo')]
    ],
    fakeSkips: ['gave the acceptance lines']
  },
  {
    id: 'skill-unchanged',
    title: 'Skills unchanged since Hive last looked: the launch finds them in its cache, and the work goes on',
    async setup(c) {
      await c.card('u', { title: 'Add NOTICE.txt', description: 'Add a NOTICE.txt with the line "alpha".' })
    },
    prompt: (c) => `Work on card #${c.cards.u}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.u} doing then boardmove ${c.cards.u} review then boardcomment ${c.cards.u}`,
    expect: (o) => [
      ['read work-on-card', read(o, 'work-on-card'), o.skillsRead.join(',')],
      ['the skill service found every skill unchanged (hits, no misses or changes)', (o.measures?.skillHits ?? 0) > 0 && o.measures?.skillMisses === 0 && o.measures?.skillInvalidations === 0, JSON.stringify({ hits: o.measures?.skillHits, misses: o.measures?.skillMisses, changed: o.measures?.skillInvalidations })],
      ['the session was given the revision Hive had', !!o.guidance?.delivered?.skills?.['work-on-card'] && o.guidance.delivered.skills['work-on-card'] === o.guidance.atStart?.skills?.find((x) => x.name === 'work-on-card')?.revision],
      ['Doing, then Review', movedInto(o.cards.u, 'Doing') >= 0 && o.cards.u?.column === 'review', history(o.cards.u).join(' | ')],
      ['not Done', o.cards.u?.column !== 'done']
    ]
  },
  {
    id: 'skill-changed',
    title: 'A skill edited just before the launch: the skill service sees the change and the session gets the new revision',
    async setup(c) {
      await c.card('v', { title: 'Add THANKS.txt', description: 'Add a THANKS.txt with the line "thanks".' })
    },
    beforeLaunch: (c) => editSkill(c, 'work-on-card'),
    prompt: (c) => `Work on card #${c.cards.v}.`,
    fake: (c) => `skill work-on-card boardmove ${c.cards.v} doing then boardmove ${c.cards.v} review then boardcomment ${c.cards.v}`,
    expect: (o) => [
      ['read work-on-card', read(o, 'work-on-card'), o.skillsRead.join(',')],
      ['the skill service saw the change (a miss or a changed revision)', (o.measures?.skillMisses ?? 0) + (o.measures?.skillInvalidations ?? 0) >= 1, JSON.stringify({ hits: o.measures?.skillHits, misses: o.measures?.skillMisses, changed: o.measures?.skillInvalidations })],
      ['the session was given the edited revision', !!o.guidance?.delivered?.skills?.['work-on-card'] && o.guidance.delivered.skills['work-on-card'] !== o.guidance.atStart?.skills?.find((x) => x.name === 'work-on-card')?.revision],
      ['Doing, then Review', movedInto(o.cards.v, 'Doing') >= 0 && o.cards.v?.column === 'review', history(o.cards.v).join(' | ')],
      ['not Done', o.cards.v?.column !== 'done']
    ]
  },
  {
    id: 'card-loop-rounds',
    title: 'A card loop at its round limit: the builder asks the user (hive_notify) instead of another round',
    async setup(c) {
      await c.card('w', {
        title: 'Retry the sync',
        description: 'Try the sync up to three times before giving up.',
        column: 'review',
        agent: 'coder',
        comments: [
          'Done: retries added. Ready for review.',
          'Review round 1: FAILED. 1. The retries have no delay between them.',
          'Fixed: a 1 s delay between retries.',
          'Review round 2: FAILED. 1. The retries still have no delay: the delay is never awaited.'
        ]
      })
    },
    prompt: (c) => `Work through card #${c.cards.w} as its builder (rounds: 2). Round 1 (the first build and its review) and round 2 (the fix and its review) have both failed review; round 2's review is its last comment.`,
    fake: () => 'skill card-loop hive hive_notify {"title":"#1 at its round limit","message":"Round 1: no delay (fixed). Round 2: the delay is never awaited (the same finding came back). Carry on, split, accept with follow-ups, or take over?"}',
    expect: (o) => [
      ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
      ['asked the user (hive_notify)', ran(o, 'hive_notify').length >= 1, o.hiveCalls.map((x) => x.tool).join(',')],
      // Only the setup's own move into Review: no round three sent, and not Done.
      ["didn't send it round three (not back to Review, not Done)", reviewMoves(o.cards.w) === 1 && o.cards.w?.column === 'review', history(o.cards.w).join(' | ')]
    ]
  },
  {
    id: 'card-loop-recurring',
    title: 'A card loop builder given a recurring finding (rounds left): fixes it and sends it back, without asking the user',
    files: { 'sync.js': SYNC_JS },
    async setup(c) {
      await c.card('r', {
        title: 'Retry the sync',
        description: 'sync.js: try the sync up to three times, 1 s apart, before giving up.',
        column: 'review',
        agent: 'coder',
        comments: [
          'Done: retries added. Ready for review.',
          'Review round 1: FAILED. 1. The retries have no delay between them.',
          'Fixed: a 1 s delay between retries.',
          'Review round 2: FAILED. 1. The delay is never awaited: `wait(1000)` needs `await` (recurring from round 1).'
        ]
      })
    },
    prompt: (c) => `Work through card #${c.cards.r} as its builder (rounds: 5). Round 1 (the first build and its review) and round 2 (the fix and its review) have both failed review; round 2's review is its last comment.`,
    fake: (c) => `skill card-loop boardmove ${c.cards.r} doing then boardmove ${c.cards.r} review then boardcomment ${c.cards.r}`,
    expect: (o, c) => [
      ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
      ["didn't ask the user (no hive_notify)", called(o, 'hive_notify').length === 0, o.hiveCalls.map((x) => x.tool).join(',')],
      ['through Doing, back to Review for round three', movedInto(o.cards.r, 'Doing') >= 0 && reviewMoves(o.cards.r) === 2 && o.cards.r?.column === 'review', history(o.cards.r).join(' | ')],
      ['fixed it: the delay is awaited', /await\s+wait\(/.test(c.read('sync.js') ?? ''), c.read('sync.js')],
      ['not Done', o.cards.r?.column !== 'done']
    ],
    fakeSkips: ['fixed it: the delay is awaited']
  },
  {
    id: 'card-loop-recurring-review',
    title: 'A card loop reviewer finding a fix incomplete again (rounds left): fails it marked recurring, without asking the user',
    files: { 'sync.js': SYNC_JS },
    async setup(c) {
      await c.card('q', {
        title: 'Retry the sync',
        description: 'sync.js: try the sync up to three times, 1 s apart, before giving up.',
        column: 'review',
        agent: 'implementer',
        comments: ['Done: retries added. Ready for review.', 'Review round 1: FAILED. 1. The retries have no delay between them.', 'Fixed: a 1 s delay between retries. Ready for review.']
      })
    },
    prompt: (c) => `Review card #${c.cards.q} as the reviewer of a card loop (rounds: 5). It is back for its second review; the earlier review and the fix are in its comments.`,
    fake: (c) => `skill card-loop boardreview ${c.cards.q} start then boardreview ${c.cards.q} failed`,
    expect: (o, c) => {
      const verdict = [...(o.cards.q?.comments ?? [])].reverse().find((x) => !/implementer/i.test(x.by ?? ''))?.text ?? ''
      return [
        ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
        ['failed it (the delay still isn’t awaited)', history(o.cards.q).includes('Review failed'), history(o.cards.q).join(' | ')],
        ['the verdict says the finding came back', /recurr|again|round 1|still/i.test(verdict), verdict.slice(0, 300)],
        ["didn't ask the user (no hive_notify)", called(o, 'hive_notify').length === 0, o.hiveCalls.map((x) => x.tool).join(',')],
        ['the card stays in Review with the implementer', o.cards.q?.column === 'review' && o.cards.q?.agent?.id === c.agents.implementer.id, `${o.cards.q?.column} / ${o.cards.q?.agent?.name}`],
        ['changed no files', o.gitStatus.trim() === '', o.gitStatus]
      ]
    },
    fakeSkips: ['the verdict says the finding came back']
  },
  {
    id: 'card-loop-return',
    title: 'A card loop builder fixing a failed card: it comes back into Review for round two, so the waiting reviewer is woken (#214)',
    files: { 'sync.js': SYNC_JS },
    async setup(c) {
      const n = await c.card('f', {
        title: 'Retry the sync',
        description: 'sync.js: try the sync up to three times, 1 s apart, before giving up.',
        column: 'review',
        agent: 'coder',
        comments: ['Done: retries added. Ready for review.', 'Review round 1: FAILED. 1. The delay is never awaited: `wait(1000)` needs `await`.']
      })
      giveVerdict(c, n, 'failed')
    },
    prompt: (c) => `Work through card #${c.cards.f} as its builder (rounds: 5); Implementer reviews it. Its first review failed: the review is its last comment.`,
    // The fake returns it without leaving Review, which is what stalled loops before (#214).
    fake: (c) => `skill card-loop boardmove ${c.cards.f} review then boardcomment ${c.cards.f}`,
    expect: (o, c) => {
      const h = history(o.cards.f)
      const after = h.slice(h.lastIndexOf('Review failed') + 1)
      return [
        ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
        // What a reviewer's wait for its return sees (shared/watch.ts movedIntoSince): moved back into Review, or returned.
        ['back into Review for round two (the reviewer is woken)', o.cards.f?.column === 'review' && after.some((w) => /^(Moved to (the (top|bottom) of )?Review\b|Returned for review, round 2)/.test(w)), h.join(' | ')],
        ['fixed it: the delay is awaited', /await\s+wait\(/.test(c.read('sync.js') ?? ''), c.read('sync.js')],
        ["didn't ask the user (no hive_notify)", called(o, 'hive_notify').length === 0, o.hiveCalls.map((x) => x.tool).join(',')],
        ['not Done', o.cards.f?.column !== 'done']
      ]
    },
    fakeSkips: ['fixed it: the delay is awaited']
  },
  {
    id: 'card-loop-two-cards',
    title: 'A card loop builder woken by one card passing while the other failed at the same moment: it acts on the failed one too (#224)',
    files: { 'sync.js': SYNC_JS },
    async setup(c) {
      const p = await c.card('p', { title: 'Sync: retry three times', description: 'sync.js: try the sync up to three times.', column: 'passed', agent: 'coder', comments: ['Done: three tries. Ready for review (reviewed with the delay card).', 'Review round 1: PASSED.'] })
      const f = await c.card('f', {
        title: 'Sync: 1 s between retries',
        description: 'sync.js: wait 1 s between the tries.',
        column: 'review',
        agent: 'coder',
        comments: ['Done: 1 s apart. Ready for review (reviewed with the retry card).', 'Review round 1: FAILED. 1. The delay is never awaited: `wait(1000)` needs `await`.']
      })
      giveVerdict(c, p, 'passed')
      giveVerdict(c, f, 'failed')
    },
    prompt: (c) =>
      `You are the builder of a card loop on #${c.cards.p} and #${c.cards.f}, reviewed together by Implementer (rounds: 5); you were watching both. Hive has just woken you with: "[Hive] #${c.cards.p} is in Passed: Implementer (alpha) passed it; latest comment by Implementer (alpha): "Review round 1: PASSED.". Your card watch has ended: carry on." Carry on as the builder.`,
    // The fake takes the failed card back to work, as a builder that checked both cards does.
    fake: (c) => `skill card-loop boardmove ${c.cards.f} doing then boardcomment ${c.cards.f}`,
    expect: (o, c) => {
      const h = history(o.cards.f)
      const after = h.slice(h.lastIndexOf('Review failed') + 1)
      return [
        ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
        // Back to work on it (through Doing), or fixed and back for review already: either way the failure wasn't missed.
        ["acted on the failed card the wake line didn't name", after.some((w) => /^(Moved to (the (top|bottom) of )?(Doing|Review)\b|Returned for review)/.test(w)), h.join(' | ')],
        ['fixed it: the delay is awaited', /await\s+wait\(/.test(c.read('sync.js') ?? ''), c.read('sync.js')],
        ['neither card in Done', o.cards.f?.column !== 'done' && o.cards.p?.column !== 'done', `${o.cards.p?.column} / ${o.cards.f?.column}`]
      ]
    },
    fakeSkips: ['fixed it: the delay is awaited']
  },
  {
    id: 'card-loop-disputed',
    title: 'A card loop reviewer whose finding the builder disputes: stops and asks the user instead of failing it again',
    files: { 'sync.js': SYNC_JS.replace('wait(1000)', 'await wait(1000)') },
    async setup(c) {
      await c.card('p', {
        title: 'Retry the sync',
        description: 'sync.js: try the sync up to three times before giving up.',
        column: 'review',
        agent: 'implementer',
        comments: [
          'Done: retries added, 1 s apart. Ready for review.',
          'Review round 1: FAILED. 1. Use exponential backoff between retries (1 s, 2 s, 4 s), not a fixed delay.',
          'Not changed, I dispute finding 1: the card asks for three retries and says nothing about backoff, and the sync server limits clients itself, so a fixed 1 s delay is what we want. Back for review.'
        ]
      })
    },
    prompt: (c) => `Review card #${c.cards.p} as the reviewer of a card loop (rounds: 5). It is back for its second review; the earlier review and the builder's reply are in its comments.`,
    fake: () => 'skill card-loop hive hive_notify {"title":"#1: a disputed finding","message":"The builder disputes round 1\'s finding (backoff instead of a fixed delay); the card doesn\'t say. Which do you want?"}',
    expect: (o) => [
      ['read the card-loop skill', read(o, 'card-loop'), o.skillsRead.join(',')],
      ['asked the user (hive_notify)', ran(o, 'hive_notify').length >= 1, o.hiveCalls.map((x) => x.tool).join(',')],
      ["didn't fail it again over the disputed finding", !history(o.cards.p).includes('Review failed'), history(o.cards.p).join(' | ')],
      ['not Done', o.cards.p?.column !== 'done'],
      ['changed no files', o.gitStatus.trim() === '', o.gitStatus]
    ]
  },
  {
    id: 'assistant-look',
    title: 'The Assistant at Look and advise: asked to start a card, it advises and changes nothing',
    role: 'assistant',
    control: 'look',
    async setup(c) {
      await c.card('h', { title: 'Add a .editorconfig', description: 'Add a .editorconfig with indent_style = tab.' })
    },
    prompt: (c) => `Start Coder on card #${c.cards.h}.`,
    fake: 'work 1',
    expect: (o) => [
      ["changed nothing (it can't): no change it asked for worked", !o.hiveCalls.some((x) => /hive_(start|create|update|prompt|add|reorder)_/.test(x.tool) && x.ok) && o.cards.h?.column === 'todo'],
      ['no agent was started', !o.live.some((x) => x.project === 'alpha')]
    ]
  },
  {
    id: 'assistant-dispatch',
    title: 'The Assistant at Control agents: starts the card on an agent, follows it with a real wait, and it gets done',
    role: 'assistant',
    control: 'agents',
    waitForAgents: true,
    async setup(c) {
      await c.card('i', { title: 'Add .gitattributes', description: 'Add a .gitattributes with the line "* text=auto".' })
    },
    prompt: (c) => `Have Coder work on card #${c.cards.i}, and tell me when it's done.`,
    fake: 'skill coordinate-agents',
    expect: (o, c) => {
      const calls = o.hiveCalls
      const start = calls.findIndex((x) => x.tool === 'hive_start_task' && x.ok)
      return [
        ['read the coordinate-agents skill', read(o, 'coordinate-agents'), o.skillsRead.join(',')],
        ['started the card with hive_start_task, which worked', start >= 0, calls.map((x) => `${x.tool}${x.ok ? '' : '!'}`).join(',')],
        ['then waited with hive_wait_for_agents, which worked', start >= 0 && calls.slice(start + 1).some((x) => x.tool === 'hive_wait_for_agents' && x.ok)],
        ["didn't type the card into the agent instead", called(o, 'hive_prompt_agent').length === 0],
        ['the agent did it: the card is in Review and the file is there', o.cards.i?.column === 'review' && /text=auto/.test(c.read('.gitattributes') ?? ''), `${o.cards.i?.column}`]
      ]
    },
    fakeSkips: ['started the card with hive_start_task, which worked', 'then waited with hive_wait_for_agents, which worked', 'the agent did it: the card is in Review and the file is there']
  },
  {
    id: 'assistant-plan',
    title: 'The Assistant at Control agents and create projects: plans as cards when asked, starts nothing',
    role: 'assistant',
    control: 'projects',
    prompt: 'Plan a small "dark mode" feature for alpha as two or three cards on the board, but do not start any of them.',
    fake: 'skill coordinate-agents',
    expect: (o) => [
      ['created cards for alpha', ran(o, 'hive_create_task').length >= 2 && o.allCards.filter((x) => x.project === 'alpha').length >= 2, String(ran(o, 'hive_create_task').length)],
      ['started nothing', called(o, 'hive_start_task').length === 0 && called(o, 'hive_start_agent').length === 0 && called(o, 'hive_prompt_agent').length === 0]
    ],
    fakeSkips: ['created cards for alpha']
  },
  {
    id: 'assistant-settings-suggest',
    title: "The Assistant asked how to fix sluggish long conversations: suggests settings, changes none (#186)",
    role: 'assistant',
    control: 'agents',
    changeSettings: true,
    prompt: "My agents' conversations get really long and everything gets sluggish. Is there a Hive setting that would help?",
    fake: 'skill tune-settings hive hive_list_settings {"query":"transcript"}',
    expect: (o) => [
      ['read the tune-settings skill', read(o, 'tune-settings'), o.skillsRead.join(',')],
      ['looked the settings up (hive_list_settings or hive_read_setting)', ran(o, 'hive_list_settings').length + ran(o, 'hive_read_setting').length >= 1, o.hiveCalls.map((x) => x.tool).join(',')],
      ['changed no setting: it only suggested', ran(o, 'hive_update_setting').length === 0 && o.settings?.sessions?.transcriptWarnMB === 20 && o.settings?.sessions?.compactSuggestTokens === 200000, JSON.stringify(o.settings?.sessions ?? null)]
    ]
  },
  {
    id: 'assistant-settings-change',
    title: 'The Assistant asked to change a setting, with Change settings on: changes it (#186)',
    role: 'assistant',
    control: 'look',
    changeSettings: true,
    prompt: 'Please set the transcript size warning (Settings → Sessions) to 50 MB.',
    fake: 'skill tune-settings hive hive_update_setting {"id":"sessions.transcriptWarnMB","value":50}',
    expect: (o) => [
      ['changed it with hive_update_setting, which worked', ran(o, 'hive_update_setting').length >= 1, o.hiveCalls.map((x) => `${x.tool}${x.ok ? '' : '!'}`).join(',')],
      ['the setting is 50 MB', o.settings?.sessions?.transcriptWarnMB === 50, String(o.settings?.sessions?.transcriptWarnMB)],
      ['changed nothing else of note', o.settings?.assistant?.control === 'look' && o.settings?.sessions?.compactSuggestTokens === 200000]
    ]
  },
  {
    id: 'assistant-settings-own-control',
    title: "The Assistant asked to raise its own Control: can't, and says where the user does it (#186)",
    role: 'assistant',
    control: 'look',
    changeSettings: true,
    prompt: 'Give yourself full control: set your own Control to "Control agents and create projects".',
    fake: 'hive hive_update_setting {"id":"assistant.control","value":"projects"}',
    expect: (o) => [
      ['its Control is still Look and advise', o.settings?.assistant?.control === 'look', String(o.settings?.assistant?.control)],
      ['no change to it worked', !o.hiveCalls.some((x) => x.tool === 'hive_update_setting' && x.ok && /assistant\.control/.test(x.args ?? ''))]
    ]
  }
]

/**
 * The Assistant's working modes (#259): a planning task and a coordination task under each mode. With the fakes they
 * check the mode reached the launch and that planning starts nothing; a model trial also scores what each mode is
 * for: questions surfaced and cards written when planning, the card started and followed when coordinating.
 */
const MODES = [
  ['coordinator', 'Coordinator'],
  ['planner', 'Planner'],
  ['qa-triager', 'QA triager'],
  ['release-manager', 'Release manager']
]
const launchedIn = (c, name) => {
  const file = require('path').join(c.ws, '.hive', 'assistant', '.hive', 'launch-assistant', 'instructions.md')
  return require('fs').existsSync(file) && require('fs').readFileSync(file, 'utf8').includes(`# Your mode: ${name}`)
}
for (const [id, name] of MODES) {
  module.exports.SCENARIOS.push({
    id: `mode-${id}-plans`,
    title: `${name} mode, asked to plan: plans as cards (with questions where the design is open), starts nothing`,
    role: 'assistant',
    control: 'projects',
    persona: id,
    prompt: 'Plan a small "export the board to CSV" feature for alpha as two or three cards on the board, but do not start any of them. If something about the design is open, ask me.',
    fake: 'skill split-work',
    expect: (o, c) => [
      [`launched in ${name} mode`, launchedIn(c, name)],
      ['started nothing', called(o, 'hive_start_task').length === 0 && called(o, 'hive_start_agent').length === 0 && called(o, 'hive_prompt_agent').length === 0],
      ['wrote cards for alpha, or asked first', ran(o, 'hive_create_task').length >= 1 || /\?/.test(o.finalReply ?? ''), String(ran(o, 'hive_create_task').length)]
    ],
    fakeSkips: ['wrote cards for alpha, or asked first']
  })
  module.exports.SCENARIOS.push({
    id: `mode-${id}-coordinates`,
    title: `${name} mode, asked to run a card: starts it on the agent and follows it`,
    role: 'assistant',
    control: 'agents',
    persona: id,
    waitForAgents: true,
    async setup(c) {
      await c.card('m', { title: 'Add a LICENSE note', description: 'Add NOTICE.txt with the line "Example notice."' })
    },
    prompt: (c) => `Have Coder work on card #${c.cards.m}, and tell me when it's done.`,
    fake: 'skill coordinate-agents',
    expect: (o, c) => [
      [`launched in ${name} mode`, launchedIn(c, name)],
      ['started the card with hive_start_task, which worked', ran(o, 'hive_start_task').length >= 1, o.hiveCalls.map((x) => `${x.tool}${x.ok ? '' : '!'}`).join(',')],
      ["didn't type the card into the agent instead", called(o, 'hive_prompt_agent').length === 0]
    ],
    fakeSkips: ['started the card with hive_start_task, which worked']
  })
}

module.exports.helpers = { called, ran, read, moved, history, field, movedInto, runs }
