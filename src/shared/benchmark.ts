/**
 * Comparing two measurements of Hive's own costs (#117): scenario benchmarks (tests/scenarios writes them,
 * "hive-benchmark/1": controlled runs, each sample with its correctness checks) and Performance exports
 * ("hive-metrics/1": real use over a range, kept as a summary). Pure, so the app and tests share it. Every file, imported
 * or kept, is read through the same normalisers as untrusted input (nothing is cast and returned as it was). A
 * comparison says whether the two can be compared at all (and why not), compares like with like (the same scenarios,
 * scope, filters), keeps what wasn't measured unknown (never zero), and never calls a smaller result better when the work
 * it did got worse: fewer checks passing or running, or more failures, calls or retries.
 */
import { utf8Bytes, type MetricsScope } from './metrics'

export const BENCHMARK_SCHEMA = 'hive-benchmark/1'
export const METRICS_EXPORT_SCHEMA = 'hive-metrics/1'

/** Bounds on what is read and kept: an artifact is checked as untrusted input. */
export const BENCHMARK_LIMITS = { fileBytes: 2 * 1024 * 1024, scenarios: 100, samples: 20, checks: 60, failedChecks: 20, skills: 60, text: 200, kept: 20, projects: 100, series: 2000 }

/**
 * What a comparison is about: the whole workspace, the workspace's own work (no project's: the Assistant, scripts), or
 * one project. A scenario benchmark is the whole workspace's; an export is its scope's (own work is its own scope).
 */
export type CompareScope = { kind: 'workspace'; own?: true } | { kind: 'project'; project: string }

/** A scope's key: the workspace, its own work, or a project (by name, case-insensitive). */
export const compareScopeKey = (s: CompareScope): string => (s.kind === 'project' ? `project:${s.project.toLowerCase()}` : s.own ? 'own' : 'workspace')

/** A page's scope as a comparison's: the workspace view with "Workspace's own work" chosen is its own scope. */
export const compareScopeOf = (scope: MetricsScope, own: boolean): CompareScope => (scope.kind === 'project' ? scope : own ? { kind: 'workspace', own: true } : { kind: 'workspace' })

const scopeName = (s: CompareScope): string => (s.kind === 'project' ? `project ${s.project}` : s.own ? 'the workspace’s own work' : 'the whole workspace')

/** Each measure: what it is, its unit, and how to read a change. All are "less is better". */
export interface MeasureDef {
  key: string
  label: string
  unit: 'bytes' | 'chars' | 'count' | 'ms' | 'tokens' | 'usd' | 's'
  group: 'context' | 'traffic' | 'work' | 'failures' | 'skills' | 'provider' | 'time'
  /** What it says about the run, shown on hover. */
  tip: string
}

/** A scenario sample's measures (tests/scenarios/harness.cjs measuresOf), with what the comparison derives from them. */
export const SCENARIO_MEASURES: MeasureDef[] = [
  { key: 'contextBytes', label: 'Hive context', unit: 'bytes', group: 'context', tip: 'What Hive put in the session’s context: launch guidance (core, project, role, persona, skills’ catalog), the hive tools’ list and every tool reply. Exact UTF-8 bytes, not tokens. Unknown if any part wasn’t measured.' },
  { key: 'guidanceBytes', label: 'Launch guidance', unit: 'bytes', group: 'context', tip: 'Core contract, project additions, the Assistant’s role and persona, and the skills’ catalog, at launch.' },
  { key: 'guidanceChars', label: 'Launch guidance (characters)', unit: 'chars', group: 'context', tip: 'The same parts in characters (UTF-16 code units); the catalog has bytes only.' },
  { key: 'toolListBytes', label: 'Tool list', unit: 'bytes', group: 'context', tip: 'The hive tools’ names, descriptions and schemas as the CLI got them.' },
  { key: 'toolChars', label: 'Tool replies', unit: 'chars', group: 'context', tip: 'Characters of the hive tools’ replies, as the model got them.' },
  { key: 'toolBytes', label: 'Tool replies (bytes)', unit: 'bytes', group: 'context', tip: 'UTF-8 bytes of the same replies.' },
  { key: 'toolCalls', label: 'Tool calls', unit: 'count', group: 'work', tip: 'hive tool calls measured by the bridge.' },
  { key: 'toolDetailCalls', label: 'Detail calls', unit: 'count', group: 'work', tip: 'Calls that asked for the full form.' },
  { key: 'hiveCalls', label: 'Calls run', unit: 'count', group: 'work', tip: 'hive tool calls the server ran (its own log).' },
  { key: 'repeatedCalls', label: 'Repeated calls', unit: 'count', group: 'work', tip: 'Calls identical to one already made: work done twice.' },
  { key: 'hiveCallErrors', label: 'Failed calls', unit: 'count', group: 'failures', tip: 'hive tool calls that failed.' },
  { key: 'toolErrors', label: 'Tool errors', unit: 'count', group: 'failures', tip: 'Tool replies that were errors (the bridge’s count).' },
  { key: 'apiFailed', label: 'API failures', unit: 'count', group: 'failures', tip: 'Refused, failed or cancelled requests.' },
  { key: 'apiCancelled', label: 'API cancelled', unit: 'count', group: 'failures', tip: 'Requests the client gave up on.' },
  { key: 'apiRequests', label: 'API requests', unit: 'count', group: 'traffic', tip: 'Agent API requests by the session (and agents it started), not the harness’s own.' },
  { key: 'apiResponseBytes', label: 'API sent', unit: 'bytes', group: 'traffic', tip: 'Response bodies Hive’s API sent.' },
  { key: 'apiRequestBytes', label: 'API received', unit: 'bytes', group: 'traffic', tip: 'Request bodies Hive’s API received.' },
  { key: 'apiMs', label: 'API time', unit: 'ms', group: 'time', tip: 'Time Hive spent on the requests, in all.' },
  { key: 'skillBytes', label: 'Skills on disk', unit: 'bytes', group: 'skills', tip: 'Delivered skills’ bytes: what was available, not what a model read.' },
  { key: 'skillsNotDelivered', label: 'Skills not given', unit: 'count', group: 'skills', tip: 'Skills asked for that the session didn’t get.' },
  { key: 'skillScans', label: 'Skill scans', unit: 'count', group: 'skills', tip: 'The skill service’s scans during the scenario.' },
  { key: 'skillHits', label: 'Skill cache hits', unit: 'count', group: 'skills', tip: 'Skills found unchanged (more is fine: shown for the cache scenarios).' },
  { key: 'skillMisses', label: 'Skill cache misses', unit: 'count', group: 'skills', tip: 'Skills read again (changed, or not cached).' },
  { key: 'skillInvalidations', label: 'Skill changes seen', unit: 'count', group: 'skills', tip: 'Kept revisions found changed.' },
  { key: 'skillBytesRead', label: 'Skill bytes read', unit: 'bytes', group: 'skills', tip: 'Bytes the skill service read from disk.' },
  { key: 'seconds', label: 'Duration', unit: 's', group: 'time', tip: 'The scenario’s run, start to end (a model trial’s varies most).' }
]

/** Provider-reported usage of a scenario's session: model trials only (a fake's is simulated), and only when both report it. */
export const USAGE_MEASURES: MeasureDef[] = [
  { key: 'inputTokens', label: 'Input tokens', unit: 'tokens', group: 'provider', tip: 'As the provider reported them.' },
  { key: 'cacheReadTokens', label: 'Cache read', unit: 'tokens', group: 'provider', tip: 'As the provider reported them.' },
  { key: 'cacheWriteTokens', label: 'Cache write', unit: 'tokens', group: 'provider', tip: 'As the provider reported them.' },
  { key: 'outputTokens', label: 'Output tokens', unit: 'tokens', group: 'provider', tip: 'Reasoning included, as the provider reported them.' },
  { key: 'reasoningTokens', label: 'of it reasoning', unit: 'tokens', group: 'provider', tip: 'Part of output, not added to it.' },
  { key: 'requests', label: 'Provider requests', unit: 'count', group: 'provider', tip: 'Model requests the session made.' },
  { key: 'costUsd', label: 'Cost', unit: 'usd', group: 'provider', tip: 'API-equivalent; only when every sample on both sides has a cost (≈ when Hive estimated one).' }
]

/** A Performance export's summary measures: per hour Hive was recording, so ranges of different lengths compare. */
export const EXPORT_MEASURES: MeasureDef[] = [
  { key: 'requests', label: 'API requests', unit: 'count', group: 'traffic', tip: 'Agent API requests, per hour recorded.' },
  { key: 'failed', label: 'Failed or cancelled', unit: 'count', group: 'failures', tip: 'Per hour recorded.' },
  { key: 'responseBytes', label: 'API sent', unit: 'bytes', group: 'traffic', tip: 'Per hour recorded.' },
  { key: 'toolCalls', label: 'Tool calls', unit: 'count', group: 'work', tip: 'Per hour recorded.' },
  { key: 'toolChars', label: 'Tool replies', unit: 'chars', group: 'context', tip: 'Characters, per hour recorded.' },
  { key: 'detailCalls', label: 'Detail calls', unit: 'count', group: 'work', tip: 'Per hour recorded.' },
  { key: 'launches', label: 'Launches', unit: 'count', group: 'work', tip: 'Per hour recorded.' },
  { key: 'guidancePerLaunch', label: 'Guidance a launch', unit: 'bytes', group: 'context', tip: 'Core, project, role, persona and catalog, on average (not per hour).' }
]

// ---------------------------------------------------------------------------
// Artifacts, as kept (validated and normalised).
// ---------------------------------------------------------------------------

export type Measures = Record<string, number>

export interface Check {
  name: string
  /** Passed, failed, or null: skipped (a check only a model's own work can meet, skipped for a fake). */
  ok: boolean | null
}

export interface Sample {
  /**
   * Passed every check that ran (and at least one ran); false: some failed; null: it didn't complete, or no check ran,
   * so its correctness isn't known.
   */
  ok: boolean | null
  incomplete?: string
  passed: number
  failed: number
  skipped: number
  checks: Check[]
  failedChecks: string[]
  /** The session was given other guidance than Hive had when the run started (a stale launch): left out. */
  stale: boolean
  /** A resumed session: its provider usage is the whole conversation's, so it isn't compared. */
  resumed: boolean
  measures: Measures | null
  usage: Measures | null
  /** Whether the usage's cost was Hive's estimate. */
  costEstimated: boolean
  /** How complete the measurement was: recording on, measurements dropped, what made it partial. */
  coverage: { recording: boolean | null; dropped: number; partial: string[] }
  /** The guidance and each skill's revision the session was given at launch (name → revision). */
  guidance: string | null
  skills: Record<string, string> | null
}

export interface ScenarioResult {
  id: string
  title: string
  role: string
  samples: Sample[]
}

export interface BenchmarkRun {
  fixturesVersion: number
  provider: string
  providerId: string
  real: boolean
  model: string
  effort: string
  mode: string | null
  cliVersions: string[]
  repeats: number
  source: { head: string; dirty: string | null }
  sourceChangedDuringRun: boolean
  guidance: string | null
  authorization: string | null
  spentUsd: number
  /** Trials that reported no cost: the spend is `spentUsd` plus these, unknown in all. */
  unknownCostTrials: number
  seconds: number
  metricsOverheadMs: number
}

/** A Performance export, kept as its summary (the totals the comparison needs, for its scope and filters). */
export interface ExportSummary {
  from: string
  to: string
  observedMs: number
  rangeMs: number
  filters: { role?: string; provider?: string; own?: boolean }
  /** Totals in the range (not per hour). */
  totals: Measures
  /** Measurements dropped or not attributable: the totals may be low. */
  partial: string[]
}

export interface Artifact {
  schema: typeof BENCHMARK_SCHEMA | typeof METRICS_EXPORT_SCHEMA
  kind: 'scenarios' | 'export'
  label: string
  createdAt: string
  appVersion: string
  scope: CompareScope
  /** Derived from a workspace export: one project's part, explicitly chosen. */
  derived?: string
  run?: BenchmarkRun
  scenarios?: ScenarioResult[]
  summary?: ExportSummary
}

const COMPONENT_KEYS = ['coreBytes', 'customBytes', 'roleBytes', 'personaBytes', 'catalogBytes', 'coreChars', 'customChars', 'roleChars', 'personaChars', 'toolBytes', 'toolListBytes']
const DERIVED = new Set(['contextBytes', 'guidanceBytes', 'guidanceChars', 'seconds'])
const MEASURE_KEYS = new Set([...SCENARIO_MEASURES.map((m) => m.key).filter((k) => !DERIVED.has(k)), ...COMPONENT_KEYS, 'toolMs', 'launches', 'skillsDelivered', 'skillsUnmeasured', 'toolListStarts', 'skillTooLarge', 'dropped', 'skillsRead'])
const USAGE_KEYS = new Set([...USAGE_MEASURES.map((m) => m.key), 'contextTokens'])
const EXPORT_KEYS = new Set(['requests', 'failed', 'responseBytes', 'requestBytes', 'toolCalls', 'toolChars', 'detailCalls', 'launches', 'guidanceBytes'])

const text = (v: unknown, max = BENCHMARK_LIMITS.text): string =>
  String(typeof v === 'string' || typeof v === 'number' ? v : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const iso = (v: unknown): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : '')
const sum = (m: Measures, keys: string[]): number | null => (keys.every((k) => typeof m[k] === 'number') ? keys.reduce((n, k) => n + m[k], 0) : null)

/** Known measures with valid values only (unknown keys and bad values left out, never guessed or zero-filled). */
function readMeasures(v: unknown, keys: Set<string>): Measures | null {
  const o = obj(v)
  if (!o) return null
  const out: Measures = {}
  for (const k of keys) {
    const n = num(o[k])
    if (n !== null) out[k] = n
  }
  return out
}

/**
 * A sample, from a harness file or a kept artifact alike. Derived totals exist only when every part they add up is
 * known; a missing part leaves them unknown. Correctness is recomputed from the counts: a sample whose checks all
 * skipped is unknown, not passed.
 */
function readSample(v: unknown): Sample | null {
  const o = obj(v)
  if (!o) return null
  const raw = obj(o.measures)
  let measures = raw ? readMeasures(raw, MEASURE_KEYS) : null
  if (measures) {
    const guidance = sum(measures, ['coreBytes', 'customBytes', 'roleBytes', 'personaBytes', 'catalogBytes'])
    const guidanceChars = sum(measures, ['coreChars', 'customChars', 'roleChars', 'personaChars'])
    if (guidance !== null) {
      measures.guidanceBytes = guidance
      const ctx = sum(measures, ['toolListBytes', 'toolBytes'])
      if (ctx !== null) measures.contextBytes = guidance + ctx
    }
    if (guidanceChars !== null) measures.guidanceChars = guidanceChars
    const secs = num(o.seconds) ?? num(raw?.seconds)
    if (secs !== null) measures = { ...measures, seconds: secs }
  }
  const resumed = o.resumed === true
  const u = !resumed ? (obj(o.usage) ?? obj(raw?.usage)) : null
  const usage = u ? readMeasures(u, USAGE_KEYS) : null
  // The check list, when there is one, is what counts: its own counts, and any failure in it fails the sample. A list
  // that can't be trusted (too long to read whole, an entry that isn't a check, a check listed twice) or counts that
  // disagree with it leave the sample's correctness unknown.
  let problem: string | undefined
  const checks: Check[] = []
  if (Array.isArray(o.checks)) {
    if (o.checks.length > BENCHMARK_LIMITS.checks) problem = 'too many checks to read'
    for (const c of o.checks.slice(0, BENCHMARK_LIMITS.checks)) {
      const co = obj(c)
      if (!co || typeof co.name !== 'string' || !(co.ok === true || co.ok === false || co.ok === null)) {
        problem ??= 'a check in it isn’t valid'
        continue
      }
      const name = text(co.name)
      if (checks.some((x) => x.name === name)) problem ??= 'a check is listed twice'
      else checks.push({ name, ok: co.ok as boolean | null })
    }
  } else if (o.checks !== undefined) problem = 'its checks aren’t a list'
  const listed = Array.isArray(o.checks) && o.checks.length > 0
  const count = (key: 'passed' | 'failed' | 'skipped', want: boolean | null): number => {
    const fromList = checks.filter((c) => c.ok === want).length
    const given = num(o[key])
    if (listed && given !== null && given !== fromList) problem ??= 'its check counts don’t match its checks'
    return listed ? fromList : (given ?? 0)
  }
  const passed = count('passed', true)
  const failed = count('failed', false)
  const skipped = count('skipped', null)
  if (o.ok === false && failed === 0 && listed) problem ??= 'it says it failed, but no check did'
  const incomplete = typeof o.incomplete === 'string' ? text(o.incomplete) : problem
  // Passed only if it completed, nothing failed and something was checked.
  const ok = incomplete !== undefined || o.ok === null ? null : failed > 0 || o.ok === false ? false : passed > 0 ? true : null
  const cov = obj(o.coverage)
  const skills = obj(o.skills)
  const skillMap: Record<string, string> = {}
  for (const [k, rev] of Object.entries(skills ?? {}).slice(0, BENCHMARK_LIMITS.skills)) if (/^[a-z0-9][\w-]{0,63}$/i.test(k) && typeof rev === 'string') skillMap[k] = text(rev, 64)
  return {
    ok,
    ...(incomplete !== undefined ? { incomplete } : ok === null && o.ok !== null ? { incomplete: 'no check ran' } : {}),
    passed,
    failed,
    skipped,
    checks,
    failedChecks: arr(o.failedChecks, BENCHMARK_LIMITS.failedChecks).map((x) => text(x)),
    stale: o.stale === true,
    resumed,
    measures,
    usage,
    costEstimated: u?.costEstimated === true || o.costEstimated === true,
    coverage: {
      recording: cov?.recording === true ? true : cov?.recording === false ? false : null,
      dropped: num(cov?.dropped) ?? 0,
      partial: arr(cov?.partial, 10).map((x) => text(x))
    },
    guidance: typeof o.guidance === 'string' ? text(o.guidance, 64) : null,
    skills: skills ? skillMap : null
  }
}

function readScope(v: unknown): CompareScope | null {
  const o = obj(v)
  if (o?.kind === 'workspace') return o.own === true ? { kind: 'workspace', own: true } : { kind: 'workspace' }
  if (o?.kind === 'project' && typeof o.project === 'string' && o.project && o.project.length <= 255 && !/[\\/\0|]/.test(o.project)) return { kind: 'project', project: o.project }
  return null
}

function readRun(v: unknown): BenchmarkRun | null {
  const run = obj(v)
  if (!run || num(run.fixturesVersion) === null || typeof run.provider !== 'string') return null
  const src = obj(run.source)
  return {
    fixturesVersion: num(run.fixturesVersion)!,
    provider: text(run.provider, 40),
    providerId: text(run.providerId, 40),
    real: run.real === true,
    model: text(run.model, 80) || '(default)',
    effort: text(run.effort, 40) || '(default)',
    mode: typeof run.mode === 'string' ? text(run.mode, 40) : null,
    cliVersions: arr(run.cliVersions, 5).map((x) => text(x, 60)),
    repeats: num(run.repeats) ?? 1,
    source: { head: text(src?.head, 40), dirty: typeof src?.dirty === 'string' ? text(src.dirty, 40) : null },
    sourceChangedDuringRun: run.sourceChangedDuringRun === true,
    guidance: typeof run.guidance === 'string' ? text(run.guidance, 64) : null,
    authorization: typeof run.authorization === 'string' ? text(run.authorization) : null,
    spentUsd: num(run.spentUsd) ?? 0,
    unknownCostTrials: num(run.unknownCostTrials) ?? 0,
    seconds: num(run.seconds) ?? 0,
    metricsOverheadMs: num(run.metricsOverheadMs) ?? 0
  }
}

function readScenarios(v: unknown): ScenarioResult[] {
  const scenarios: ScenarioResult[] = []
  for (const s of arr(v, BENCHMARK_LIMITS.scenarios)) {
    const so = obj(s)
    if (!so || typeof so.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(so.id) || !Array.isArray(so.samples) || scenarios.some((x) => x.id === so.id)) continue
    const samples = arr(so.samples, BENCHMARK_LIMITS.samples)
      .map(readSample)
      .filter((x): x is Sample => !!x)
    scenarios.push({ id: so.id, title: text(so.title), role: so.role === 'assistant' ? 'assistant' : 'agent', samples })
  }
  return scenarios
}

/** Which totals each kind of series adds to (an unreadable series leaves exactly these unknown). */
const SERIES_TOTALS: Record<'api' | 'mcp' | 'guidance', string[]> = { api: ['requests', 'failed', 'responseBytes', 'requestBytes'], mcp: ['toolCalls', 'toolChars', 'detailCalls'], guidance: ['launches', 'guidanceBytes'] }

/**
 * A report part's totals added into `t`. A series that is missing, isn't a list, is longer than can be read, or has an
 * entry whose numbers aren't valid makes the totals it adds to unknown (in `unknown`), never zero: a damaged measurement
 * is no measurement.
 */
function partTotals(p: unknown, t: Measures, unknown: Set<string>): void {
  const o = obj(p)
  if (!o) {
    for (const keys of Object.values(SERIES_TOTALS)) for (const k of keys) unknown.add(k)
    return
  }
  for (const kind of ['api', 'mcp', 'guidance'] as const) {
    const v = o[kind]
    const mark = (...keys: string[]): void => keys.forEach((k) => unknown.add(k))
    if (!Array.isArray(v) || v.length > BENCHMARK_LIMITS.series) {
      mark(...SERIES_TOTALS[kind])
      if (!Array.isArray(v)) continue
    }
    for (const raw of v.slice(0, BENCHMARK_LIMITS.series)) {
      const x = obj(raw)
      if (!x) {
        mark(...SERIES_TOTALS[kind])
        continue
      }
      const add = (key: string, value: unknown): void => {
        const n = num(value)
        if (n === null) unknown.add(key)
        else t[key] += n
      }
      if (kind === 'api') {
        const n = num(x.count)
        if (n === null || typeof x.outcome !== 'string') mark('requests', 'failed')
        else {
          t.requests += n
          if (x.outcome !== 'ok') t.failed += n
        }
        add('responseBytes', x.responseBytes)
        add('requestBytes', x.requestBytes)
      } else if (kind === 'mcp') {
        const n = num(x.count)
        if (n === null || typeof x.mode !== 'string') mark('toolCalls', 'detailCalls')
        else {
          t.toolCalls += n
          if (x.mode === 'detail') t.detailCalls += n
        }
        add('toolChars', x.chars)
      } else {
        add('launches', x.launches)
        const parts = [x.guidanceBytes, x.customBytes ?? 0, x.roleBytes ?? 0, x.personaBytes ?? 0, x.skillCatalogBytes].map(num)
        if (parts.some((n) => n === null)) unknown.add('guidanceBytes')
        else t.guidanceBytes += (parts as number[]).reduce((a, b) => a + b, 0)
      }
    }
  }
}

const emptyTotals = (): Measures => ({ requests: 0, failed: 0, responseBytes: 0, requestBytes: 0, toolCalls: 0, toolChars: 0, detailCalls: 0, launches: 0, guidanceBytes: 0 })

/** Whether a report part has any measurement in it (a part that can't be read counts as having some: it isn't empty). */
const hasData = (p: unknown): boolean => {
  if (p === undefined) return false
  const t = emptyTotals()
  const unknown = new Set<string>()
  partTotals(p, t, unknown)
  return unknown.size > 0 || Object.values(t).some((n) => n > 0)
}

/**
 * A report (or an export's) as a kept summary: totals of its parts (only `project`'s, when given), its coverage, and what
 * makes it partial. The report is untrusted: every part and series is checked as it is added, and a total any damaged
 * piece adds to is left out (unknown), never zero.
 */
export function summaryOf(report: unknown, project?: string): ExportSummary {
  const r = obj(report) ?? {}
  const unknown = new Set<string>()
  const all = Object.entries(obj(r.projects) ?? {})
  if (all.length > BENCHMARK_LIMITS.projects || !obj(r.projects)) for (const k of EXPORT_KEYS) unknown.add(k)
  const totals = emptyTotals()
  for (const [name, part] of all.slice(0, BENCHMARK_LIMITS.projects)) if (project === undefined || name.toLowerCase() === project.toLowerCase()) partTotals(part, totals, unknown)
  if (project === undefined && r.workspace !== undefined) partTotals(r.workspace, totals, unknown)
  const filters = obj(r.filters) ?? {}
  const coverage = obj(r.coverage) ?? {}
  const dropped = num(r.dropped) ?? 0
  const partial: string[] = []
  if (dropped > 0) partial.push(`${dropped} measurements dropped (a limit was full)`)
  if (r.lossesUnattributed === true || (project !== undefined && (num(r.droppedUntracked) ?? 0) > 0)) partial.push('some losses couldn’t be attributed to a project')
  if (typeof coverage.evictedThrough === 'string') partial.push('history removed for space in the range')
  if (project !== undefined) partial.push('one project’s part of a workspace export')
  if (unknown.size) partial.push(`some of its measurements weren’t valid, so ${[...unknown].join(', ')} ${unknown.size === 1 ? 'is' : 'are'} unknown`)
  const from = iso(r.from)
  const to = iso(r.to)
  const observed = num(coverage.observedMs)
  return {
    from,
    to,
    observedMs: observed ?? 0,
    rangeMs: num(coverage.rangeMs) ?? Math.max(0, Date.parse(to) - Date.parse(from) || 0),
    filters: { ...(typeof filters.role === 'string' ? { role: text(filters.role, 20) } : {}), ...(typeof filters.provider === 'string' ? { provider: text(filters.provider, 40) } : {}), ...(filters.own === true ? { own: true } : {}) },
    totals: Object.fromEntries(Object.entries(totals).filter(([k]) => !unknown.has(k))),
    partial
  }
}

/** A kept summary, re-read (Hive wrote it, but the file is on disk). A total it doesn't have is unknown. */
function readSummary(v: unknown): ExportSummary | null {
  const s = obj(v)
  const totals = s ? readMeasures(s.totals, EXPORT_KEYS) : null
  if (!s || !totals) return null
  const f = obj(s.filters) ?? {}
  return {
    from: iso(s.from),
    to: iso(s.to),
    observedMs: num(s.observedMs) ?? 0,
    rangeMs: num(s.rangeMs) ?? 0,
    filters: { ...(typeof f.role === 'string' ? { role: text(f.role, 20) } : {}), ...(typeof f.provider === 'string' ? { provider: text(f.provider, 40) } : {}), ...(f.own === true ? { own: true } : {}) },
    totals,
    partial: arr(s.partial, 10).map((x) => text(x))
  }
}

export type ParseResult = { artifact: Artifact } | { error: string } | { projectPart: { project: string } }

/**
 * Reads a file as an artifact for a scope (the page's), checked as untrusted input. A scenario benchmark is the whole
 * workspace's: never a project's or the own work's. An export must be for the same scope, and its contents must agree
 * with the scope it claims (a project's export holding other projects' or the workspace's data is refused). A workspace
 * export on a project's page offers that project's part, used only when asked (`useProjectPart`). Sanitized exports
 * can't be matched to a project.
 */
export function parseArtifact(textValue: string, scope: CompareScope, opts: { useProjectPart?: boolean } = {}): ParseResult {
  if (utf8Bytes(textValue) > BENCHMARK_LIMITS.fileBytes) return { error: `It is over ${BENCHMARK_LIMITS.fileBytes / 1024 / 1024} MB.` }
  let data: Record<string, unknown> | null
  try {
    data = obj(JSON.parse(textValue))
  } catch {
    return { error: 'It isn’t JSON.' }
  }
  if (!data) return { error: 'It isn’t a Hive benchmark or Performance export.' }
  const app = obj(data.app)
  if (data.schema === BENCHMARK_SCHEMA) {
    if (scope.kind === 'project') return { error: 'A scenario benchmark is its own test workspace’s, not one of your projects: compare it in the Performance view (activity bar), with the whole workspace selected.' }
    if (scope.own) return { error: 'A scenario benchmark is its whole test workspace’s, not the workspace’s own work: compare it with the whole workspace selected.' }
    const run = readRun(data.run)
    if (!run || !Array.isArray(data.scenarios)) return { error: 'It isn’t a valid scenario benchmark (no run, fixtures version or scenarios).' }
    const scenarios = readScenarios(data.scenarios)
    if (!scenarios.length) return { error: 'It has no valid scenarios.' }
    return { artifact: { schema: BENCHMARK_SCHEMA, kind: 'scenarios', label: text(data.label) || `${run.provider} benchmark`, createdAt: iso(data.createdAt), appVersion: text(app?.version, 40), scope: { kind: 'workspace' }, run, scenarios } }
  }
  if (data.schema === METRICS_EXPORT_SCHEMA) {
    const report = obj(data.report)
    const fileScope = readScope(report?.scope)
    const projects = obj(report?.projects)
    if (!report || !fileScope || !projects) return { error: 'It isn’t a valid Performance export (no report, scope or projects).' }
    const own = obj(report.filters)?.own === true
    const base = { schema: METRICS_EXPORT_SCHEMA as typeof METRICS_EXPORT_SCHEMA, kind: 'export' as const, createdAt: iso(data.exportedAt), appVersion: text(app?.version, 40) }
    const sanitized = data.sanitized === true
    const range = `${iso(report.from).slice(0, 10)} to ${iso(report.to).slice(0, 10)}`
    const names = Object.keys(projects)
    if (scope.kind === 'workspace') {
      if (fileScope.kind !== 'workspace') return { error: `It is project ${text(fileScope.project, 80)}’s export: compare it on that project’s page.` }
      if (own !== !!scope.own) return { error: own ? 'It is the workspace’s own work: compare it with “Workspace’s own work” selected.' : 'It is the whole workspace’s: compare it with the whole workspace selected.' }
      // Own work has no project's part: one that does isn't what it says.
      if (own && names.some((n) => hasData(projects[n]))) return { error: 'It says it is the workspace’s own work, but it holds projects’ data: not imported.' }
      return { artifact: { ...base, label: `Export ${range}${own ? ', own work' : ''}`, scope: own ? { kind: 'workspace', own: true } : { kind: 'workspace' }, summary: summaryOf(report) } }
    }
    if (fileScope.kind === 'project') {
      if (sanitized) return { error: 'It is sanitized (project names replaced), so it can’t be matched to this project.' }
      if (fileScope.project.toLowerCase() !== scope.project.toLowerCase()) return { error: `It is project ${text(fileScope.project, 80)}’s export, not ${scope.project}’s.` }
      // Its contents must be its project's only.
      const others = names.filter((n) => n.toLowerCase() !== scope.project.toLowerCase() && hasData(projects[n]))
      if (others.length || hasData(report.workspace)) return { error: `It says it is ${scope.project}’s, but it also holds ${others.length ? 'other projects’' : 'the workspace’s own'} data: not imported.` }
      return { artifact: { ...base, label: `Export ${range}`, scope, summary: summaryOf(report, scope.project) } }
    }
    // A workspace export on a project's page: only that project's part, and only when asked for.
    if (sanitized) return { error: 'It is sanitized (project names replaced), so this project’s part can’t be found.' }
    if (own) return { error: 'It is the workspace’s own work: it has no project’s part.' }
    if (!names.some((n) => n.toLowerCase() === scope.project.toLowerCase())) return { error: `It is a workspace export with no part for ${scope.project}.` }
    if (!opts.useProjectPart) return { projectPart: { project: scope.project } }
    return { artifact: { ...base, label: `Export ${range}, ${scope.project}’s part`, scope, derived: 'one project’s part of a workspace export', summary: summaryOf(report, scope.project) } }
  }
  return { error: 'It isn’t a Hive benchmark (hive-benchmark/1) or Performance export (hive-metrics/1).' }
}

/**
 * Re-reads a kept artifact through the same normalisers (Hive wrote it, but the file is on disk): a fresh, bounded
 * object, never the one read. Null if it isn't a valid one.
 */
export function readKept(v: unknown): Artifact | null {
  const a = obj(v)
  const scope = readScope(a?.scope)
  if (!a || !scope) return null
  const base = { label: text(a.label, 80), createdAt: iso(a.createdAt), appVersion: text(a.appVersion, 40), scope, ...(typeof a.derived === 'string' ? { derived: text(a.derived) } : {}) }
  if (a.kind === 'scenarios') {
    const run = readRun(a.run)
    const scenarios = readScenarios(a.scenarios)
    if (!run || !scenarios.length || scope.kind !== 'workspace' || scope.own) return null
    return { ...base, schema: BENCHMARK_SCHEMA, kind: 'scenarios', run, scenarios }
  }
  if (a.kind === 'export') {
    const summary = readSummary(a.summary)
    if (!summary || !!summary.filters.own !== (scope.kind === 'workspace' && !!scope.own)) return null
    return { ...base, schema: METRICS_EXPORT_SCHEMA, kind: 'export', summary }
  }
  return null
}

/** A kept comparison file, as the Performance page lists it (main/benchmarks.ts keeps them). */
export interface KeptEntry {
  id: string
  label: string
  kind: Artifact['kind']
  scope: CompareScope
  createdAt: string
  keptAt: string
  pinned: boolean
  /** One line saying what it is (provider and model, or the export's range and filters). */
  about: string
}

/** An index entry re-read: a fresh, checked object or null. */
export function readEntry(v: unknown): KeptEntry | null {
  const e = obj(v)
  const scope = readScope(e?.scope)
  if (!e || !scope || typeof e.id !== 'string' || !/^[0-9a-f]{12}$/.test(e.id) || (e.kind !== 'scenarios' && e.kind !== 'export')) return null
  return { id: e.id, label: text(e.label, 80), kind: e.kind, scope, createdAt: iso(e.createdAt), keptAt: iso(e.keptAt) || new Date(0).toISOString(), pinned: e.pinned === true, about: text(e.about, 300) }
}

/** An import: kept, refused (with why), or a question (use a workspace export's part for this project?). */
export type ImportResult = { entry: KeptEntry } | { error: string } | { ask: { token: string; project: string } }

/** What a kept artifact is, in a line (provider and model, or an export's range and filters). */
export function aboutOf(a: Artifact): string {
  if (a.kind === 'scenarios' && a.run) {
    const r = a.run
    const spend = r.real ? `, spent $${r.spentUsd}${r.unknownCostTrials ? ` + ${r.unknownCostTrials} unpriced (total unknown)` : ''}` : ''
    return `${r.real ? 'Model trial' : 'Fake'} ${r.provider}${r.real ? ` ${r.model} (${r.effort}, ${r.mode ?? '–'})` : ''}, fixtures v${r.fixturesVersion}, ${a.scenarios?.length ?? 0} scenarios × ${r.repeats}, source ${r.source.head}${r.source.dirty ? '+' : ''}${spend}`
  }
  const s = a.summary!
  const f = [s.filters.role ?? 'everyone', s.filters.provider ?? 'all providers', s.filters.own ? 'own work' : ''].filter(Boolean).join(', ')
  return `${s.from.slice(0, 16).replace('T', ' ')} to ${s.to.slice(0, 16).replace('T', ' ')}: ${f}${a.derived ? ` (${a.derived})` : ''}`
}

// ---------------------------------------------------------------------------
// Comparing.
// ---------------------------------------------------------------------------

export interface Stat {
  n: number
  mean: number
  min: number
  max: number
}

const stat = (xs: number[]): Stat | null => (xs.length ? { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null)

export interface MeasureDelta {
  key: string
  base: Stat | null
  run: Stat | null
  /** run.mean − base.mean, and as a share of base (null when base is 0 or either is missing or incomplete). */
  delta: number | null
  pct: number | null
  /** Both have several samples and their ranges overlap: the change is within the spread. */
  withinSpread: boolean
  /** Some samples didn't measure it: unknown, not zero, and not compared. */
  incomplete: boolean
}

export type ScenarioStatus = 'better' | 'same' | 'worse' | 'smaller-but-failing' | 'failing' | 'incomplete' | 'only-in-base' | 'only-in-run'

export interface CheckChange {
  name: string
  /** Of the usable samples: how many passed, failed, skipped it, on each side. */
  base: { passed: number; failed: number; skipped: number }
  run: { passed: number; failed: number; skipped: number }
}

export interface ScenarioComparison {
  id: string
  title: string
  status: ScenarioStatus
  /** Usable samples (completed, not stale) and how many passed every check that ran. */
  quality: { base: { passed: number; n: number }; run: { passed: number; n: number } }
  /** Checks on average a usable sample: passed, failed, skipped. */
  checks: { base: { passed: number; failed: number; skipped: number }; run: { passed: number; failed: number; skipped: number } }
  /** Checks that passed less often, or ran less often (skipped more), in the run. */
  regressions: CheckChange[]
  /** Failed checks in the run's samples (names). */
  failedChecks: string[]
  samples: { base: number; run: number }
  measures: MeasureDelta[]
  usage: MeasureDelta[] | null
  notes: string[]
}

export interface Comparison {
  kind: 'scenarios' | 'export'
  comparable: boolean
  /** Why they can't be compared (when not comparable), or what differs that a reader should know. */
  reasons: string[]
  notes: string[]
  scenarios?: ScenarioComparison[]
  rows?: MeasureDelta[]
  summary: Partial<Record<ScenarioStatus, number>>
}

/** A change this small (or smaller) is "the same": exact sizes still move by a few bytes (a card number, a date). */
const SAME_PCT = 0.01

function deltaOf(key: string, base: Sample[] | number[], run: Sample[] | number[], pick?: (s: Sample) => number | undefined): MeasureDelta {
  const values = (xs: Sample[] | number[]): { vals: number[]; missing: boolean } => {
    if (!pick) return { vals: xs as number[], missing: false }
    const vals = (xs as Sample[]).map(pick)
    return { vals: vals.filter((x): x is number => typeof x === 'number'), missing: vals.some((x) => typeof x !== 'number') }
  }
  const b = values(base)
  const r = values(run)
  const bs = stat(b.vals)
  const rs = stat(r.vals)
  const incomplete = b.missing || r.missing
  const delta = bs && rs && !incomplete ? rs.mean - bs.mean : null
  return { key, base: bs, run: rs, delta, pct: delta !== null && bs!.mean > 0 ? delta / bs!.mean : null, withinSpread: !!(bs && rs && bs.n > 1 && rs.n > 1 && rs.min <= bs.max && bs.min <= rs.max), incomplete }
}

/** Usable: completed, correctness known, and not given stale guidance. */
const usable = (s: Sample): boolean => s.ok !== null && !s.stale

/** Per check name, how many of the samples passed, failed and skipped it. */
function checkCounts(samples: Sample[]): Map<string, { passed: number; failed: number; skipped: number }> {
  const m = new Map<string, { passed: number; failed: number; skipped: number }>()
  for (const s of samples)
    for (const c of s.checks) {
      const e = m.get(c.name) ?? { passed: 0, failed: 0, skipped: 0 }
      if (c.ok === true) e.passed++
      else if (c.ok === false) e.failed++
      else e.skipped++
      m.set(c.name, e)
    }
  return m
}

const avg = (xs: Sample[], f: (s: Sample) => number): number => (xs.length ? xs.reduce((n, s) => n + f(s), 0) / xs.length : 0)

/** Measures that mean more failures or more work when they grow: a growth is a regression, whatever the size did. */
const FAILURE_KEYS = ['hiveCallErrors', 'toolErrors', 'apiFailed', 'apiCancelled', 'repeatedCalls', 'hiveCalls']

function compareScenario(id: string, base: ScenarioResult | undefined, run: ScenarioResult | undefined, compareUsage: boolean): ScenarioComparison {
  const title = run?.title || base?.title || id
  const zero = { passed: 0, failed: 0, skipped: 0 }
  const empty = { quality: { base: { passed: 0, n: 0 }, run: { passed: 0, n: 0 } }, checks: { base: zero, run: zero }, regressions: [], failedChecks: [] }
  if (!base || !run) return { id, title, status: base ? 'only-in-base' : 'only-in-run', ...empty, samples: { base: base?.samples.length ?? 0, run: run?.samples.length ?? 0 }, measures: [], usage: null, notes: [] }
  const b = base.samples.filter(usable)
  const r = run.samples.filter(usable)
  const notes: string[] = []
  const all = [...base.samples, ...run.samples]
  const stale = all.filter((s) => s.stale).length
  if (stale) notes.push(`${stale} sample${stale === 1 ? '' : 's'} left out: the session was given other guidance than the run started with (stale).`)
  const incomplete = all.filter((s) => s.ok === null && !s.stale)
  if (incomplete.length) notes.push(`${incomplete.length} sample${incomplete.length === 1 ? '' : 's'} left out: ${[...new Set(incomplete.map((s) => s.incomplete ?? 'didn’t complete'))].join('; ')}.`)
  if (b.length === 1 || r.length === 1) notes.push('One sample on a side: no spread to judge a change by.')
  const partial = [...b, ...r].filter((s) => s.coverage.recording !== true || s.coverage.dropped > 0 || s.coverage.partial.length || !s.measures)
  if (partial.length) notes.push(`${partial.length} sample${partial.length === 1 ? '' : 's'} measured partly (recording off, measurements dropped or missing): sizes aren’t judged.`)
  // Skill revisions the sessions were given: different on the two sides (an edited skill) is said.
  const revs = (xs: Sample[]): string => [...new Set(xs.map((s) => JSON.stringify(s.skills ?? {})))].join('|')
  if (b.length && r.length && revs(b) !== revs(r)) {
    const names = new Set<string>()
    for (const s of [...b, ...r]) for (const [k, v] of Object.entries(s.skills ?? {})) if ([...b, ...r].some((x) => (x.skills ?? {})[k] !== v)) names.add(k)
    notes.push(`The sessions were given different skill revisions${names.size ? ` (${[...names].slice(0, 6).join(', ')})` : ''}.`)
  }
  const quality = { base: { passed: b.filter((s) => s.ok).length, n: b.length }, run: { passed: r.filter((s) => s.ok).length, n: r.length } }
  const checks = { base: { passed: avg(b, (s) => s.passed), failed: avg(b, (s) => s.failed), skipped: avg(b, (s) => s.skipped) }, run: { passed: avg(r, (s) => s.passed), failed: avg(r, (s) => s.failed), skipped: avg(r, (s) => s.skipped) } }
  // Check by check: one that passed (or ran) less often in the run is a regression, whatever the samples' summary says.
  const bc = checkCounts(b)
  const rc = checkCounts(r)
  const regressions: CheckChange[] = []
  for (const name of new Set([...bc.keys(), ...rc.keys()])) {
    const x = bc.get(name) ?? zero
    const y = rc.get(name) ?? zero
    const share = (c: typeof zero, n: number): number => (n ? c.passed / n : 0)
    const ran = (c: typeof zero, n: number): number => (n ? (c.passed + c.failed) / n : 0)
    const fails = (c: typeof zero, n: number): number => (n ? c.failed / n : 0)
    if (b.length && r.length && (share(y, r.length) < share(x, b.length) || ran(y, r.length) < ran(x, b.length) || fails(y, r.length) > fails(x, b.length))) regressions.push({ name, base: x, run: y })
  }
  const failedChecks = [...new Set(r.flatMap((s) => s.failedChecks))].slice(0, BENCHMARK_LIMITS.failedChecks)
  const measures = SCENARIO_MEASURES.map((m) => deltaOf(m.key, b, r, (s) => s.measures?.[m.key]))
  // Provider usage: model trials only, and only when every usable sample on both sides reported it.
  let usageRows: MeasureDelta[] | null = null
  if (compareUsage && b.length && r.length) {
    usageRows = USAGE_MEASURES.map((m) => deltaOf(m.key, b, r, (s) => s.usage?.[m.key])).filter((d) => !d.incomplete)
    if (!usageRows.length) {
      usageRows = null
      if ([...b, ...r].some((s) => s.usage)) notes.push('Provider usage isn’t compared: not every sample reported it.')
    }
    if ([...b, ...r].some((s) => s.costEstimated)) notes.push('Some costs are Hive’s estimates (≈), not the provider’s.')
  }
  if ([...b, ...r].some((s) => s.resumed)) notes.push('A resumed session’s provider usage is its whole conversation’s: left out.')
  const samples = { base: base.samples.length, run: run.samples.length }
  if (!b.length || !r.length) return { id, title, status: 'incomplete', quality, checks, regressions, failedChecks, samples, measures, usage: usageRows, notes }
  const rate = (q: { passed: number; n: number }): number => q.passed / q.n
  const get = (k: string): MeasureDelta => measures.find((m) => m.key === k)!
  const context = get('contextBytes')
  const sizeKnown = !partial.length && !context.incomplete && context.delta !== null
  const smaller = sizeKnown && (context.pct ?? 0) < -SAME_PCT
  const larger = sizeKnown && ((context.pct ?? 0) > SAME_PCT || (context.base?.mean === 0 && (context.run?.mean ?? 0) > 0))
  const moreFailures = FAILURE_KEYS.some((k) => (get(k).delta ?? 0) > 0)
  const failureUnknown = FAILURE_KEYS.some((k) => get(k).incomplete)
  const correctnessWorse = regressions.length > 0 || rate(quality.run) < rate(quality.base)
  let status: ScenarioStatus
  if (correctnessWorse) status = smaller ? 'smaller-but-failing' : 'worse'
  else if (quality.run.passed < quality.run.n) status = 'failing'
  else if (moreFailures || larger) status = 'worse'
  else if (!sizeKnown || failureUnknown) status = 'incomplete'
  else if (smaller) status = 'better'
  else status = 'same'
  if (status === 'incomplete') notes.push('Not judged: some of what it’s judged by wasn’t measured.')
  if (status === 'better' && context.withinSpread) notes.push('Smaller on average, but within the samples’ spread.')
  return { id, title, status, quality, checks, regressions, failedChecks, samples, measures, usage: usageRows, notes }
}

const sameScope = (a: CompareScope, b: CompareScope): boolean => compareScopeKey(a) === compareScopeKey(b)

/**
 * Compares a baseline with a run: scenario benchmarks scenario by scenario (only the ones both ran; correctness first),
 * exports measure by measure per hour recorded. Not comparable (and said why) when they measured different things:
 * another scope, kind, scenarios' version, provider, model or setup, a fake against a model, a run whose source changed
 * while it ran, or exports of other filters.
 */
export function compareArtifacts(base: Artifact, run: Artifact): Comparison {
  const reasons: string[] = []
  const notes: string[] = []
  if (base.kind !== run.kind) return { kind: run.kind, comparable: false, reasons: ['One is a scenario benchmark and the other a Performance export: they measure different things.'], notes, summary: {} }
  if (!sameScope(base.scope, run.scope)) reasons.push(`Different scopes: ${scopeName(base.scope)} and ${scopeName(run.scope)}.`)
  if (base.kind === 'scenarios' && base.run && run.run && base.scenarios && run.scenarios) {
    const a = base.run
    const b = run.run
    if (a.fixturesVersion !== b.fixturesVersion) reasons.push(`Different scenario versions (fixtures v${a.fixturesVersion} and v${b.fixturesVersion}): the scenarios themselves changed.`)
    if (a.real !== b.real) reasons.push('A fake provider against a model trial: a fake proves routing and sizes, not a model’s behaviour.')
    if (a.providerId !== b.providerId || a.provider !== b.provider) reasons.push(`Different providers (${a.provider} and ${b.provider}).`)
    if (a.real && b.real && (a.model !== b.model || a.effort !== b.effort || a.mode !== b.mode)) reasons.push(`Different model setups (${a.model}, ${a.effort}, ${a.mode ?? '–'} and ${b.model}, ${b.effort}, ${b.mode ?? '–'}).`)
    for (const [side, r] of [['baseline', a] as const, ['run', b] as const]) if (r.sourceChangedDuringRun) reasons.push(`The ${side}’s source changed while it ran: its samples may mix two versions.`)
    if (a.real && b.real && a.cliVersions.join() !== b.cliVersions.join()) notes.push(`CLI versions differ (${a.cliVersions.join(', ') || '?'} and ${b.cliVersions.join(', ') || '?'}).`)
    if (a.guidance && b.guidance && a.guidance === b.guidance) notes.push('Both ran the same guidance revision: differences are in the tools, the API, the skills or the run itself.')
    const realUsage = a.real && b.real
    if (!realUsage) notes.push('Provider usage isn’t compared: a fake’s tokens are simulated, not a provider’s.')
    const ids = [...new Set([...base.scenarios.map((s) => s.id), ...run.scenarios.map((s) => s.id)])]
    const scenarios = ids.map((id) =>
      compareScenario(
        id,
        base.scenarios!.find((s) => s.id === id),
        run.scenarios!.find((s) => s.id === id),
        realUsage
      )
    )
    const summary: Partial<Record<ScenarioStatus, number>> = {}
    for (const s of scenarios) summary[s.status] = (summary[s.status] ?? 0) + 1
    return { kind: 'scenarios', comparable: reasons.length === 0, reasons, notes, scenarios, summary }
  }
  if (base.kind === 'export' && base.summary && run.summary) {
    const a = base.summary
    const b = run.summary
    const f = (x: ExportSummary['filters']): string => `${x.role ?? 'everyone'}, ${x.provider ?? 'all providers'}${x.own ? ', own work' : ''}`
    if (f(a.filters) !== f(b.filters)) reasons.push(`Different filters (${f(a.filters)} and ${f(b.filters)}).`)
    if (!a.observedMs || !b.observedMs) reasons.push('Hive wasn’t recording in one of the ranges: there is nothing to compare.')
    for (const [side, s] of [['baseline', a] as const, ['run', b] as const]) if (s.partial.length) notes.push(`The ${side} is partial: ${s.partial.join('; ')}.`)
    if (Math.abs(a.rangeMs - b.rangeMs) > 3_600_000) notes.push('The ranges differ in length: compared per hour recorded.')
    const known = (s: ExportSummary, ...keys: string[]): boolean => keys.every((k) => typeof s.totals[k] === 'number')
    const perHour = (s: ExportSummary, k: string): number[] => (s.observedMs ? [s.totals[k] / (s.observedMs / 3_600_000)] : [])
    const rows = EXPORT_MEASURES.map((m) => {
      const keys = m.key === 'guidancePerLaunch' ? ['launches', 'guidanceBytes'] : [m.key]
      // Unknown on a side (a damaged measurement in its file): shown as unknown, never compared.
      if (!known(a, ...keys) || !known(b, ...keys)) return { key: m.key, base: null, run: null, delta: null, pct: null, withinSpread: false, incomplete: true }
      return m.key === 'guidancePerLaunch'
        ? deltaOf(m.key, a.totals.launches ? [a.totals.guidanceBytes / a.totals.launches] : [], b.totals.launches ? [b.totals.guidanceBytes / b.totals.launches] : [])
        : deltaOf(m.key, perHour(a, m.key), perHour(b, m.key))
    })
    notes.push('Real use isn’t a controlled workload: a change here can be the work that was done, not Hive.')
    return { kind: 'export', comparable: reasons.length === 0, reasons, notes, rows, summary: {} }
  }
  return { kind: run.kind, comparable: false, reasons: ['One of them is incomplete.'], notes, summary: {} }
}
