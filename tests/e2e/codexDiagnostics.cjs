// Failure evidence for real Codex suites (#478). Reads only the test home and runner logs, with bounded tails;
// a missing log or a peer finishing while it is read is evidence unavailable, never a different test outcome.
const fs = require('fs')
const path = require('path')
const ctx = require('./runContext.cjs')
const { runDirActive, runDirsInOrder } = require('./logs.mjs')

const MAX_BYTES = 32 * 1024
const MAX_FILES = 2
const MAX_RUNS = 100
const MAX_ENTRIES = 100
const MAX_ENTRY = 2000

function tail(file, limit = MAX_BYTES) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const offset = Math.max(0, size - limit)
    const bytes = Buffer.alloc(Math.min(size, limit))
    const read = fs.readSync(fd, bytes, 0, bytes.length, offset)
    let text = bytes.subarray(0, read).toString('utf8')
    if (offset) text = text.slice(text.indexOf('\n') + 1) // A partial leading record isn't attributable.
    return { text, truncated: offset > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

function sandboxEntries(text, from, to) {
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})[^\]]*\] (.*)$/.exec(line)
    if (match) {
      // Codex's log timestamps are local, not UTC (the runner's record uses UTC).
      const at = new Date(match[1].replace(' ', 'T')).getTime()
      entries.push({ at, text: line.slice(0, MAX_ENTRY) })
    } else if (entries.length && entries.at(-1).text.length < MAX_ENTRY) {
      entries.at(-1).text = `${entries.at(-1).text}\n${line}`.slice(0, MAX_ENTRY)
    }
  }
  return entries.filter((e) => e.at >= from && e.at <= to).slice(-MAX_ENTRIES)
}

function runningCliSuites({ logsRoot = path.join(ctx.TEST_ROOT, 'e2e', 'logs'), alive, ownRunner = process.ppid } = {}) {
  const peers = []
  for (const root of [logsRoot, path.join(logsRoot, 'nested')]) {
    let names
    try {
      names = runDirsInOrder(fs.readdirSync(root)).slice(-MAX_RUNS)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = path.join(root, name)
      if (!runDirActive(dir, alive)) continue
      try {
        const owner = Number(fs.readFileSync(path.join(dir, '.active'), 'utf8'))
        if (owner === ownRunner) continue
        const state = JSON.parse(tail(path.join(dir, 'running-suites.json')).text)
        if (state.pid !== owner) continue
        const suites = state.suites.filter((s) => s.needs?.some((n) => n === 'codex' || n === 'claude'))
        if (suites.length) peers.push({ run: dir, pid: owner, root: state.root, lane: state.lane, at: state.at, suites })
      } catch (e) {
        peers.push({ run: dir, unavailable: e.code || e.message.slice(0, 200) })
      }
    }
  }
  return peers
}

function collectSandboxDiagnostics({ home = ctx.CODEX_HOME, from, to = Date.now(), peersBefore = [], logsRoot, alive, terminal = '' }) {
  if (ctx.isUserCliHome(home)) throw new Error('Sandbox diagnostics require a test Codex home')
  const sandbox = path.join(home, '.sandbox')
  const logs = []
  try {
    const names = fs.readdirSync(sandbox).filter((n) => /^sandbox\.\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-MAX_FILES)
    for (const name of names) {
      const file = path.join(sandbox, name)
      try {
        const read = tail(file)
        logs.push({ file, truncated: read.truncated, entries: sandboxEntries(read.text, from, to) })
      } catch (e) {
        logs.push({ file, unavailable: e.code || e.message.slice(0, 200) })
      }
    }
  } catch (e) {
    logs.push({ directory: sandbox, unavailable: e.code || e.message.slice(0, 200) })
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), home, terminal: terminal.slice(-4000), peersBefore, peersAtFailure: runningCliSuites({ logsRoot, alive }), logs }
}

function printSandboxDiagnostics(options, file) {
  try {
    const evidence = collectSandboxDiagnostics(options)
    const text = JSON.stringify(evidence, null, 2)
    try {
      fs.writeFileSync(file, `${text}\n`)
    } catch (e) {
      console.log(`DIAGNOSTIC could not save ${file}: ${e.code || e.message}`)
    }
    console.log(`DIAGNOSTIC Codex sandbox evidence: ${file}`)
    for (const line of text.split('\n')) console.log(`DIAGNOSTIC ${line}`)
  } catch (e) {
    console.log(`DIAGNOSTIC Codex sandbox evidence unavailable: ${e.message}`)
  }
}

module.exports = { MAX_BYTES, sandboxEntries, runningCliSuites, collectSandboxDiagnostics, printSandboxDiagnostics }
