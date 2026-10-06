import { useCallback, useEffect, useMemo, useState } from 'react'
import { EXPORT_MEASURES, SCENARIO_MEASURES, USAGE_MEASURES, compareArtifacts, compareScopeKey, type CompareScope, type Comparison, type KeptEntry, type MeasureDef, type MeasureDelta, type ScenarioComparison, type ScenarioStatus } from '@shared/benchmark'
import type { MetricsQuery } from '@shared/metrics'
import { money } from '@shared/usageTotals'
import { formatDateTime } from '@shared/dates'
import { call } from '../api'
import { Icon, IconButton, InfoTip, LoadFailed, Tooltip } from '../components/ui'
import { DataTable, useDateColumns, type DataColumn } from '../components/DataTable'
import { confirm, notify, prompt } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { cx, formatBytes, formatTokens } from '../util'

/**
 * Performance → Compare (#117): a baseline against a run, both kept for this page's scope (main/benchmarks.ts). Scenario
 * benchmarks (tests/scenarios, controlled) compare scenario by scenario, correctness first; Performance exports (real
 * use) compare per hour recorded. shared/benchmark.ts decides whether they are comparable and how each changed. The
 * scope is the page's: the whole workspace, its own work, or a project, and each lists and reads only its own.
 */

const STATUS: Record<ScenarioStatus, { label: string; tone: string; tip: string }> = {
  better: { label: 'Smaller, still correct', tone: 'success', tip: 'Less Hive context; every check that passed still passes and still runs; no more calls, failures or retries.' },
  same: { label: 'No change', tone: 'info', tip: 'Within 1% of the baseline, with the same correctness.' },
  worse: { label: 'Larger or worse', tone: 'warn', tip: 'More Hive context, more calls, failures or retries, or a check that passed (or ran) less often.' },
  'smaller-but-failing': { label: 'Smaller but failing', tone: 'error', tip: 'Less context, but a check passed (or ran) less often: not an improvement.' },
  failing: { label: 'Failing', tone: 'error', tip: 'Checks fail in the run (as often as in the baseline).' },
  incomplete: { label: 'Incomplete', tone: 'warn', tip: 'Not judged: no completed sample on a side, or what it’s judged by wasn’t fully measured.' },
  'only-in-base': { label: 'Only in baseline', tone: 'info', tip: 'The run didn’t run this scenario.' },
  'only-in-run': { label: 'Only in run', tone: 'info', tip: 'New in the run: no baseline for it.' }
}

/** Worst first: what needs looking at leads the table. */
const STATUS_ORDER: ScenarioStatus[] = ['smaller-but-failing', 'worse', 'failing', 'incomplete', 'better', 'same', 'only-in-base', 'only-in-run']

const MEASURE_DEFS = new Map([...SCENARIO_MEASURES, ...USAGE_MEASURES, ...EXPORT_MEASURES].map((m) => [m.key, m]))

function fmt(def: MeasureDef | undefined, v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  switch (def?.unit) {
    case 'bytes':
      return formatBytes(v)
    case 'tokens':
      return formatTokens(v)
    case 'usd':
      return money(v)
    case 'ms':
      return `${Math.round(v).toLocaleString()} ms`
    case 's':
      return `${Math.round(v)} s`
    default:
      return Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v).toLocaleString()
  }
}

function Delta({ d }: { d: MeasureDelta }) {
  if (d.incomplete)
    return (
      <Tooltip content="Some samples didn’t measure it: unknown, not compared.">
        <span className="warn-text">unknown</span>
      </Tooltip>
    )
  if (d.delta === null) return <span className="faint">—</span>
  const pct = d.pct === null ? '' : ` (${d.pct > 0 ? '+' : ''}${(d.pct * 100).toFixed(Math.abs(d.pct) < 0.1 ? 1 : 0)}%)`
  const tone = Math.abs(d.pct ?? (d.delta ? 1 : 0)) <= 0.01 ? 'faint' : d.delta < 0 ? 'good-text' : 'warn-text'
  return (
    <span className={tone}>
      {d.delta > 0 ? '+' : d.delta < 0 ? '−' : ''}
      {fmt(MEASURE_DEFS.get(d.key), Math.abs(d.delta))}
      {pct}
      {d.withinSpread ? <span className="faint"> ~</span> : null}
    </span>
  )
}

const range = (d: MeasureDelta, side: 'base' | 'run'): string => {
  const s = d[side]
  if (!s) return '—'
  const def = MEASURE_DEFS.get(d.key)
  return s.n > 1 && s.min !== s.max ? `${fmt(def, s.mean)} (${fmt(def, s.min)}–${fmt(def, s.max)})` : fmt(def, s.mean)
}

export function ComparePanel({ workspacePath, scope, query, keeps }: { workspacePath: string; scope: CompareScope; query: () => MetricsQuery; keeps: string }) {
  const scopeKey = compareScopeKey(scope)
  const [version, setVersion] = useState(0)
  const list = useScopedLoad<{ entries: KeptEntry[]; base: string | null; run: string | null; notice?: string }>(`${workspacePath}|${scopeKey}|${version}`)
  const { load: loadList } = list
  useEffect(() => {
    loadList(`${workspacePath}|${scopeKey}|${version}`, () => call('benchmarks:list', scope))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, scopeKey, version, loadList])
  const entries = list.data?.entries ?? []
  const [base, setBase] = useState<string | null>(null)
  const [run, setRun] = useState<string | null>(null)
  // The scope's remembered choice, or the two newest.
  useEffect(() => {
    if (!list.data) return
    setBase(list.data.base ?? list.data.entries[1]?.id ?? null)
    setRun(list.data.run ?? list.data.entries[0]?.id ?? null)
  }, [list.data])
  const choose = (b: string | null, r: string | null): void => {
    setBase(b)
    setRun(r)
    void call('benchmarks:select', scope, b, r).catch(() => undefined)
  }
  const refresh = (): void => setVersion((v) => v + 1)

  // The comparison: one per workspace, scope and pair, so a late answer for another (a switch while reading) is ignored.
  const pairKey = `${workspacePath}|${scopeKey}|${base}|${run}`
  const cmp = useScopedLoad<Comparison>(pairKey)
  const { load: loadCmp } = cmp
  useEffect(() => {
    if (!base || !run) return
    loadCmp(pairKey, async () => compareArtifacts(await call('benchmarks:read', scope, base), await call('benchmarks:read', scope, run)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, loadCmp])

  const importFile = async (): Promise<void> => {
    try {
      let r = await call('benchmarks:import', scope)
      if (r && 'ask' in r) {
        const ok = await confirm({
          title: `Use ${r.ask.project}’s part?`,
          message: `This is a workspace export. Only ${r.ask.project}’s part of it can be compared on this project’s page.`,
          detail: 'Work of no project (the Assistant, scripts) and other projects’ work are left out. Losses Hive couldn’t attribute to a project are noted.',
          confirmLabel: `Use ${r.ask.project}’s part`
        })
        r = await call('benchmarks:import', scope, { token: r.ask.token, useProjectPart: ok })
        if (!ok) return
      }
      if (!r) return
      if ('error' in r) return notify('error', 'Can’t compare that file', r.error)
      if ('entry' in r) {
        notify('success', 'Kept for comparison', r.entry.label)
        refresh()
      }
    } catch (e) {
      notify('error', 'Could not import the file', String((e as Error).message ?? e))
    }
  }
  const keepCurrent = async (): Promise<void> => {
    const label = await prompt({ title: 'Keep the current view', message: 'It is kept with its scope, range and filters, to compare with later.', placeholder: 'Before the guidance change', confirmLabel: 'Keep' })
    if (label === null) return
    try {
      const e = await call('benchmarks:keep', query(), label)
      notify('success', 'Kept for comparison', e.label)
      refresh()
    } catch (err) {
      notify('error', 'Could not keep the current view', String((err as Error).message ?? err))
    }
  }

  return (
    <div className="perf-compare">
      <div className="overview-head perf-controls">
        <label className="perf-filter">
          Baseline
          <select className="input" value={base ?? ''} onChange={(e) => choose(e.target.value || null, run)} aria-label="Baseline">
            <option value="">—</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="perf-filter">
          Run
          <select className="input" value={run ?? ''} onChange={(e) => choose(base, e.target.value || null)} aria-label="Run">
            <option value="">—</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <IconButton icon="arrow-swap" title="Swap baseline and run" onClick={() => choose(run, base)} disabled={!base && !run} />
        <div className="grow" />
        <Tooltip content="Import a scenario benchmark (tests/scenarios: benchmark.json) or a Performance export (JSON).">
          <button className="btn small subtle" onClick={() => void importFile()}>
            <Icon name="cloud-upload" /> Import…
          </button>
        </Tooltip>
        <Tooltip content={`Keep what the Now view shows to compare with later: ${keeps}.`}>
          <button className="btn small subtle" onClick={() => void keepCurrent()}>
            <Icon name="pin" /> Keep current view
          </button>
        </Tooltip>
      </div>

      {list.error && <LoadFailed what="the kept comparisons" error={list.error} onRetry={refresh} />}
      {list.data?.notice && (
        <div className="banner info perf-banner">
          <Icon name="info" /> {list.data.notice}
        </div>
      )}
      {list.data && entries.length < 2 && (
        <div className="empty-state perf-empty">
          <Icon name="git-compare" />
          {entries.length ? 'Keep or import one more to compare.' : 'Nothing to compare yet.'}
          <span className="hint">
            Import a scenario benchmark ({scope.kind === 'project' || scope.own ? 'with the whole workspace selected: a benchmark is its whole test workspace’s' : '`npm run scenarios` writes benchmark.json'}) or a Performance export, or keep the current view before a change and again after it.
          </span>
        </div>
      )}
      {base && run && base === run && <p className="hint">The baseline and the run are the same file.</p>}
      {cmp.error && <LoadFailed what="the comparison" error={cmp.error} onRetry={() => loadCmp(pairKey, async () => compareArtifacts(await call('benchmarks:read', scope, base!), await call('benchmarks:read', scope, run!)))} />}
      {cmp.data && base && run && base !== run && <ComparisonView c={cmp.data} base={entries.find((e) => e.id === base)} run={entries.find((e) => e.id === run)} />}

      {entries.length > 0 && <KeptList entries={entries} scope={scope} onChange={refresh} />}
    </div>
  )
}

function ComparisonView({ c, base, run }: { c: Comparison; base?: KeptEntry; run?: KeptEntry }) {
  return (
    <div className="perf-comparison">
      <dl className="perf-pair hint">
        <dt>Baseline</dt>
        <dd>{base?.about ?? '—'}</dd>
        <dt>Run</dt>
        <dd>{run?.about ?? '—'}</dd>
      </dl>
      {c.comparable ? (
        <div className="banner success perf-banner">
          <Icon name="check" /> Comparable: {c.kind === 'scenarios' ? 'the same scenarios, provider and setup.' : 'the same scope and filters, per hour recorded.'}
        </div>
      ) : (
        <div className="banner warn perf-banner">
          <Icon name="warning" /> Not comparable: {c.reasons.join(' ')} The numbers are shown, but a difference doesn’t mean a change.
        </div>
      )}
      {c.notes.length > 0 && (
        <ul className="perf-notes hint">
          {c.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {c.kind === 'scenarios' && c.scenarios && <ScenarioTable scenarios={c.scenarios} summary={c.summary} />}
      {c.kind === 'export' && c.rows && <DataTable id="perf-compare-measures" rows={c.rows} columns={MEASURE_COLUMNS} rowKey={(d) => d.key} empty="Nothing measured." />}
    </div>
  )
}

function ScenarioTable({ scenarios, summary }: { scenarios: ScenarioComparison[]; summary: Comparison['summary'] }) {
  const [open, setOpen] = useState<string | null>(null)
  // Worst first, then by name: the table's default order (the Result column, ascending).
  const rows = useMemo(() => [...scenarios].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id.localeCompare(b.id)), [scenarios])
  const toggle = useCallback((s: ScenarioComparison) => setOpen((o) => (o === s.id ? null : s.id)), [])
  const columns = useMemo((): DataColumn<ScenarioComparison>[] => scenarioColumns(open), [open])
  return (
    <>
      <p className="perf-summary">
        {STATUS_ORDER.filter((s) => summary[s]).map((s) => (
          <span key={s} className={`badge ${STATUS[s].tone}`}>
            {summary[s]} {STATUS[s].label.toLowerCase()}
          </span>
        ))}
      </p>
      <DataTable
        id="perf-compare-scenarios"
        className="perf-scenarios"
        rows={rows}
        columns={columns}
        rowKey={(s) => s.id}
        defaultSort={WORST_FIRST}
        defaultPageSize={50}
        onRowClick={toggle}
        rowLabel={(s) => `${s.id}: ${STATUS[s.status].label}. ${open === s.id ? 'Close' : 'Open'} its measures`}
        rowClassName={(s) => open === s.id && 'selected'}
        detail={detailOf(open)}
        empty="No scenarios."
      />
      <p className="hint">Sizes are exact bytes and characters of what Hive gave the sessions; tokens are only what a provider reported. Skills on disk are what was available, not what a model read. A ~ marks a change within the samples’ spread.</p>
    </>
  )
}

const WORST_FIRST = { key: 'result', desc: false }
/** The open scenario's measures, under its row. */
const detailOf = (open: string | null) => (s: ScenarioComparison) => (open === s.id ? <ScenarioDetail s={s} /> : null)
const measureOf = (s: ScenarioComparison, k: string): MeasureDelta | undefined => s.measures.find((m) => m.key === k)
/** A change as a sortable number: its share where there is one, else its size; unknown and none sort last. */
const changeOf = (d: MeasureDelta | undefined): number | null => (!d || d.incomplete || d.delta === null ? null : (d.pct ?? d.delta))

function scenarioColumns(open: string | null): DataColumn<ScenarioComparison>[] {
  return [
    {
      key: 'scenario',
      header: 'Scenario',
      cell: (s) => (
        <>
          <Icon name={open === s.id ? 'chevron-down' : 'chevron-right'} /> {s.id}
        </>
      ),
      sortValue: (s) => s.id,
      filter: { kind: 'text', value: (s) => `${s.id} ${s.title}` }
    },
    {
      key: 'result',
      header: 'Result',
      cell: (s) => (
        <Tooltip content={STATUS[s.status].tip}>
          <span className={`badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
        </Tooltip>
      ),
      sortValue: (s) => STATUS_ORDER.indexOf(s.status),
      filter: { kind: 'choice', value: (s) => STATUS[s.status].label }
    },
    {
      key: 'checks',
      header: 'Checks',
      headerTip: "On average a sample: checks passed ✓, failed ✗ and skipped – (a check only a model's own work can meet is skipped for a fake), baseline → run.",
      num: true,
      descFirst: true,
      cell: (s) => (
        <span className={cx(s.regressions.length > 0 && 'warn-text')}>
          {s.quality.base.n ? counts(s.checks.base) : '—'} → {s.quality.run.n ? counts(s.checks.run) : '—'}
        </span>
      ),
      sortValue: (s) => (s.quality.run.n ? s.checks.run.failed : null)
    },
    {
      key: 'context',
      header: 'Hive context',
      headerTip: MEASURE_DEFS.get('contextBytes')!.tip,
      num: true,
      descFirst: true,
      cell: (s) => {
        const ctx = measureOf(s, 'contextBytes')
        return ctx ? (
          <>
            {range(ctx, 'run')} <Delta d={ctx} />
          </>
        ) : (
          '—'
        )
      },
      sortValue: (s) => changeOf(measureOf(s, 'contextBytes'))
    },
    {
      key: 'tool',
      header: 'Tool replies',
      num: true,
      descFirst: true,
      cell: (s) => {
        const tool = measureOf(s, 'toolChars')
        return tool ? <Delta d={tool} /> : '—'
      },
      sortValue: (s) => changeOf(measureOf(s, 'toolChars'))
    },
    {
      key: 'calls',
      header: 'Calls (repeated)',
      num: true,
      descFirst: true,
      cell: (s) => {
        const calls = measureOf(s, 'hiveCalls')
        const rep = measureOf(s, 'repeatedCalls')
        return (
          <>
            {calls?.run ? `${fmt(undefined, calls.run.mean)} (${fmt(undefined, rep?.run?.mean ?? 0)})` : '—'} {calls ? <Delta d={calls} /> : null}
          </>
        )
      },
      sortValue: (s) => measureOf(s, 'hiveCalls')?.run?.mean ?? null
    }
  ]
}

/** An export comparison's measures: baseline, run and the change (sortable, the biggest change first). */
const MEASURE_COLUMNS: DataColumn<MeasureDelta>[] = [
  {
    key: 'measure',
    header: 'Measure',
    cell: (d) => (
      <>
        {MEASURE_DEFS.get(d.key)?.label} <InfoTip text={MEASURE_DEFS.get(d.key)?.tip ?? ''} />
      </>
    )
  },
  { key: 'base', header: 'Baseline', num: true, cell: (d) => range(d, 'base') },
  { key: 'run', header: 'Run', num: true, cell: (d) => range(d, 'run') },
  { key: 'change', header: 'Change', num: true, descFirst: true, cell: (d) => <Delta d={d} />, sortValue: (d) => changeOf(d) }
]

/** A side's checks on average: passed, failed, skipped. */
const counts = (c: { passed: number; failed: number; skipped: number }): string => {
  const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  return `${n(c.passed)}✓${c.failed ? ` ${n(c.failed)}✗` : ''}${c.skipped ? ` ${n(c.skipped)}–` : ''}`
}

function ScenarioDetail({ s }: { s: ScenarioComparison }) {
  const rows = [...s.measures, ...(s.usage ?? [])]
  return (
    <div className="perf-detail-body">
      <p>
        <strong>{s.title}</strong> · samples {s.samples.base} → {s.samples.run}
      </p>
      {s.notes.length > 0 && (
        <ul className="perf-notes hint">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {s.regressions.length > 0 && (
        <div className="perf-regressions">
          <strong className="warn-text">Checks that passed or ran less often</strong>
          <ul>
            {s.regressions.map((r) => (
              <li key={r.name}>
                {r.name}: {counts(r.base)} → {counts(r.run)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.failedChecks.length > 0 && (
        <p className="hint">
          Failed in the run: <span className="warn-text">{s.failedChecks.join('; ')}</span>
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Measure</th>
            <th className="num">Baseline</th>
            <th className="num">Run</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((d) => d.base || d.run)
            .map((d) => (
              <tr key={d.key}>
                <td>
                  {MEASURE_DEFS.get(d.key)?.label ?? d.key} <InfoTip text={MEASURE_DEFS.get(d.key)?.tip ?? ''} />
                </td>
                <td className="num">{range(d, 'base')}</td>
                <td className="num">{range(d, 'run')}</td>
                <td className="num">
                  <Delta d={d} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {!s.usage && <p className="hint">Provider tokens and cost: not compared (a fake’s are simulated; a model trial’s only when every sample on both sides reported them).</p>}
    </div>
  )
}

/** The kept list's columns: what it is, its kind, when it was kept, and pin and remove. */
function keptColumns(scope: CompareScope, act: (fn: () => Promise<unknown>) => Promise<void>): DataColumn<KeptEntry>[] {
  return [
    {
      key: 'label',
      header: 'Kept',
      cell: (e) => (
        <>
          <Icon name={e.kind === 'scenarios' ? 'beaker' : 'pulse'} /> {e.label}
          <div className="faint">{e.about}</div>
        </>
      ),
      sortValue: (e) => e.label,
      filter: { kind: 'text', value: (e) => `${e.label} ${e.about}` }
    },
    { key: 'kind', header: 'Kind', className: 'nowrap', cell: (e) => KIND[e.kind], sortValue: (e) => KIND[e.kind], filter: { kind: 'choice', value: (e) => KIND[e.kind] } },
    { key: 'keptAt', header: 'When', num: true, descFirst: true, className: 'faint', cell: (e) => formatDateTime(e.keptAt), sortValue: (e) => e.keptAt, filter: { kind: 'text', value: (e) => formatDateTime(e.keptAt) } },
    {
      key: 'actions',
      header: '',
      num: true,
      className: 'nowrap',
      cell: (e) => (
        <>
          <IconButton icon={e.pinned ? 'pinned' : 'pin'} title={e.pinned ? 'Unpin' : 'Pin (never removed to make room)'} onClick={() => void act(() => call('benchmarks:pin', scope, e.id, !e.pinned))} />
          <IconButton icon="trash" title="Remove" onClick={() => void act(() => call('benchmarks:remove', scope, e.id))} />
        </>
      )
    }
  ]
}

const KIND: Record<KeptEntry['kind'], string> = { scenarios: 'Scenario benchmark', export: 'Performance view' }

function KeptList({ entries, scope, onChange }: { entries: KeptEntry[]; scope: CompareScope; onChange: () => void }) {
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      onChange()
    } catch (e) {
      notify('error', 'Could not change the kept comparisons', String((e as Error).message ?? e))
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useDateColumns(useMemo(() => keptColumns(scope, act), [scope]))
  return (
    <details className="perf-kept">
      <summary>
        Kept for comparison ({entries.length}) <InfoTip text="Kept in the workspace’s .hive/metrics/benchmarks (this machine’s), at most 20: when full, the oldest unpinned one goes. Pin one to keep it." />
      </summary>
      <DataTable
        id="perf-kept"
        rows={entries}
        columns={columns}
        rowKey={(e) => e.id}
        defaultPageSize={10}
        filterFrom={10}
        empty="Nothing kept."
      />
    </details>
  )
}
