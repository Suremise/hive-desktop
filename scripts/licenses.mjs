// Writes THIRD_PARTY_NOTICES.md: the licence of every package that ships inside Hive — the main
// process's runtime dependencies and the libraries bundled into the renderer — with their full texts.
// Run by `npm run build`; commit the result. Build-only tools (vite, electron-builder, sharp…) are not
// shipped and not listed. Written only when its content changed (line endings aside), with the endings the file on
// disk already has, so a build leaves an unchanged notice alone (licenseText.mjs, #148).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { licenceText, noticesToWrite } from './licenseText.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Bundled into the renderer by Vite (devDependencies because they are compiled in, not installed).
const RENDERER = ['react', 'react-dom', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-webgl', 'monaco-editor', 'dompurify', 'marked', 'zustand', '@vscode/codicons']
const roots = [...new Set(['electron', ...Object.keys(pkg.dependencies ?? {}), ...RENDERER])]

// Packages offered under a choice of licences, and the one Hive takes (Darren's call, #185), said where each is listed.
const CHOSEN = { dompurify: 'Apache-2.0' }
// What a package's own licence field leaves out, from its licence files (#185).
const NOTES = { '@vscode/codicons': 'code MIT (LICENSE-CODE); the Git logo icon CC-BY-3.0 (Jason Long)' }

/** Where a package is installed, looking in the requiring package's own node_modules first. */
function locate(name, from) {
  for (let dir = from; dir && dir.startsWith(root); dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return p
    if (dir === root) break
  }
  return null
}

const found = new Map()
function walk(name, from, runtimeOnly) {
  const dir = locate(name, from)
  // Type definitions are compile-time only.
  if (!dir || name.startsWith('@types/')) return
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const id = `${meta.name}@${meta.version}`
  if (found.has(id)) return
  found.set(id, { meta, dir })
  // Electron's own dependencies only download its binary at install time; they don't ship.
  if (!runtimeOnly) return
  for (const dep of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) walk(dep, dir, true)
}
for (const name of roots) walk(name, root, name !== 'electron')

const declaredLicence = (meta) =>
  typeof meta.license === 'string' ? meta.license : meta.license?.type ?? (Array.isArray(meta.licenses) ? meta.licenses.map((l) => l.type ?? l).join(' OR ') : 'see licence text')
/** Its licence as published, and the one Hive uses when it has a choice ("(MPL-2.0 OR Apache-2.0), used under Apache-2.0"). */
const licenceOf = (meta) =>
  `${declaredLicence(meta)}${CHOSEN[meta.name] ? `, used under ${CHOSEN[meta.name]}` : ''}${NOTES[meta.name] ? `; ${NOTES[meta.name]}` : ''}`
const repoOf = (meta) => {
  const r = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url
  return (r ?? meta.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/')
}
const licenceFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|thirdpartynotices)/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: licenceText(readFileSync(join(dir, f), 'utf8')) }))

const list = [...found.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
const out = [
  '# Third-party notices',
  '',
  'Hive is licensed under the [MIT License](LICENSE). It includes the open-source software listed below, each under its own licence, reproduced in full further down.',
  '',
  'Hive runs on [Electron](https://www.electronjs.org/), which includes Chromium, Node.js and other components. Their licences ship with the app, in `LICENSE.electron.txt` and `LICENSES.chromium.html` in the folder Hive is installed in.',
  '',
  "Hive's Windows installer and its uninstaller are built with [NSIS](https://nsis.sourceforge.io/) (zlib/libpng licence), and use these NSIS plug-ins while they run (none is part of the installed app):",
  '',
  '- `System.dll`, `nsDialogs.dll` and `nsExec.dll`, which come with NSIS (zlib/libpng licence).',
  '- The Nsis7z plug-in (`nsis7z.dll`, installer only), which unpacks the app. It is based on [7-Zip](https://www.7-zip.org/) by Igor Pavlov and licensed under the GNU Lesser General Public License, version 2.1. Its source is available from https://nsis.sourceforge.io/Nsis7z_plug-in, and 7-Zip\'s from https://www.7-zip.org/.',
  '- The StdUtils plug-in (`StdUtils.dll`) by LoRd_MuldeR, licensed under the GNU Lesser General Public License, version 2.1 or later. Its source is available from https://github.com/lordmulder/stdutils.',
  '- The UAC plug-in (`UAC.dll`) by Anders, zlib licence: https://nsis.sourceforge.io/UAC_plug-in.',
  '- The WinShell plug-in (`WinShell.dll`) by Anders, published as freeware: https://nsis.sourceforge.io/WinShell_plug-in.',
  '',
  'The installed app also includes Elevate (`resources/elevate.exe`, version 1.0.0.2894) by Johannes Passing, unmodified, which the installer builder (electron-builder) includes for updates that need administrator rights. Its repository (https://github.com/jpassing/elevate) declares the MIT licence in `LICENSE.md` and the GNU LGPL 2.1 or later in its source; both are reproduced below.',
  '',
  'The notices of these installer components and of Elevate are under "Installer and other components" at the end of this file.',
  '',
  'Where a package offers a choice of licences, its entry says which one Hive uses.',
  '',
  'This file is generated by `scripts/licenses.mjs` during `npm run build`.',
  '',
  '| Package | Version | Licence |',
  '|---|---|---|',
  ...list.map(({ meta }) => {
    const repo = repoOf(meta)
    return `| ${repo ? `[${meta.name}](${repo})` : meta.name} | ${meta.version} | ${licenceOf(meta)} |`
  }),
  ''
]
for (const { meta, dir } of list) {
  out.push(`## ${meta.name} ${meta.version}`, '', `Licence: ${licenceOf(meta)}`, '')
  const files = licenceFiles(dir)
  if (!files.length) out.push(`No licence file is included in the package; it is published under ${licenceOf(meta)}.`, '')
  for (const f of files) out.push(...(files.length > 1 ? [`*${f.file}*`, ''] : []), '```text', f.text, '```', '')
}

// What ships that isn't an npm package (#185): the installer's and uninstaller's NSIS parts and plug-ins, and Elevate.
// Their notices, as the components give them (or as their published pages state), are kept in scripts/notices.
const COMPONENTS = [
  { title: 'NSIS (the installer and uninstaller)', intro: 'NSIS 3.0.4.1 and the `System.dll`, `nsDialogs.dll` and `nsExec.dll` plug-ins that come with it. Its licence file:', file: 'nsis.txt' },
  { title: 'Nsis7z plug-in (the installer)', file: 'nsis7z.txt' },
  { title: 'StdUtils plug-in (the installer and uninstaller)', intro: '`StdUtils.dll` 1.1.4.0, by LoRd_MuldeR. Its notice:', file: 'stdutils.txt' },
  { title: 'UAC plug-in (the installer and uninstaller)', intro: '`UAC.dll`, by Anders (https://nsis.sourceforge.io/UAC_plug-in, with its source). Its licence, as included with it:', file: 'uac.txt' },
  { title: 'WinShell plug-in (the installer and uninstaller)', file: 'winshell.txt' },
  { title: 'Elevate (`resources/elevate.exe`)', file: 'elevate.txt' },
  { title: 'GNU Lesser General Public License, version 2.1', intro: 'The licence of the Nsis7z and StdUtils plug-ins and of Elevate, above:', file: 'lgpl-2.1.txt' }
]
out.push('# Installer and other components', '', 'Not npm packages: the parts of the installer and uninstaller listed at the top of this file, and Elevate.', '')
for (const c of COMPONENTS) {
  out.push(`## ${c.title}`, '', ...(c.intro ? [c.intro, ''] : []), '```text', licenceText(readFileSync(join(root, 'scripts', 'notices', c.file), 'utf8')), '```', '')
}

const file = join(root, 'THIRD_PARTY_NOTICES.md')
const write = noticesToWrite(out.join('\n'), existsSync(file) ? readFileSync(file, 'utf8') : null)
if (write !== null) writeFileSync(file, write)
console.log(`THIRD_PARTY_NOTICES.md: ${list.length} packages${write === null ? ', unchanged' : ''}`)
