// Which settings files the real Claude Code reads, and which --settings files it refuses (#333): what Hive's compaction
// reader (providers/claude/autoCompact.ts, settingSources and readSettings) and its launch read of a user's --settings
// (launchSettings.ts) assume. Each settings file has a SessionStart hook leaving a marker; `claude -p --init-only` runs
// the hooks and exits without a conversation, so it needs no sign-in, sends nothing and spends no tokens. In a Claude
// Code home of the suite's own (claudeHome: 'own'), never the user's. No Hive is started. Run it after a Claude Code
// update: a failure means the reader no longer matches the CLI.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const lib = require('./lib.cjs')

const root = path.join(lib.WORK, 'claudesettings')
const home = path.join(root, 'home')
const proj = path.join(root, 'proj')
const marks = path.join(root, 'marks')
const LIMIT = 2 * 1024 * 1024
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Claude Code as the runner finds it: on the PATH, or where its installer puts it. */
function claudeExe() {
  const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8', env: lib.baseEnv() })
  const found = r.status === 0 && r.stdout.split(/\r?\n/)[0].trim()
  return found || path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')
}

/** Settings whose SessionStart hook leaves the marker `who`. */
const marking = (who, extra = {}) => ({ ...extra, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync(process.argv[1], '')" "${path.join(marks, who).split(path.sep).join('/')}"` }] }] } })

;(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  for (const d of [home, path.join(proj, '.claude'), marks]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(marking('user')))
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify(marking('project')))
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify(marking('local')))
  const cli = path.join(root, 'cli.json')
  fs.writeFileSync(cli, JSON.stringify(marking('cli')))
  // Padded to an exact size: the limit, and a byte over it.
  const sized = (file, who, bytes) => {
    const s = JSON.stringify(marking(who, { pad: '' }))
    fs.writeFileSync(file, s.replace('"pad":""', `"pad":"${'x'.repeat(bytes - s.length)}"`))
  }
  const exact = path.join(root, 'exact.json')
  const big = path.join(root, 'big.json')
  sized(exact, 'exact', LIMIT)
  sized(big, 'big', LIMIT + 1)

  const exe = claudeExe()
  const env = lib.childEnv({ CLAUDE_CONFIG_DIR: home })
  const version = spawnSync(exe, ['--version'], { encoding: 'utf8', env, timeout: 30_000 }).stdout?.trim()
  console.log(`Claude Code ${version || '(version unknown)'}`)
  /** Runs Claude Code's SessionStart hooks with these arguments: its exit code, the markers left, its first error line. */
  const run = (args) => {
    for (const f of fs.readdirSync(marks)) fs.unlinkSync(path.join(marks, f))
    const r = spawnSync(exe, ['-p', '--init-only', ...args], { cwd: proj, env, encoding: 'utf8', timeout: 60_000 })
    const why = lib.environmentProblem(`${r.stdout}\n${r.stderr}`)
    if (why) lib.skip(why)
    return { code: r.status, loaded: fs.readdirSync(marks).sort().join(','), error: (r.stderr || '').trim().split(/\r?\n/)[0] }
  }
  const loads = (name, args, want) => {
    const r = run(args)
    check(`${name}: reads ${want || 'none of them'}`, r.code === 0 && r.loaded === want, JSON.stringify(r))
  }
  const refuses = (name, args, message) => {
    const r = run(args)
    check(`${name}: refused`, r.code !== 0 && r.loaded === '' && message.test(r.error), JSON.stringify(r))
  }

  // Which files: every one by default; --setting-sources names user, project and local (trimmed, case as given, the
  // last flag wins, an empty value none); --restricted none of them, whatever else is given; --settings always.
  loads('no flags', ['--settings', cli], 'cli,local,project,user')
  loads('--setting-sources user', ['--setting-sources', 'user', '--settings', cli], 'cli,user')
  loads('--setting-sources=project,local', ['--setting-sources=project,local', '--settings', cli], 'cli,local,project')
  loads('names trimmed', ['--setting-sources', ' user , local', '--settings', cli], 'cli,local,user')
  loads('the last --setting-sources', ['--setting-sources', 'user', '--setting-sources', 'project', '--settings', cli], 'cli,project')
  loads('--setting-sources ""', ['--setting-sources', '', '--settings', cli], 'cli')
  loads('--setting-sources=', ['--setting-sources=', '--settings', cli], 'cli')
  loads('--restricted', ['--restricted', '--settings', cli], 'cli')
  loads('--restricted with --setting-sources user', ['--restricted', '--setting-sources', 'user', '--settings', cli], 'cli')
  // Lists it refuses: it doesn't start.
  refuses('--setting-sources bogus', ['--setting-sources', 'bogus'], /Invalid setting source/)
  refuses('--setting-sources User (case)', ['--setting-sources', 'User'], /Invalid setting source/)
  refuses('--setting-sources user,, (an empty entry)', ['--setting-sources', 'user,,'], /Invalid setting source/)
  refuses('--setting-sources with no value', ['--settings', cli, '--setting-sources'], /argument missing/)

  // --settings files: at most 2 MiB (exactly the limit is read), and a regular file.
  loads('a --settings file of exactly 2 MiB', ['--settings', exact], 'exact,local,project,user')
  refuses('a --settings file a byte over 2 MiB', ['--settings', big], /exceeds the 2MiB limit/)
  refuses('a --settings folder', ['--settings', root], /Cannot use settings file|EISDIR/)
  refuses('a missing --settings file', ['--settings', path.join(root, 'missing.json')], /Settings file not found/)

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
