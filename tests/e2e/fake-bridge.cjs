// The fake CLIs' way to call Hive's tools: through the real hive MCP server, started as the launch configured it (its
// command, arguments and environment), so a scripted call is what a model's call would be. The server runs the call
// against the Agent API, logs it (HIVE_TEST_MCP_LOG) and reports its reply's size to Hive's performance metrics, as
// it does for a real CLI. Used by fake-claude and fake-codex for their "hive", "boardmove", "boardreview" and
// "boardcomment" steps.
const { spawn } = require('child_process')

/**
 * Calls `tool` with `args` on the hive MCP server `server` ({ command, args, env }): initialize, tools/list, the call,
 * then end of input (the server sends its metrics report and exits). Resolves { text, isError }.
 */
function callHiveTool(server, tool, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...server.env }
    const p = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    let result = null
    const done = (r) => {
      if (result) return
      result = r
      clearTimeout(timer)
      // End of input: the server flushes its metrics report and exits (waited for, so the report isn't lost).
      p.stdin.end()
    }
    const timer = setTimeout(() => {
      done({ text: 'The hive server did not answer', isError: true })
      p.kill()
    }, timeoutMs)
    p.on('exit', () => resolve(result ?? { text: 'The hive server exited', isError: true }))
    p.on('error', (e) => {
      done({ text: String(e), isError: true })
      resolve(result)
    })
    p.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        let m
        try {
          m = JSON.parse(buf.slice(0, i))
        } catch {
          m = null
        }
        buf = buf.slice(i + 1)
        if (m?.id === 3) done({ text: (m.result?.content ?? []).map((c) => c.text ?? '').join('\n') || JSON.stringify(m.error ?? null), isError: !!(m.error || m.result?.isError) })
      }
    })
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: tool, arguments: args } })
  })
}

/**
 * A Codex inline table as Hive writes it (`-c mcp_servers.hive={command="…",args=["…"],env={K="…"}}`: strings are JSON
 * strings, keys bare or JSON strings) as an object.
 */
function fromCodexTable(text) {
  let json = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      // A JSON string, copied as it is.
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      json += text.slice(i, j + 1)
      i = j
    } else if (c === '=') json += ':'
    else if (/[A-Za-z0-9_-]/.test(c)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j])) j++
      const word = text.slice(i, j)
      json += /^(true|false|-?\d+(\.\d+)?)$/.test(word) ? word : JSON.stringify(word)
      i = j - 1
    } else json += c
  }
  return JSON.parse(json)
}

/**
 * Parses a scripted "hive TOOL {json}" step's arguments: the JSON object after the tool's name (no " then " in it), or
 * none.
 */
function parseHiveStep(step) {
  const m = /\bhive\s+(hive_[a-z_]+)(?:\s+(\{.*\}))?/i.exec(step)
  if (!m) return null
  let args = {}
  try {
    args = m[2] ? JSON.parse(m[2]) : {}
  } catch {
    args = {}
  }
  return { tool: m[1], args }
}

module.exports = { callHiveTool, fromCodexTable, parseHiveStep }
