import { describe, expect, it } from 'vitest'
import { argsForLog, userText } from '../src/main/logger'
import { MARKED_LOG, OLDER_LINE, redact, redactLog, type RedactContext } from '../src/shared/redact'

const ctx: RedactContext = {
  home: 'C:\\Users\\Jo Smith',
  folders: ['D:\\Work\\acme', 'D:\\Work\\acme.worktrees\\billing\\two'],
  names: [
    { name: 'acme', as: '<workspace>' },
    { name: 'billing', as: '<project>' },
    { name: 'Two', as: '<agent>' },
    { name: 'hive/two', as: '<branch>' }
  ]
}

describe('diagnostics redaction', () => {
  it('folders: the home folder becomes ~, the workspace and worktrees a placeholder, either slash', () => {
    expect(redact('cli at C:\\Users\\Jo Smith\\.local\\bin\\claude.exe', ctx)).toBe('cli at ~\\.local\\bin\\claude.exe')
    expect(redact('c:/users/jo smith/AppData/Roaming/Hive/logs', ctx)).toBe('~/AppData/Roaming/Hive/logs')
    expect(redact('opened D:\\Work\\acme\\billing and D:/work/acme.worktrees/billing/two/src', ctx)).toBe('opened <workspace>\\<project> and <workspace>/src')
  })

  it('names of workspaces, projects, agents and branches, as words only', () => {
    expect(redact('[sessions] billing#Two started on hive/two', ctx)).toBe('[sessions] <project>#<agent> started on <branch>')
    expect(redact('two-factor between billings', ctx)).toBe('two-factor between billings')
  })

  it('secrets: tokens, keys, headers, JWTs, long hex, emails', () => {
    const lines = [
      'Authorization: Bearer abc.def-123',
      'GET /v1/tasks?token=s3cr3tvalue&x=1',
      '{"apiKey": "k-12345678", "ok": true}',
      'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAA',
      'push with ghp_abcdefghijklmnopqrstuvwxyz0123',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'hook http://127.0.0.1:60849/hook?run=70f2eb161df8d337491abb47',
      'signed in as jo.smith@example.com'
    ]
    const out = redact(lines.join('\n'), ctx)
    expect(out).not.toMatch(/abc\.def-123|s3cr3tvalue|k-12345678|sk-ant|ghp_|eyJhbGci|70f2eb16|jo\.smith@/)
    expect(out).toContain('Authorization: <redacted>')
    expect(out).toContain('token=<redacted>&x=1')
    expect(out).toContain('"ok": true')
    expect(out).toContain('<email>')
  })

  it('keeps what a report needs', () => {
    const line = '2026-10-02T10:00:00.000Z [INFO] [updater] Update settings: check on, download auto, install auto, pre-releases off'
    expect(redact(line, ctx)).toBe(line)
    expect(redact('Claude Code 2.1.4 at ~/.local/bin', ctx)).toBe('Claude Code 2.1.4 at ~/.local/bin')
    expect(redact('session 0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b resumed', ctx)).toBe('session 0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b resumed')
  })
})

describe('diagnostics redaction of the log', () => {
  const T = '2026-10-02T10:00:00.000Z [INFO]'
  it("the user's own text the log marked: card titles, Assistant activity, session names, prompts", () => {
    const lines = [
      `${T} [tasks] #1 created by ${userText('Claudette (hive)')}: ${userText('Confidential customer merger notes')}`,
      `${T} [assistant] ${userText('D:\\Secret\\ws')}: ${userText('Moved #3 Fire Bob to Doing')}`,
      `${T} [sessions] Session 1 takes the name ${userText('Q3 layoffs plan')} it was given in the CLI`,
      `${T} [pty] spawn ${userText('D:\\Secret\\ws\\alpha#a-1')}: claude.exe ${JSON.stringify(['--model', 'opus', userText('Draft the merger memo for Acme')])}`
    ]
    const out = redactLog(lines.join('\n'), ctx)
    expect(out).not.toMatch(/Claudette|Confidential|merger|Secret|Fire Bob|layoffs|Acme|alpha/)
    expect(out).toContain('#1 created by <text>: <text>')
    expect(out).toContain('[assistant] <path>: <text>')
    expect(out).toContain('spawn <path>: claude.exe ["--model","opus","<text>"]')
    expect(out).not.toMatch(/[\u2068\u2069]/)
  })

  it('a span cut off at the end of a line goes too', () => {
    expect(redactLog(`${T} [tasks] #2 created by You: \u2068Private plans`, ctx)).toBe(`${T} [tasks] #2 created by You: <text>`)
  })

  it("older lines: earlier workspaces' folders and names, and any other path of the user's", () => {
    const earlier: RedactContext = { ...ctx, folders: [...ctx.folders, 'D:\\Clients\\Confidential Workspace'], names: [...ctx.names, { name: 'PrivateProject', as: '<name>' }] }
    const lines = [
      `${T} [workspace] Opened workspace D:\\Clients\\Confidential Workspace`,
      `${T} [workspace] Excluded .hive from git in D:\\Clients\\Confidential Workspace\\PrivateProject`,
      `${T} [worktrees] Removed worktree E:/elsewhere/thing/two`,
      `${T} [projects] Hid PrivateProject`
    ]
    const out = redactLog(lines.join('\n'), earlier)
    expect(out).not.toMatch(/Clients|Confidential|PrivateProject|elsewhere/)
    expect(out).toContain('Opened workspace <workspace>')
    expect(out).toContain('Removed worktree <path>')
  })

  it("keeps Hive's and the CLIs' own paths, and each line's [scope]", () => {
    const keep = [
      `${T} [main] at f (C:\\Users\\Jo Smith\\AppData\\Local\\Programs\\Hive\\resources\\app.asar\\out\\main\\index.js:12:3)`,
      `${T} [claude] Candidate C:\\Users\\Jo Smith\\.local\\bin\\claude.exe did not report a version`,
      `${T} [codex] Candidate C:\\Program Files\\nodejs\\codex.cmd did not report a version`
    ]
    const out = redactLog(keep.join('\n'), ctx)
    expect(out).toContain('(~\\AppData\\Local\\Programs\\Hive\\resources\\app.asar\\out\\main\\index.js:12:3)')
    expect(out).toContain('~\\.local\\bin\\claude.exe')
    expect(out).toContain('C:\\Program Files\\nodejs')
    expect(out).not.toContain('<path>')
    const sessions: RedactContext = { ...ctx, names: [{ name: 'sessions', as: '<project>' }] }
    expect(redactLog(`${T} [sessions] sessions finished`, sessions)).toBe(`${T} [sessions] <project> finished`)
    expect(redactLog(`${T} [main] D:\\dev\\hive\\out\\main\\index.js:5`, { ...ctx, app: 'D:\\dev\\hive' })).toBe(`${T} [main] <hive>\\out\\main\\index.js:5`)
  })

  it("lines logged before Hive marked the user's text keep only their time, level and scope", () => {
    const lines = [
      `${T} [tasks] #7 created by You: Earlier run, unknown version`,
      `${T} [main] Hive 0.3.1 starting (Electron 44.5.1)`,
      `${T} [tasks] #1 created by You: Confidential customer merger notes`,
      `${T} [main] Hive 0.4.0 starting (Electron 44.5.1; ${MARKED_LOG})`,
      `${T} [tasks] #2 created by ${userText('You')}: ${userText('Another secret plan')}`,
      `${T} [updates] Update settings: check on`
    ]
    expect(redactLog(lines.join('\n'), ctx).split('\n')).toEqual([
      `${T} [tasks] ${OLDER_LINE}`,
      `${T} [main] Hive 0.3.1 starting (Electron 44.5.1)`,
      `${T} [tasks] ${OLDER_LINE}`,
      `${T} [main] Hive 0.4.0 starting (Electron 44.5.1; ${MARKED_LOG})`,
      `${T} [tasks] #2 created by <text>: <text>`,
      `${T} [updates] Update settings: check on`
    ])
    // No start line in view: every line is from the running Hive, which marks.
    expect(redactLog(`${T} [tasks] #3 created by ${userText('You')}: ${userText('x')}`, ctx)).toBe(`${T} [tasks] #3 created by <text>: <text>`)
  })

  it("an agent's launch arguments: by role, not by how they look", () => {
    const claude = ['--session-id', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '--name', 'Merger', '--settings', 'D:\\ws\\a\\.hive\\settings.json', '--model', 'opus', '--effort', 'high', '--permission-mode', 'auto', 'ConfidentialMerger']
    const out = redactLog(`${T} [pty] spawn x: claude.exe ${JSON.stringify(argsForLog(claude))}`, ctx)
    expect(out).not.toMatch(/Merger|\\ws\\/)
    expect(out).toContain('["--session-id","0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b","--name","<text>","--settings","<path>","--model","opus","--effort","high","--permission-mode","auto","<text>"]')
    const codex = ['/d', '/s', '/c', 'D:\\tools\\codex.cmd', 'resume', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '-c', 'developer_instructions="Be terse"', '-c', 'mcp_servers.acme-crm={command="x"}', '-s', 'workspace-write', 'resume']
    expect(argsForLog(codex).map((a) => a.replace(/\u2068[^\u2069]*\u2069/g, '<marked>'))).toEqual(['/d', '/s', '/c', '<marked>', 'resume', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '-c', 'developer_instructions=<marked>', '-c', '<marked>', '-s', 'workspace-write', '<marked>'])
  })

  it('a value written into its flag (--flag=value) is judged the same way', () => {
    const extra = ['--append-system-prompt=ConfidentialMerger', '--name=PrivateClient', '--config=developer_instructions="Be terse"', '-c=mcp_servers.acme-crm.enabled=false', '--model=opus', '--model=has space', '--x.y=Secret', 'Next']
    const marked = (a: string): string => a.replace(/⁨[^⁩]*⁩/g, '<marked>')
    expect(argsForLog(extra).map(marked)).toEqual(['--append-system-prompt=<marked>', '--name=<marked>', '--config=developer_instructions=<marked>', '-c=<marked>', '--model=opus', '--model=<marked>', '--x.y=<marked>', '<marked>'])
    const out = redactLog(`${T} [pty] spawn x: claude.exe ${JSON.stringify(argsForLog(extra))}`, ctx)
    expect(out).not.toMatch(/Confidential|PrivateClient|terse|acme|Secret|Next/)
  })
})
