import { describe, expect, it } from 'vitest'
import { redact, type RedactContext } from '../src/shared/redact'

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
