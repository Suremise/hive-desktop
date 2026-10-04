// Skills: the bundled skills in a new workspace, and in an existing one only those it was never given (the ones it
// had before are its own to keep or delete), restore, revert and "update available", adding from
// a .md or a .zip, local skills per provider (and for both at once), the project's Skills tab, "Edit in
// workspace", and the notice for a skill that no longer exists. Deleting moves folders to the Recycle Bin.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')

const userData = path.join(lib.WORK, 'skills-profile')
const ws = path.join(lib.WORK, 'skills-ws')
const oldWs = path.join(lib.WORK, 'skills-old-ws')
const proj = path.join(ws, 'demo')
const dump = path.join(lib.WORK, 'skills-dump')
const sleep = lib.sleep
/** The bundled skills from before Hive kept track of them (an existing workspace without them deleted them), and the newer ones. */
const EARLIER = ['handover', 'merge-ready', 'pick-up', 'review-agent-work', 'split-work', 'workspace-note']
const NEWER = ['coordinate-agents', 'use-hive-api', 'work-on-card']
const BUNDLED = [...EARLIER, ...NEWER]
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, oldWs, dump]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(oldWs, '.hive'), { recursive: true })
  fs.mkdirSync(path.join(oldWs, 'p'), { recursive: true })
  // A folder of unrelated files with one skill .md among them, and a skill .zip with a script.
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(dump, 'release-notes.md'), '# Write release notes\n\nCollect the changes since the last tag.\n')
  fs.writeFileSync(path.join(dump, 'unrelated.txt'), 'not part of any skill')
  fs.writeFileSync(path.join(dump, 'photo.png'), lib.samplePng())
  fs.writeFileSync(path.join(dump, 'deploy.zip'), zipSync({ 'deploy/SKILL.md': strToU8('---\nname: deploy\ndescription: Deploy the app.\n---\n\nRun scripts/deploy.ps1.\n'), 'deploy/scripts/deploy.ps1': strToU8('Write-Host deploy') }))
  // A Hive copy for Codex in the project's .agents/skills: never a local skill.
  const copy = path.join(proj, '.agents', 'skills', 'hive-handover')
  fs.mkdirSync(copy, { recursive: true })
  fs.writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: handover\ndescription: copy\n---\n')
  fs.writeFileSync(path.join(copy, '.hive-copy'), '{"hash":"x"}')

  lib.enableProviders(userData, ['claude-code', 'codex'])
  const { app, page, inv } = await lib.launch({ userData, env: { CODEX_HOME: lib.CODEX_HOME }, viewport: { width: 1500, height: 950 } })
  page.on('pageerror', (e) => console.log('FAIL page error', e.message))

  // An existing workspace (it already has .hive) without the earlier bundled skills: the user deleted them, so they stay
  // deleted (listed for Restore); the newer ones are added.
  await inv('workspace:open', oldWs)
  await sleep(500)
  let list = await inv('skills:workspace')
  check('existing workspace: skills it had are not brought back', !fs.existsSync(path.join(oldWs, '.hive', 'skills', 'handover')))
  check('existing workspace: they are listed as deleted', EARLIER.every((n) => list.find((s) => s.name === n)?.bundled === 'missing'), JSON.stringify(list.map((s) => [s.name, s.bundled])))
  check('existing workspace: the newer bundled skills are added', NEWER.every((n) => list.find((s) => s.name === n)?.bundled === 'same'), JSON.stringify(list.map((s) => [s.name, s.bundled])))

  // A new workspace starts with them.
  await inv('workspace:open', ws)
  await sleep(800)
  const skillsDir = path.join(ws, '.hive', 'skills')
  check('new workspace: every bundled skill is copied', BUNDLED.every((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))), fs.readdirSync(skillsDir).join(','))
  list = await inv('skills:workspace')
  check('new workspace: all match this version', BUNDLED.every((n) => list.find((s) => s.name === n)?.bundled === 'same'))

  // Skills view: Hive skills only.
  await page.keyboard.press('Control+Shift+K')
  await sleep(800)
  const rows = await page.locator('.skill-row').count()
  check('Skills view lists them', rows === BUNDLED.length, String(rows))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-view.png') })

  // Edited → changed → Revert to default → same.
  const pickUp = path.join(skillsDir, 'pick-up', 'SKILL.md')
  fs.appendFileSync(pickUp, '\nMy own step.\n')
  await sleep(600)
  list = await inv('skills:workspace')
  check('an edited bundled skill is "changed"', list.find((s) => s.name === 'pick-up')?.bundled === 'changed')
  await page.locator('.skill-row', { hasText: 'pick-up' }).click()
  await sleep(800)
  check('its page offers Revert to default', (await page.getByText('Revert to default').count()) === 1)
  await page.getByText('Revert to default').click()
  await sleep(400)
  await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).click()
  await sleep(1000)
  list = await inv('skills:workspace')
  check('reverted: "same" again, edit gone', list.find((s) => s.name === 'pick-up')?.bundled === 'same' && !fs.readFileSync(pickUp, 'utf8').includes('My own step'))

  // An edited copy made from an older version: Hive leaves it, and says an update is there to take.
  fs.appendFileSync(pickUp, '\nMy own step.\n')
  const manifestFile = path.join(ws, '.hive', 'bundled.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  // A version Hive shipped before this one (a made-up one wouldn't count: it could be a newer Hive's).
  manifest.skills['pick-up'].from = require('../../src/main/bundledHistory.json').skills['pick-up'][0]
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  list = await inv('skills:workspace')
  check('an edited copy of an older version: "update available"', list.find((s) => s.name === 'pick-up')?.updateAvailable === true)
  await page.locator('.skill-row', { hasText: 'split-work' }).click()
  await sleep(300)
  await page.locator('.skill-row', { hasText: 'pick-up' }).click()
  await sleep(800)
  check('its page says so, beside Revert to default', (await page.locator('.editor-toolbar .badge', { hasText: 'Update available' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-update.png') })
  await page.getByText('Revert to default').click()
  await sleep(400)
  await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).click()
  await sleep(1000)
  list = await inv('skills:workspace')
  check('reverting takes the update', list.find((s) => s.name === 'pick-up')?.bundled === 'same' && !list.find((s) => s.name === 'pick-up')?.updateAvailable)

  // Deleted → greyed, "deleted" → Restore.
  await inv('skills:delete', path.join(skillsDir, 'split-work'))
  await sleep(800)
  check('deleted bundled skill: folder gone', !fs.existsSync(path.join(skillsDir, 'split-work')))
  check('deleted bundled skill: listed greyed as deleted', (await page.locator('.skill-row.missing', { hasText: 'split-work' }).count()) === 1)
  await page.locator('.skill-row.missing', { hasText: 'split-work' }).click()
  await sleep(800)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-missing.png') })
  await page.locator('.editor-toolbar .btn', { hasText: 'Restore' }).click()
  await sleep(1000)
  check('restored', fs.existsSync(path.join(skillsDir, 'split-work', 'SKILL.md')) && (await page.locator('.skill-row.missing').count()) === 0)

  // Adding from a .md (only that file) and a .zip (its folder, with the script).
  const fromMd = await inv('skills:addFromFile', path.join(dump, 'release-notes.md'), 'release-notes', [{ kind: 'hive' }])
  const mdDir = path.join(skillsDir, 'release-notes')
  check('from .md: only SKILL.md, nothing else from its folder', JSON.stringify(fs.readdirSync(mdDir)) === '["SKILL.md"]', fs.readdirSync(mdDir).join(','))
  check('from .md: frontmatter added, described by its heading', fromMd.description === 'Write release notes', fromMd.description)
  await inv('skills:addFromFile', path.join(dump, 'deploy.zip'), 'deploy', [{ kind: 'hive' }])
  check('from .zip: unpacked with its script', fs.existsSync(path.join(skillsDir, 'deploy', 'SKILL.md')) && fs.existsSync(path.join(skillsDir, 'deploy', 'scripts', 'deploy.ps1')))
  let err = ''
  await inv('skills:addFromFile', path.join(dump, 'deploy.zip'), 'deploy', [{ kind: 'hive' }]).catch((e) => (err = String(e)))
  check('adding a name twice is refused', /already exists/.test(err), err)

  // The notice for a skill that no longer exists (deleted outside Hive while shown).
  await page.locator('.skill-row', { hasText: 'deploy' }).first().click()
  await sleep(600)
  fs.rmSync(path.join(skillsDir, 'deploy'), { recursive: true, force: true })
  await sleep(1500)
  check('a skill deleted meanwhile: "no longer exists"', (await page.getByText('no longer exists in this workspace').count()) === 1)

  // Project Skills tab: Hive first, then a section per provider; local skills added for both at once.
  await page.keyboard.press('Control+Shift+E')
  await sleep(500)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(600)
  await page.keyboard.press('Alt+8')
  await sleep(1200)
  const providersShown = await page.locator('.skill-provider-title').allInnerTexts()
  check('project tab: a section per provider', providersShown.length === 2 && /Claude Code/.test(providersShown[0]) && /Codex/.test(providersShown[1]), providersShown.join('|'))
  check("project tab: Hive's Codex copy isn't a local skill", (await page.locator('.skill-provider').nth(1).locator('.skill-row', { hasText: 'handover' }).count()) === 0)
  await page.locator('.skill-provider').first().locator('.skill-group', { hasText: 'Local' }).locator('button[aria-label^="New local skill"]').click()
  await sleep(500)
  await page.locator('.dialog input.input').fill('lint-rules')
  await page.locator('.dialog input[type=checkbox]').check()
  await page.locator('.dialog .btn.primary', { hasText: 'Create' }).click()
  await sleep(1200)
  check('local skill added for Claude Code', fs.existsSync(path.join(proj, '.claude', 'skills', 'lint-rules', 'SKILL.md')))
  check('…and for Codex (tick box)', fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules', 'SKILL.md')))
  const all = await inv('skills:list', proj)
  const locals = all.filter((s) => s.level === 'local').map((s) => `${s.provider}:${s.name}`).sort()
  check('both listed as local skills of their provider', JSON.stringify(locals) === '["claude-code:lint-rules","codex:lint-rules"]', JSON.stringify(locals))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-project.png') })

  // A local skill is edited in place (not preview) and can be deleted there.
  const localRow = page.locator('.skill-provider').nth(1).locator('.skill-row', { hasText: 'lint-rules' })
  await localRow.hover()
  await localRow.locator('button[aria-label="Delete skill"]').click()
  await sleep(400)
  await page.locator('.dialog .btn.danger', { hasText: 'Delete' }).click()
  await sleep(1000)
  check('local skill deleted in the project tab', !fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules')) && fs.existsSync(path.join(proj, '.claude', 'skills', 'lint-rules')))

  // "Edit in workspace" on a Hive skill opens it in the Skills view, in the editor.
  const hiveRow = page.locator('.skill-row', { hasText: 'workspace-note' }).first()
  await hiveRow.hover()
  await hiveRow.locator('button[aria-label^="Edit in the workspace"]').click()
  await sleep(1500)
  const inSkillsView = (await page.locator('.skill-row.selected', { hasText: 'workspace-note' }).count()) === 1
  check('Edit in workspace: Skills view with the skill selected', inSkillsView)
  check('Edit in workspace: opens in the editor, not the preview', (await page.locator('.split .monaco-editor').count()) >= 1)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-edit.png') })

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
