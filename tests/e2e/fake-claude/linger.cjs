// A process an agent leaves running (fake-claude's "linger N", #507): "starter" starts a detached, hidden "linger" and
// exits, so what is left has no living parent, as a server started through a shell has; "linger" records its pid in
// the file given and stays (two minutes at most, in case a test leaves it).
const { spawn } = require('child_process')
const fs = require('fs')
const [role, file, agent] = process.argv.slice(2)
if (role === 'starter') {
  spawn(process.execPath, [__filename, 'linger', file, agent], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => process.exit(0), 200)
} else {
  fs.appendFileSync(file, JSON.stringify({ agent, pid: process.pid, at: new Date().toISOString() }) + '\n')
  setTimeout(() => process.exit(0), 120000)
}
