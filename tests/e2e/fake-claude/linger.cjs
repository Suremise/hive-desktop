// A process an agent leaves running (fake-claude's "linger N", #507): "starter" starts a detached, hidden "linger" and
// exits, so what is left has no living parent, as a server started through a shell has; "linger" records its pid in
// the file given and stays (two minutes at most, in case a test leaves it). "app-starter" does the same with a dev copy
// of an Electron app (fake-claude's "devapp", #614): Electron's executable with Playwright's --inspect=0
// --remote-debugging-port=0 and the app's folder (devapp/main.js records its pid in the file once its window is made).
const { spawn } = require('child_process')
const fs = require('fs')
const [role, file, agent, appDir] = process.argv.slice(2)
if (role === 'app-starter') {
  const env = { ...process.env, FAKE_DEVAPP_FILE: file }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(require('electron'), ['--inspect=0', '--remote-debugging-port=0', appDir], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
  setTimeout(() => process.exit(0), 200)
} else if (role === 'starter') {
  spawn(process.execPath, [__filename, 'linger', file, agent], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => process.exit(0), 200)
} else {
  fs.appendFileSync(file, JSON.stringify({ agent, pid: process.pid, at: new Date().toISOString() }) + '\n')
  setTimeout(() => process.exit(0), 120000)
}
