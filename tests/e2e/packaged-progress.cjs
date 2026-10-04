// The hive-progress wrapper as installed (#137): dist/win-unpacked's hive-progress.js, outside the asar, run with Hive.exe
// as Node (as its shims run it), against a stand-in for the Agent API's progress endpoints. Checked: output and exit
// code pass through, the run is reported with its steps (step lines taken out of the output), the second run has an
// estimate, and with Hive unreachable the command still runs. HIVE_PROGRESS_CHECK_DEV=1 checks the dev build instead.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const dev = process.env.HIVE_PROGRESS_CHECK_DEV === '1'
const exe = dev ? path.join(lib.ROOT, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'Hive.exe')
const script = dev ? path.join(lib.ROOT, 'out', 'main', 'hive-progress.js') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'out', 'main', 'hive-progress.js')
const data = path.join(lib.WORK, 'packaged-progress-data')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const calls = []
const srv = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} })
    res.setHeader('Content-Type', 'application/json')
    res.end(req.method === 'POST' && req.url === '/v1/progress' ? '{"id":"r1"}' : '{}')
  })
})

/** Runs the wrapper as its shims do; resolves to its exit code and output. */
const wrap = (args, apiUrl) =>
  new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HIVE_PROGRESS_DATA: data, HIVE_API_URL: apiUrl, HIVE_API_TOKEN: 'agent-token' }
    for (const k of ['HIVE_API_TOKEN_FILE', 'HIVE_WORKSPACE', 'HIVE_PROGRESS']) delete env[k]
    const p = spawn(exe, [script, ...args], { env, cwd: lib.WORK })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out: out.replace(/\r/g, ''), err: err.replace(/\r/g, '') }))
  })

;(async () => {
  for (const f of [exe, script]) if (!fs.existsSync(f)) {
    console.log(`FAIL missing ${f}${dev ? ' (npx electron-vite build)' : ' (npm run dist)'}`)
    process.exit(1)
  }
  fs.rmSync(data, { recursive: true, force: true })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const cmd = ['--title', 'Packaged check', '--', 'node', '-e', "console.log('hello'); console.log('##hive-progress step=1 total=2 name=one'); console.log('##hive-progress step=2 name=two'); setTimeout(() => process.exit(0), 700)"]

  const r = await wrap(cmd, url)
  check('output passes through, step lines taken out; exit code 0', r.code === 0 && r.out === 'hello\n' && r.err === '', JSON.stringify(r))
  check('the run is started as the agent, with its title and command', calls[0]?.method === 'POST' && calls[0]?.path === '/v1/progress' && calls[0]?.auth === 'Bearer agent-token' && calls[0]?.body?.title === 'Packaged check' && /node -e/.test(calls[0]?.body?.command), JSON.stringify(calls[0]))
  // Step lines name the step starting; the API counts those finished.
  check('…with the total and first step from its first step line', calls[0]?.body?.total === 2 && calls[0]?.body?.step === 0 && calls[0]?.body?.stepName === 'one', JSON.stringify(calls[0]?.body))
  const steps = Object.assign({}, ...calls.filter((c) => c.method === 'PATCH').map((c) => c.body))
  check('its next step is reported', steps.step === 1 && steps.stepName === 'two', JSON.stringify(calls))
  check('it is finished as passed', calls.at(-1)?.path === '/v1/progress/r1/finish' && calls.at(-1)?.body?.ok === true, JSON.stringify(calls.at(-1)))
  check('no estimate the first time', calls[0]?.body?.estimateMs === undefined)

  calls.length = 0
  await wrap(cmd, url)
  check('the second run has an estimate (the time left as it starts)', calls[0]?.body?.estimateMs >= 300, JSON.stringify(calls[0]?.body))

  calls.length = 0
  const failing = await wrap(['--', 'node', '-e', "console.error('bad'); process.exit(3)"], url)
  check('a failing command: its exit code, reported as failed', failing.code === 3 && failing.err === 'bad\n' && calls.at(-1)?.body?.ok === false && calls.at(-1)?.body?.summary === 'exit code 3', JSON.stringify({ failing, last: calls.at(-1) }))

  const t0 = Date.now()
  const away = await wrap(['--', 'node', '-e', "console.log('still runs'); process.exit(4)"], 'http://127.0.0.1:9')
  check('Hive unreachable: the command runs as usual, quickly', away.code === 4 && away.out === 'still runs\n' && Date.now() - t0 < 8000, JSON.stringify(away))

  srv.close()
  fs.rmSync(data, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})()
