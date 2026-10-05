// Which e2e suites a change needs (npm run e2e -- --affected [base]): for review rounds that fixed a few things,
// rather than the whole set. Errs towards more, never fewer: the files every part of Hive goes through, and any file
// that isn't in an area or known to need no suite (DOCS_ONLY), mean every suite. The final round before Done still runs every suite
// the card names, and the full set runs before a merge to main (tests/e2e/README.md). Suites that start a real CLI
// (the real tier) are picked only when a change touches what they cover (an area naming them, or REAL_TIER), which is
// when a merge also needs the real tier. tests/e2esuites.test.ts checks that every suite is in an area and every
// source file is covered.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** Changes to these touch everything (the IPC contract, types, the store, the shell, the test harness): every suite. */
export const EVERYTHING = [
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/main/config.ts',
  'src/main/events.ts',
  'src/main/windows.ts',
  'src/main/workspace.ts',
  'src/main/sessions.ts',
  'src/main/servers.ts',
  'src/main/fsutil.ts',
  'src/main/paths.ts',
  'src/main/logger.ts',
  'src/main/ptyHost.ts',
  'src/main/testQuiet.ts',
  'src/main/raw.d.ts',
  'src/preload/',
  'src/renderer/index.html',
  'src/renderer/src/main.tsx',
  'src/renderer/src/App.tsx',
  'src/renderer/src/store.ts',
  'src/renderer/src/actions.ts',
  'src/renderer/src/api.ts',
  'src/renderer/src/util.ts',
  'src/renderer/src/commands.ts',
  'src/renderer/src/components/ui.tsx',
  'src/renderer/src/components/Shell.tsx',
  'src/renderer/src/components/ErrorBoundary.tsx',
  'src/renderer/src/styles/app.css',
  'src/shared/api.ts',
  'src/shared/types.ts',
  'src/shared/defaults.ts',
  'src/shared/dates.ts',
  'src/shared/providers.ts',
  'src/main/providers/',
  'tests/e2e/lib.cjs',
  'tests/e2e/run.mjs',
  'tests/e2e/fake-claude/',
  'tests/e2e/fake-bridge.cjs',
  'tests/e2e/suites.mjs',
  'tests/e2e/affected.mjs',
  'tests/e2e/record.mjs',
  'tests/e2e/runner.mjs',
  'tests/e2e/build.mjs',
  'tests/e2e/logs.mjs',
  'tests/e2e/lanes.mjs',
  'tests/e2e/runContext.cjs',
  'tests/e2e/slots.mjs',
  'tests/progressReport.mts',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.yml'
]

/**
 * Areas: source paths (a file, or a folder ending in /) and the suites that exercise them. A path may be in several.
 * A suite's own file (tests/e2e/<suite>.cjs) always selects it.
 */
export const AREAS = [
  { paths: ['src/main/agentTokens.ts'], suites: ['boardscope', 'review', 'progress', 'progressreport', 'cardloop', 'replysize'] },
  { paths: ['src/main/assistantControl.ts', 'src/shared/assistant.ts', 'src/shared/assistantTools.ts', 'src/main/personas.ts', 'src/renderer/src/components/Assistant.tsx', 'src/renderer/src/components/AssistantView.tsx', 'src/renderer/src/components/Personas.tsx'], suites: ['assistantside', 'assistant', 'assistant-control', 'assistantend', 'assistantimages', 'tipcorner', 'replysize', 'claude-real'] },
  { paths: ['src/main/benchmarks.ts', 'src/shared/benchmark.ts', 'src/renderer/src/views/PerformanceCompare.tsx'], suites: ['perfcompare'] },
  { paths: ['src/main/metrics.ts', 'src/main/metricsUsage.ts', 'src/shared/metrics.ts', 'src/shared/metricsView.ts', 'src/renderer/src/views/Performance.tsx'], suites: ['performance', 'perfcompare', 'bridgereport'] },
  { paths: ['src/main/branchWatch.ts', 'src/main/git.ts', 'src/main/worktrees.ts'], suites: ['unmerged', 'agents', 'changes', 'paneheader', 'claude-real'] },
  { paths: ['src/main/bundled.ts', 'src/main/bundledHistory.json', 'src/main/skills.ts', 'src/main/revisions.ts', 'src/renderer/src/components/Skills.tsx'], suites: ['skills', 'skillaudience', 'skilldelivery'] },
  { paths: ['src/main/guidance.ts', 'src/shared/hiveGuidance.ts', 'src/shared/toolReplies.ts', 'src/main/mcp/'], suites: ['skilldelivery', 'replysize', 'mcp', 'bridgereport', 'cardloop'] },
  { paths: ['src/main/cardSessions.ts', 'src/renderer/src/components/CardChip.tsx'], suites: ['cardchip', 'sessionorigin'] },
  { paths: ['src/main/compaction.ts'], suites: ['compact', 'overview', 'paneheader'] },
  { paths: ['src/main/diagnostics.ts', 'src/shared/redact.ts'], suites: ['about'] },
  { paths: ['src/main/files.ts', 'src/renderer/src/views/FilesTab.tsx', 'src/renderer/src/components/FileView.tsx', 'src/renderer/src/components/DocEditor.tsx', 'src/renderer/src/components/Editors.tsx', 'src/renderer/src/editorDrafts.ts', 'src/renderer/src/monaco.ts', 'src/renderer/src/monacoLang.ts'], suites: ['files', 'editor', 'drafts', 'unsaved', 'icons', 'image', 'assistantimages'] },
  { paths: ['src/main/hookStatus.ts', 'src/main/terminalTitle.ts', 'src/shared/terminalInput.ts'], suites: ['background', 'attention', 'mode', 'busy', 'codex', 'codex-background'] },
  // The rendered screen Hive reads Claude Code's footer (the live permission mode) from.
  { paths: ['src/main/terminalScreen.ts'], suites: ['mode', 'assistant'] },
  { paths: ['src/main/mcp.ts', 'src/main/mcpSecrets.ts'], suites: ['drafts', 'mcp'] },
  { paths: ['src/main/notes.ts'], suites: ['drafts', 'codex-handover'] },
  { paths: ['src/main/planUsage.ts', 'src/renderer/src/components/ModelPicker.tsx', 'src/shared/claude.ts', 'src/shared/codex.ts', 'src/shared/prices.ts'], suites: ['plan', 'providers', 'codex-setup', 'context', 'unpricedcost', 'models'] },
  // Models and capabilities from the CLIs, and their fallbacks (#125).
  { paths: ['src/shared/models.ts', 'tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json'], suites: ['models', 'assistant', 'footerfit', 'agents-ui', 'automode'] },
  { paths: ['src/main/power.ts', 'src/shared/keepAwake.ts'], suites: ['quitwait', 'quit'] },
  { paths: ['src/main/progress.ts', 'src/main/progressService.ts', 'src/shared/progress.ts', 'src/renderer/src/components/Progress.tsx'], suites: ['progress', 'progressreport', 'replysize'] },
  { paths: ['src/main/progressReporters/'], suites: ['progressreport', 'packaged-progress'] },
  { paths: ['src/main/projectAgents.ts'], suites: ['agents', 'agents-ui', 'reorder', 'pages', 'unmerged'] },
  { paths: ['src/main/projectRemoval.ts', 'src/renderer/src/components/ProjectRemoval.tsx'], suites: ['board', 'storage'] },
  { paths: ['src/main/providerService.ts'], suites: ['providers', 'codex-setup', 'startfail', 'models'] },
  { paths: ['src/main/rendererWatch.ts'], suites: ['rendercrash'] },
  { paths: ['src/main/storage.ts', 'src/shared/storage.ts', 'src/renderer/src/components/Storage.tsx'], suites: ['storage'] },
  { paths: ['src/main/taskStart.ts', 'src/main/tasks.ts', 'src/shared/tasks.ts', 'src/renderer/src/components/Board.tsx', 'src/shared/edgeScroll.ts'], suites: ['board', 'boardscope', 'boardscroll', 'review', 'donemove', 'doingmove', 'carddialog', 'cardchip', 'taskoverview', 'busy', 'dialogs'] },
  { paths: ['src/main/watches.ts', 'src/shared/watch.ts'], suites: ['cardloop', 'quitwait', 'replysize'] },
  { paths: ['src/main/taskbar.ts', 'src/shared/taskbar.ts'], suites: ['taskbar', 'progress'] },
  { paths: ['src/main/titleBar.ts', 'src/shared/titleBar.ts'], suites: ['carddialog'] },
  { paths: ['src/main/transcripts.ts', 'src/main/transcriptReads.ts', 'src/renderer/src/views/SessionsTab.tsx', 'src/shared/sessionOrigin.ts', 'src/shared/sessionResume.ts', 'src/shared/sessionTree.ts'], suites: ['transcript', 'sessionorigin', 'sessiontree', 'loadfail', 'sessionname', 'packaged-transcript'] },
  { paths: ['src/main/tray.ts', 'src/renderer/src/chime.ts', 'src/shared/bursts.ts'], suites: ['bursts', 'bell', 'banners'] },
  { paths: ['src/main/notices.ts', 'src/renderer/src/components/NoticeBanners.tsx', 'src/main/planUsage.ts'], suites: ['banners'] },
  { paths: ['src/main/updater.ts', 'src/renderer/src/components/Updates.tsx'], suites: ['update', 'about'] },
  { paths: ['src/renderer/src/components/AgentDialogs.tsx', 'src/renderer/src/components/PermissionMode.tsx'], suites: ['agents-ui', 'agents', 'mode', 'context', 'codex-handover', 'footerfit', 'dialogs'] },
  { paths: ['src/renderer/src/components/AgentPanes.tsx'], suites: ['paneheader', 'pages', 'reorder', 'unmerged', 'sessionname', 'ctxpercent', 'footerfit', 'longsession', 'startfail', 'cardchip', 'agents-ui', 'unpricedcost', 'swap'] },
  { paths: ['src/renderer/src/components/TerminalView.tsx', 'src/renderer/src/fileLinks.ts', 'src/shared/fileLinks.ts'], suites: ['filelinks', 'image', 'restart', 'rendercrash'] },
  { paths: ['src/renderer/src/components/Inbox.tsx', 'src/renderer/src/inbox.ts', 'src/shared/inbox.ts'], suites: ['inbox', 'attention', 'bell'] },
  { paths: ['src/renderer/src/components/Keybindings.tsx'], suites: ['keys'] },
  { paths: ['src/renderer/src/components/NumberField.tsx', 'src/shared/numberInput.ts'], suites: ['numbers'] },
  { paths: ['src/renderer/src/components/Overlays.tsx', 'src/shared/folderLabels.ts'], suites: ['about', 'quit', 'carddialog', 'keys', 'closewindow'] },
  { paths: ['src/renderer/src/components/ProviderIcon.tsx'], suites: ['providers', 'agents-ui'] },
  // Recent workspaces (#144).
  { paths: ['src/main/recentWorkspaces.ts'], suites: ['recent', 'windows'] },
  { paths: ['src/renderer/src/components/Resizer.tsx'], suites: ['resize', 'progress'] },
  { paths: ['src/renderer/src/components/Sidebar.tsx'], suites: ['rail', 'windows'] },
  { paths: ['src/renderer/src/components/Tips.tsx', 'src/renderer/src/tips.ts', 'src/shared/tips.ts', 'src/shared/corner.ts', 'docs/USER_GUIDE.md'], suites: ['tips', 'tipcorner'] },
  { paths: ['src/renderer/src/components/TitleBar.tsx'], suites: ['windows', 'keys', 'carddialog', 'pin', 'closewindow', 'assistantside', 'startall', 'recent'] },
  { paths: ['src/main/pin.ts'], suites: ['pin', 'windows'] },
  { paths: ['src/renderer/src/scopedLoad.ts', 'src/shared/scoped.ts'], suites: ['loadfail'] },
  { paths: ['src/renderer/src/usage.ts', 'src/shared/liveUsage.ts', 'src/shared/usageDays.ts', 'src/shared/usageTotals.ts'], suites: ['overview', 'wsoverview', 'ctxpercent', 'context', 'unpricedcost'] },
  { paths: ['src/renderer/src/views/OtherViews.tsx'], suites: ['about', 'skills', 'drafts', 'windows', 'recent'] },
  { paths: ['src/renderer/src/views/ProjectTabs.tsx'], suites: ['overview', 'taskoverview', 'skillaudience', 'numbers', 'storage', 'unpricedcost'] },
  { paths: ['src/renderer/src/components/DataTable.tsx', 'src/shared/tableView.ts'], suites: ['overview', 'ctxpercent', 'performance'] },
  { paths: ['src/renderer/src/views/ProjectView.tsx'], suites: ['agents-ui', 'resumeall', 'paneheader', 'rail', 'tabstrip', 'startall'] },
  { paths: ['src/renderer/src/views/SettingsView.tsx'], suites: ['numbers', 'keys', 'providers', 'context', 'models'] },
  { paths: ['src/renderer/src/views/WorkspaceOverview.tsx'], suites: ['wsoverview', 'taskoverview', 'cardchip', 'unpricedcost'] },
  { paths: ['src/shared/instructions.ts'], suites: ['skilldelivery'] },
  { paths: ['src/shared/resumeAll.ts'], suites: ['resumeall'] },
  { paths: ['src/shared/projectTabs.ts'], suites: ['tabstrip', 'startall'] },
  { paths: ['src/shared/startAll.ts'], suites: ['startall'] },
  { paths: ['src/shared/startFailure.ts'], suites: ['startfail'] },
  { paths: ['src/renderer/src/assets/'], suites: ['about', 'providers'] },
  // The providers' adapters are under src/main/providers/ (every suite, above); these say which suites each mainly drives.
  { paths: ['src/main/providers/claude/'], suites: ['agents', 'agentview', 'launchrace', 'restart', 'resume', 'mode', 'compact', 'image', 'plan', 'claude-real'] },
  { paths: ['src/main/providers/codex/'], suites: ['codex', 'codex-background', 'codex-extra', 'codex-handover', 'codex-setup', 'attention', 'skilldelivery', 'sessiontree'] },
  // The run context: every suite (above); isolation checks what it gives a test Hive and the children a suite starts.
  { paths: ['tests/e2e/runContext.cjs', 'src/main/testQuiet.ts'], suites: ['isolation'] },
  // The fake Codex CLI: every suite that runs it.
  { paths: ['tests/e2e/fake-codex/'], suites: ['attention', 'footerfit', 'skilldelivery', 'models', 'sessiontree'] },
  // Hive's bundled skills and personas, read at runtime (not documentation).
  { paths: ['resources/skills/', 'src/main/bundledHistory.json'], suites: ['skills', 'skillaudience', 'skilldelivery', 'cardloop', 'replysize'] },
  { paths: ['resources/personas/'], suites: ['assistant', 'assistant-control', 'assistantend'] },
  // Bundled into the Docs view (About's licence pages, Release Notes, the Agent API reference).
  { paths: ['docs/', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/licenses.mjs', 'scripts/licenseText.mjs'], suites: ['about'] },
  // The installer's copies (npm run dist first).
  { paths: ['electron-builder.yml', 'scripts/dist.mjs', 'scripts/distCopy.mjs'], suites: ['packaged', 'packaged-mcp', 'packaged-progress', 'packaged-transcript'] }
]

/** Whether a repo path is under one of these paths (a file, or a folder ending in /). Case-insensitive, / separators. */
export function under(file, paths) {
  const f = file.replace(/\\/g, '/').toLowerCase()
  return paths.some((p) => {
    const q = p.toLowerCase()
    return q.endsWith('/') ? f.startsWith(q) : f === q
  })
}

/**
 * Files that need no suite: notes for people and agents (the skills for developing Hive, in .claude/skills and
 * .agents/skills, are neither shipped nor read by the app; Hive's own copies there are git-ignored), and the unit tests
 * (npm test runs those).
 */
export const DOCS_ONLY = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'RELEASING.md', 'tests/e2e/README.md', 'tests/scenarios/', 'reference/', '.gitattributes', '.gitignore', '.claude/skills/', '.agents/skills/']

/** Fixtures the fake CLIs answer with too (#125): a change to one needs the suites its area names, not only npm test. */
const FAKE_FIXTURES = ['tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json']

/** Whether a file is a unit test (tests/*.test.ts, their fixtures): npm test covers it, no e2e suite. */
const unitTest = (f) => /^tests\/[^/]+\.test\.ts$/i.test(f) || (/^tests\/fixtures\//i.test(f) && !FAKE_FIXTURES.includes(f))

/**
 * Hive's side of every real CLI: launching it, its hooks and the status they give, reading its transcripts, its
 * readiness, and the suites' CLI helpers. A change here needs every real-CLI suite (the real tier: run.mjs --real), not
 * only the fake ones. Each provider's own adapter (PROVIDER_OWN) needs only the real suites its area names.
 */
export const REAL_TIER = [
  'src/main/sessions.ts',
  'src/main/providers/',
  'src/main/providerService.ts',
  'src/main/ptyHost.ts',
  'src/main/hookStatus.ts',
  'src/main/transcripts.ts',
  'src/shared/providers.ts',
  'tests/e2e/lib.cjs',
  // The environment the real CLIs are started in.
  'tests/e2e/runContext.cjs'
]
const PROVIDER_OWN = ['src/main/providers/claude/', 'src/main/providers/codex/']

/**
 * The suites a set of changed files needs, from the known suite names (realNames: those that start a real CLI):
 * { all: true, why, real } when every fake suite is needed (real: the real-CLI suites also needed), else
 * { suites, why } (why: a line per reason). A real-CLI suite is needed when an area names it, its own file changed, or
 * a file in REAL_TIER (or one no area names) changed. Only DOCS_ONLY files and unit tests select nothing.
 */
export function affectedSuites(files, suiteNames, realNames = []) {
  const picked = new Set()
  const why = []
  let all = null
  let allReal = null
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/')
    const own = /^tests\/e2e\/([^/]+)\.cjs$/i.exec(file)
    if (own && suiteNames.includes(own[1])) {
      picked.add(own[1])
      why.push(`${file}: its own suite`)
      continue
    }
    if (under(file, REAL_TIER) && !under(file, PROVIDER_OWN)) allReal ??= `${file}: every real-CLI suite`
    const areas = AREAS.filter((a) => under(file, a.paths))
    for (const a of areas) for (const s of a.suites) picked.add(s)
    if (under(file, EVERYTHING)) {
      all ??= `${file}: shared by every part of Hive`
      continue
    }
    if (areas.length) {
      why.push(`${file}: ${[...new Set(areas.flatMap((a) => a.suites))].join(', ')}`)
      continue
    }
    if (under(file, DOCS_ONLY) || unitTest(file)) continue
    // Anything else (code, resources, scripts, build files no area names): everything, rather than guess.
    all ??= `${file}: no area names it, so every suite`
    allReal ??= `${file}: no area names it, so every real-CLI suite too`
  }
  const real = realNames.filter((n) => allReal || picked.has(n))
  if (all) return { all: true, why: [all, ...(allReal ? [allReal] : [])], real }
  return { suites: suiteNames.filter((n) => picked.has(n) || (allReal && realNames.includes(n))), why: [...why, ...(allReal ? [allReal] : [])] }
}

/** The files changed against a base (default main): committed since the merge base, uncommitted and untracked. */
export function changedFiles(base = 'main', cwd = process.cwd()) {
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)
  const mergeBase = git('merge-base', base, 'HEAD')[0]
  return [...new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])]
}
