// Attachments (#387): which kind a file is and how each CLI's chip labels it; old .hive/images paths leading to the moved
// files; the move of a host's .hive/images into .hive/attachments; and what attaching a file does (copied into the
// session's folder, or by path), with the viewer's read of a kept attachment.
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { attachmentKind, attachmentLabel, inAttachmentsFolder, movedAttachmentPath } from '../src/shared/attachments'
import { providerDescriptor } from '../src/shared/providers'
import { tempDir } from './tempDir'

describe('attachment kinds and labels', () => {
  it('knows a file by its extension', () => {
    expect(['shot.PNG', 'a.jpeg', 'b.webp'].map(attachmentKind)).toEqual(['image', 'image', 'image'])
    expect(attachmentKind('C:\\x\\Report.pdf')).toBe('pdf')
    expect(['build.log', 'data.csv', 'main.rs', 'notes.md', 'Dockerfile', 'nb.ipynb'].map(attachmentKind)).toEqual(['text', 'text', 'text', 'text', 'text', 'text'])
    expect(['logs.zip', 'tool.exe', 'noext'].map(attachmentKind)).toEqual(['file', 'file', 'file'])
  })

  it("labels a kind by whether the agent's CLI reads it itself (the matrix in the descriptors)", () => {
    const label = (provider: 'claude-code' | 'codex' | 'copilot', kind: Parameters<typeof attachmentLabel>[0]) => {
      const d = providerDescriptor(provider)
      return attachmentLabel(kind, d.capabilities.attachments, d.name)
    }
    // Checked against Claude Code 2.1.296, Codex 0.162.1 and Copilot 1.0.95 (tests/fixtures/attachments).
    expect(label('claude-code', 'pdf')).toMatchObject({ label: 'PDF', native: true })
    expect(label('codex', 'pdf')).toMatchObject({ label: 'PDF · by path', native: false })
    expect(label('copilot', 'pdf')).toMatchObject({ label: 'PDF · by path', native: false })
    for (const p of ['claude-code', 'codex', 'copilot'] as const) {
      expect(label(p, 'image').native).toBe(true)
      expect(label(p, 'text').native).toBe(true)
      expect(label(p, 'file')).toMatchObject({ label: 'File · by path', native: false })
    }
    expect(label('codex', 'pdf').detail).toMatch(/Codex doesn't read PDFs itself/)
  })

  it('the descriptors say what the recorded checks of the CLIs found', () => {
    const matrix = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'attachments', 'matrix.json'), 'utf8')) as Record<string, { native?: string[] }>
    for (const p of ['claude-code', 'codex', 'copilot'] as const) expect([...providerDescriptor(p).capabilities.attachments].sort()).toEqual([...(matrix[p].native ?? [])].sort())
  })

  it('leads a path into an old .hive/images folder to .hive/attachments', () => {
    expect(movedAttachmentPath('D:\\ws\\api\\.hive\\images\\abc\\x.png')).toBe('D:\\ws\\api\\.hive\\attachments\\abc\\x.png')
    expect(movedAttachmentPath('/.hive/images/abc/x.png')).toBe('/.hive/attachments/abc/x.png')
    expect(movedAttachmentPath('D:\\ws\\api\\images\\x.png')).toBeNull()
    expect(inAttachmentsFolder('D:\\p\\.hive\\attachments\\s\\a.pdf') && inAttachmentsFolder('D:\\p\\.hive\\images\\s\\a.png')).toBe(true)
    expect(inAttachmentsFolder('D:\\p\\docs\\a.pdf')).toBe(false)
  })
})

const base = tempDir('hive-attach-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const files = await import('../src/main/files')
const { sessions } = await import('../src/main/sessions')
const { attachmentsDir, forgetMoves } = await import('../src/main/attachmentsFolder')
const { projectStorage } = await import('../src/main/storage')

describe.runIf(process.platform === 'win32')('attachments on disk', () => {
  const wsPath = join(base, 'ws')
  const outside = join(base, 'outside')
  const s = sessions as unknown as { live: Map<string, unknown> }
  let w: ReturnType<typeof createWorkspaceService>
  let n = 0
  /** A new project of the workspace for each case: nothing one leaves is another's. */
  let proj = ''
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const sid = '00000000-0000-4000-8000-0000000003a7'
  const write = (p: string, text = 'x'): string => {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
    return p
  }
  /** The project's agent running a session (only what attaching reads of it). */
  const running = (sessionId = sid): void => {
    s.live.set(`${proj.toLowerCase()}#a1`, { state: { provider: 'codex', runId: 'r1', projectPath: proj, agentId: 'a1', cwd: proj, sessionId, status: 'ready' } })
  }

  beforeAll(async () => {
    mkdirSync(wsPath, { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  beforeEach(async () => {
    proj = join(wsPath, `p${++n}`)
    mkdirSync(proj, { recursive: true })
    await run(() => w.refresh())
    forgetMoves()
  })
  afterEach(() => s.live.clear())
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })

  it('moves an old .hive/images folder to .hive/attachments, whole', async () => {
    const old = write(join(proj, '.hive', 'images', sid, '2026-01-01_10-00-00.png'))
    const dir = await attachmentsDir(proj)
    expect(dir).toBe(join(proj, '.hive', 'attachments'))
    expect(existsSync(old)).toBe(false)
    expect(readdirSync(join(dir, sid))).toEqual(['2026-01-01_10-00-00.png'])
    expect(existsSync(join(proj, '.hive', 'images'))).toBe(false)
  })

  it('merges it into an attachments folder that exists, keeping both of two files of one name', async () => {
    write(join(proj, '.hive', 'attachments', sid, 'a.png'), 'new')
    write(join(proj, '.hive', 'images', sid, 'a.png'), 'old')
    write(join(proj, '.hive', 'images', 'run-x', 'b.png'))
    const dir = await attachmentsDir(proj)
    expect(readdirSync(join(dir, sid)).sort()).toEqual(['a (moved).png', 'a.png'])
    expect(readFileSync(join(dir, sid, 'a (moved).png'), 'utf8')).toBe('old')
    expect(readdirSync(join(dir, 'run-x'))).toEqual(['b.png'])
    expect(existsSync(join(proj, '.hive', 'images'))).toBe(false)
  })

  it('leaves an old folder that is a link where it is', async () => {
    write(join(outside, 'mine', 'personal.png'), 'mine')
    mkdirSync(join(proj, '.hive'), { recursive: true })
    symlinkSync(outside, join(proj, '.hive', 'images'), 'junction')
    await attachmentsDir(proj)
    expect(existsSync(join(proj, '.hive', 'attachments'))).toBe(false)
    expect(readFileSync(join(outside, 'mine', 'personal.png'), 'utf8')).toBe('mine')
  })

  it('a file from outside the session folder is copied; one inside goes by its path, and so does a folder', async () => {
    running()
    const pdf = write(join(outside, 'Q3 report.pdf'), '%PDF')
    const own = write(join(proj, 'src', 'main.ts'))
    const plan = await run(() => sessions.planAttach(proj, [pdf, own, join(proj, 'src'), 'relative.txt'], 'a1'))
    expect(plan.map((p) => [p.name, p.kind, p.copy, p.folder])).toEqual([
      ['Q3 report.pdf', 'pdf', true, false],
      ['main.ts', 'text', false, false],
      ['src', 'file', false, true]
    ])
    const done = await run(() => sessions.attach(proj, [pdf, own], 'a1'))
    expect(done[0].copied).toBe(true)
    expect(done[0].path).toMatch(/\\\.hive\\attachments\\0{8}-0{4}-4000-8000-0000000003a7\\\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_Q3 report\.pdf$/)
    expect(readFileSync(done[0].path, 'utf8')).toBe('%PDF')
    expect(done[1]).toMatchObject({ path: own, copied: false })
    // Already kept: attached again as it is, not copied twice.
    expect((await run(() => sessions.planAttach(proj, [done[0].path], 'a1')))[0].copy).toBe(false)
  })

  it('an image is always kept with the session, even from its own folder', async () => {
    running()
    const shot = write(join(proj, 'docs', 'shot.png'))
    const [a] = await run(() => sessions.attach(proj, [shot], 'a1'))
    expect(a.copied).toBe(true)
    expect(a.path.startsWith(join(proj, '.hive', 'attachments', sid))).toBe(true)
  })

  it('before the provider names the session, attachments wait in a folder named after the launch', async () => {
    running('')
    const [a] = await run(() => sessions.attach(proj, [write(join(outside, 'early.log'))], 'a1'))
    expect(a.path.startsWith(join(proj, '.hive', 'attachments', 'run-r1'))).toBe(true)
  })

  it('refuses when no session is running', async () => {
    await expect(run(() => sessions.planAttach(proj, [join(outside, 'x.txt')], 'a1'))).rejects.toThrow(/No session is running/)
  })

  it('lists every kind, reads a text one for the viewer, and Storage counts them', async () => {
    const dir = join(proj, '.hive', 'attachments', sid)
    write(join(dir, '2026-01-01_10-00-00_build.log'), 'line one\nline two')
    write(join(dir, '2026-01-01_10-00-01_dump.bin'), 'a\u0000b')
    write(join(dir, '2026-01-01_10-00-02_report.pdf'), '%PDF')
    const groups = await run(() => files.listAttachments(proj))
    expect(groups[0].attachments.map((a) => [a.name.slice(20), a.kind])).toEqual([
      ['report.pdf', 'pdf'],
      ['dump.bin', 'file'],
      ['build.log', 'text']
    ])
    expect(await run(() => files.readAttachment(proj, join(dir, '2026-01-01_10-00-00_build.log')))).toEqual({ kind: 'text', text: 'line one\nline two' })
    expect((await run(() => files.readAttachment(proj, join(dir, '2026-01-01_10-00-01_dump.bin')))).kind).toBe('binary')
    await expect(run(() => files.readAttachment(proj, join(proj, 'src', 'x.ts')))).rejects.toThrow(/Not a session attachment/)
    expect((await run(() => projectStorage(proj, true))).attachments).toBeGreaterThan(0)
  })

  it("a file link to an old .hive/images path opens the moved file", async () => {
    write(join(proj, '.hive', 'attachments', sid, 'a.png'))
    expect(await run(() => files.linkFiles(proj, [`.hive/images/${sid}/a.png`, '.hive/images/none.png']))).toEqual([`.hive/attachments/${sid}/a.png`, null])
  })
})
