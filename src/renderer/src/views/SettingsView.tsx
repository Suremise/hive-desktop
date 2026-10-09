import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ChimeSound, EffortLevel, EffortOption, FallbackModel, ModelPrice, PermissionMode, ProviderId, TaskColumn } from '@shared/types'
import { DEFAULT_COLUMN_COLORS, TASK_COLUMNS, columnColor } from '@shared/tasks'
import { DEFAULT_PERSONA } from '@shared/assistant'
import { PRICES_CHECKED, SHIPPED_PRICES, priceRows } from '@shared/prices'
import { APP_SETTINGS_CATALOG, SETTINGS_SECTIONS, providerSection, settingDefault, settingPatch, settingValue, type SettingEntry, type SettingsSection } from '@shared/settingsCatalog'
import { effortText, fallbackEfforts, fallbackModels, modelSource, modelSourceText, runsAsName } from '@shared/models'
import type { SettingsPatch } from '@shared/api'
import { AUTO_PROVIDER, PROVIDERS, defaultProviderLabel, enabledProviders, isProviderEnabled, offeredModes, permissionLabel, providerDescriptor, providerSettings } from '@shared/providers'
import { usePersonas } from '../components/Assistant'
import { ModeCaveat } from '../components/AgentDialogs'
import { EffortPicker, ModelPicker } from '../components/ModelPicker'
import { NumberField } from '../components/NumberField'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { playChime } from '../chime'
import { Icon, IconButton, InfoTip, SearchInput, Switch, Tooltip } from '../components/ui'
import { UpdateStatusRow } from '../components/Updates'
import { KeybindingsEditor } from '../components/Keybindings'
import { HiddenProjectsList } from '../components/ProjectRemoval'
import { WorkspaceStorageList } from '../components/Storage'
import { AntivirusPanel } from '../components/Antivirus'
import { choose, confirm, get, notify, set, useStore } from '../store'
import { cx } from '../util'

/** A settings section: a group of AppSettings, "providers" (turning them on), one provider's page ("provider:<id>"), or "advanced". */
type Section = SettingsSection

/** A row of Settings: its catalog entry (the text, the control, the flags), and the control the view draws for a custom one. */
interface SettingDef extends SettingEntry {
  render?: () => React.ReactNode
}

const SECTION_ICONS: Record<string, string> = { general: 'settings-gear', updates: 'cloud-download', appearance: 'symbol-color', providers: 'hubot', notifications: 'bell', sessions: 'history', assistant: 'person', workspace: 'root-folder', board: 'project', agents: 'organization', keybindings: 'keyboard', agentApi: 'broadcast', advanced: 'tools' }

const SECTIONS: { id: Section; label: string; icon: string; desc: string; provider?: ProviderId }[] = SETTINGS_SECTIONS.map((s) => ({ ...s, icon: SECTION_ICONS[s.id] ?? 'blank' }))

/** The controls Settings draws itself (custom rows), by catalog id; the catalog has their text (settingsCatalog.ts). */
const CONTROLS: Record<string, () => React.ReactNode> = {
  'updates.status': () => <UpdateStatusRow />,
  'keybindings.editor': () => <KeybindingsEditor />,
  'providers.list': () => <ProvidersList />,
  'providers.defaultProvider': () => <DefaultProviderPicker />,
  'notifications.chimeSound': () => <ChimePicker />,
  'sessions.usageCacheClear': () => <ClearUsageCacheButton />,
  'sessions.resetPerformance': () => <ResetMetricsButton />,
  'workspace.hiddenProjects': () => <HiddenProjectsList />,
  'workspace.storage': () => <WorkspaceStorageList />,
  'workspace.antivirus': () => <AntivirusPanel />,
  'board.colors': () => <ColumnColors />,
  'assistant.provider': () => <AssistantProviderPicker />,
  'assistant.persona': () => <AssistantPersonaPicker />,
  ...Object.fromEntries(PROVIDERS.map((p) => [`assistant.provider:${p.id}`, () => <AssistantProviderDefaults provider={p.id} />])),
  'agentApi.status': () => <ApiStatus />,
  'agentApi.token': () => <ApiToken />,
  'advanced.logs': () => (
    <button className="btn subtle" onClick={() => void call('app:openLogs')}>
      <Icon name="output" /> Open logs
    </button>
  ),
  'advanced.data': () => <DataFolder />,
  'advanced.reset': () => <ResetAll />
}

/** A provider page's custom controls, by key. */
function providerControl(provider: ProviderId, key: string): (() => React.ReactNode) | undefined {
  switch (key) {
    case 'enabled':
      return () => <ProviderToggle provider={provider} />
    case 'status':
      return () => <ProviderStatus provider={provider} />
    case 'defaultModel':
      return () => <GlobalModelPicker provider={provider} />
    case 'defaultEffort':
      return () => <GlobalEffortPicker provider={provider} />
    case 'modelFallback':
      return () => <ModelFallbackTable provider={provider} />
    case 'effortFallback':
      return () => <EffortFallbackTable provider={provider} />
    case 'prices':
      return () => <PriceTable provider={provider} />
  }
  return undefined
}

// Fields drawn as part of another row (the Assistant's "With <provider>") aren't rows of their own.
const SETTINGS: SettingDef[] = APP_SETTINGS_CATALOG.filter((e) => !e.hidden).map((e) => ({ ...e, render: e.provider ? providerControl(e.provider, e.key) : CONTROLS[e.id] }))

/** The price table for a provider's models: Hive's prices (editable defaults), with the user's changes, added and removed models (#125). */
function PriceTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const ps = providerSettings(settings, provider)
  const own = ps.prices
  const removed = ps.pricesRemoved ?? []
  const shipped = SHIPPED_PRICES[provider] ?? {}
  const rows = priceRows(provider, settings)
  const [adding, setAdding] = useState('')
  const cols: { key: keyof ModelPrice; label: string }[] = [
    { key: 'input', label: 'Input' },
    { key: 'cachedInput', label: 'Cached input' },
    ...(Object.values(shipped).some((m) => m.cacheWrite !== undefined) ? [{ key: 'cacheWrite' as const, label: 'Cache write' }] : []),
    { key: 'output', label: 'Output' }
  ]
  const save = (next: Record<string, ModelPrice>, nextRemoved: string[] = removed): Promise<void> =>
    // Replaces the whole table (a deep merge can't remove a model's override).
    actions.attempt('Could not save prices', () => call('settings:setProviderPrices', provider, next, nextRemoved)).then((s) => void (s && set({ settings: s })))
  const setPrice = (model: string, key: keyof ModelPrice, value: string): void => {
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) return
    const current = own[model] ?? shipped[model] ?? { input: 0, cachedInput: 0, output: 0 }
    void save({ ...own, [model]: { ...current, [key]: n } })
  }
  const back = (model: string): void => {
    const next = { ...own }
    delete next[model]
    void save(next)
  }
  const remove = (model: string): void => {
    const next = { ...own }
    delete next[model]
    void save(next, shipped[model] ? [...new Set([...removed, model])] : removed)
  }
  const add = (): void => {
    const m = adding.trim()
    if (!m || rows.some((r) => r.model.toLowerCase() === m.toLowerCase())) return
    setAdding('')
    void save({ ...own, [m]: { input: 0, cachedInput: 0, output: 0 } }, removed.filter((x) => x !== m))
  }
  const edited = Object.keys(own).length > 0 || removed.length > 0
  return (
    <div className="fallback-table">
      <div className="fallback-source faint">Hive's starting prices, checked {PRICES_CHECKED}: edit them if they are out of date.</div>
      <table className="table price-table">
        <thead>
          <tr>
            <th>Model</th>
            {cols.map((c) => (
              <th key={c.key} className="num">
                {c.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model: m, price, shipped: isShipped, edited: isEdited }) => (
            <tr key={m}>
              <td className="mono">
                {m} {isEdited && <span className="badge">{isShipped ? 'edited' : 'yours'}</span>}
              </td>
              {cols.map((c) => (
                <td key={c.key} className="num">
                  <input className="input price-input" type="number" min={0} step={0.01} aria-label={`${m} ${c.label}`} defaultValue={price?.[c.key] ?? ''} key={`${m}:${c.key}:${price?.[c.key]}`} onBlur={(e) => e.target.value !== String(price?.[c.key] ?? '') && setPrice(m, c.key, e.target.value)} />
                </td>
              ))}
              <td className="row-actions">
                {isEdited && isShipped && <IconButton icon="discard" title="Back to Hive's price" onClick={() => back(m)} />}
                <IconButton icon="trash" title="Remove from the table" onClick={() => remove(m)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fallback-actions">
        <input className="input mono" placeholder="Model ID, e.g. a new model" aria-label="New model's ID" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn subtle" disabled={!adding.trim()} onClick={add}>
          <Icon name="add" /> Add model
        </button>
        <button className="btn subtle" disabled={!edited} onClick={() => void save({}, [])}>
          <Icon name="discard" /> Reset to defaults
        </button>
      </div>
    </div>
  )
}

/**
 * An editable list for a provider's fallback (models or effort levels): value, name and, for models, Older. Any edit
 * stores the whole list as the user's; Reset to defaults removes it, so Hive's own list (and its updates) applies again.
 */
function FallbackRows<T extends FallbackModel | EffortOption>({ provider, kind, rows, edited, valueLabel, placeholder, open: startOpen }: { provider: ProviderId; kind: 'models' | 'efforts'; rows: T[]; edited: boolean; valueLabel: string; placeholder: string; open: boolean }) {
  const [adding, setAdding] = useState('')
  // Folded while the CLI's answer is in use and the list is Hive's own: it is only used without one.
  const [open, setOpen] = useState(startOpen)
  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])
  const save = (next: T[] | null): Promise<void> => actions.attempt('Could not save the list', () => call('settings:setProviderFallback', provider, kind, next)).then((s) => void (s && set({ settings: s })))
  const change = (i: number, patch: Partial<FallbackModel>): void => void save(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = (): void => {
    const v = adding.trim()
    if (!v || rows.some((r) => r.value.toLowerCase() === v.toLowerCase())) return
    setAdding('')
    void save([...rows, { value: v, label: v } as T])
  }
  if (!open)
    return (
      <a className="fallback-toggle" onClick={() => setOpen(true)}>
        Show the list ({rows.length} {kind === 'models' ? 'models' : 'levels'})
      </a>
    )
  return (
    <>
      <table className="table fallback-list">
        <thead>
          <tr>
            <th>{valueLabel}</th>
            <th>Name</th>
            {kind === 'models' && <th>Older</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.value}>
              <td>
                <input className="input mono" aria-label={`${valueLabel} ${i + 1}`} defaultValue={r.value} key={`v:${r.value}`} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.value && change(i, { value: e.target.value.trim() })} />
              </td>
              <td>
                <input className="input" aria-label={`Name ${i + 1}`} defaultValue={r.label} key={`l:${r.value}:${r.label}`} onBlur={(e) => e.target.value.trim() !== r.label && change(i, { label: e.target.value.trim() || r.value })} />
              </td>
              {kind === 'models' && (
                <td>
                  <input type="checkbox" aria-label={`Older ${i + 1}`} checked={!!(r as FallbackModel).older} onChange={(e) => change(i, { older: e.target.checked })} />
                </td>
              )}
              <td className="row-actions">
                <IconButton icon="trash" title="Remove" disabled={rows.length < 2} onClick={() => void save(rows.filter((_, j) => j !== i))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fallback-actions">
        <input className="input mono" placeholder={placeholder} aria-label={`New ${valueLabel.toLowerCase()}`} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn subtle" disabled={!adding.trim()} onClick={add}>
          <Icon name="add" /> Add
        </button>
        <button className="btn subtle" disabled={!edited} onClick={() => void save(null)}>
          <Icon name="discard" /> Reset to defaults
        </button>
      </div>
    </>
  )
}

/** Settings → <provider> → Models (fallback): where the pickers' models come from now, and the list used without the CLI. */
function ModelFallbackTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const src = modelSource(provider, info, settings)
  const edited = !!providerSettings(settings, provider).modelFallback?.length
  return (
    <div className="fallback-table">
      <div className={cx('fallback-source', src.kind === 'fallback' ? 'warn' : 'faint')}>
        <Icon name={src.kind === 'fallback' ? 'warning' : 'check'} /> Models now: {modelSourceText(provider, { ...src, edited })}
      </div>
      <FallbackRows provider={provider} kind="models" rows={fallbackModels(provider, settings)} edited={edited} valueLabel="Model ID" placeholder={providerDescriptor(provider).modelPlaceholder} open={src.kind === 'fallback' || edited} />
    </div>
  )
}

/** Settings → <provider> → Effort levels (fallback). */
function EffortFallbackTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const edited = !!providerSettings(settings, provider).effortFallback?.length
  const perModel = !!info?.catalog?.models.some((m) => m.efforts)
  return (
    <div className="fallback-table">
      <div className="fallback-source faint">
        <Icon name={perModel ? 'check' : 'info'} /> {perModel ? `${modelSourceText(provider, modelSource(provider, info, settings))}: each model offers its own levels; this list names them and is used for models it doesn't describe.` : `Used now: ${providerDescriptor(provider).name} hasn't reported per-model levels.`}
      </div>
      <FallbackRows provider={provider} kind="efforts" rows={fallbackEfforts(provider, settings)} edited={edited} valueLabel="Level" placeholder="e.g. xhigh" open={!perModel || edited} />
    </div>
  )
}

/** Settings → <provider> → Default effort: the levels of the model new sessions run (the default model, else the CLI's). */
function GlobalEffortPicker({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const g = providerSettings(settings, provider)
  const def = SETTINGS.find((d) => d.provider === provider && d.key === 'defaultEffort')!
  const model = g.defaultModel || info?.defaultModel || null
  const text = effortText(provider, null, model, info, settings)
  return <EffortPicker provider={provider} model={model} value={g.defaultEffort} base={{ value: '', label: `${providerDescriptor(provider).name} default${text === 'default' ? '' : ` (${text.replace(/, default$/, '')})`}` }} onChange={(v) => void update(def, v)} />
}

function GlobalModelPicker({ provider }: { provider: ProviderId }) {
  const value = useStore((s) => providerSettings(s.settings, provider).defaultModel)
  const def = SETTINGS.find((d) => d.provider === provider && d.key === 'defaultModel')!
  return <ModelPicker provider={provider} value={value} base={{ value: '', label: `${providerDescriptor(provider).name} default` }} onChange={(v) => void update(def, v)} />
}

const getValue = (s: AppSettings, def: SettingDef): unknown => settingValue(def, s)

const defaultValue = (def: SettingDef): unknown => settingDefault(def)

async function saveSettings(patch: SettingsPatch): Promise<void> {
  const s = await actions.attempt('Could not save setting', () => call('settings:update', patch))
  if (s) set({ settings: s })
}

/** Saves a row's new value through the change the catalog gives for it (the Assistant's settings tool makes the same). */
async function update(def: SettingDef, value: unknown): Promise<void> {
  if (def.action) return
  const change = settingPatch(def, value)
  if ('settings' in change) return saveSettings(change.settings as SettingsPatch)
}

/** Turns a provider on or off. Turning it off with agents running asks whether to stop them. */
export async function setProviderEnabled(provider: ProviderId, on: boolean): Promise<void> {
  const name = providerDescriptor(provider).name
  if (!on) {
    // Providers are app-wide: list the agents running it in every window, naming the other windows' workspaces.
    const here = get().workspace?.path.toLowerCase()
    const leaf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
    const live = (await actions.attempt('Could not list the running agents', () => call('session:live'))) ?? []
    const running = live
      .filter((s) => s.provider === provider)
      .map((s) => {
        const parent = s.projectPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
        const where = parent.toLowerCase() === here ? leaf(s.projectPath) : `${leaf(parent)}/${leaf(s.projectPath)} (another window)`
        return s.agentName ? `${where} · ${s.agentName}` : where
      })
    if (running.length) {
      const choice = await choose({
        title: `Turn off ${name}?`,
        message: `${running.length === 1 ? 'An agent is' : `${running.length} agents are`} running ${name}: ${running.join(', ')}.`,
        detail: 'Stop them now, or let them run until they are stopped. Either way no new ones start while it is off.',
        choices: [
          { label: 'Let them run', value: 'run' },
          { label: 'Stop them now', value: 'stop' }
        ]
      })
      if (!choice) return
      if (choice === 'stop') await actions.attempt(`Could not stop the ${name} agents`, () => call('provider:stopAgents', provider))
    }
  }
  await saveSettings({ providers: { [provider]: { enabled: on } } } as SettingsPatch)
}

function Control({ def, settings }: { def: SettingDef; settings: AppSettings }) {
  const value = getValue(settings, def)
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  switch (def.type) {
    case 'custom':
      return <>{def.render?.()}</>
    case 'boolean':
      return (
        <Switch
          checked={!!value}
          label={def.title}
          disabled={!!def.disabledBy?.(settings)}
          onChange={async (v) => {
            if (v && def.confirmOn && !(await confirm({ ...def.confirmOn, confirmLabel: 'Enable', danger: true }))) return
            void update(def, v)
          }}
        />
      )
    case 'select':
      return (
        <select className="select" value={String(value ?? '')} onChange={(e) => void update(def, e.target.value)}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'range':
      return (
        <div className="flex" style={{ width: '100%' }}>
          <input className="range" type="range" min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => void update(def, Number(e.target.value))} />
          <span className="muted" style={{ width: 40, textAlign: 'right' }}>{Math.round(Number(value) * 100)}%</span>
        </div>
      )
    case 'number':
      return (
        <NumberField
          value={Number(value)}
          min={def.min}
          max={def.max}
          step={def.step}
          label={def.title}
          off={def.off ? { label: def.off, restore: Number(defaultValue(def)) || null } : undefined}
          onCommit={(v) => update(def, v)}
        />
      )
    case 'text': {
      const commit = (): void => {
        if (draft !== value) void update(def, draft.trim())
      }
      return <input className="input" value={draft} placeholder={def.placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    }
  }
}

function ProviderToggle({ provider }: { provider: ProviderId }) {
  const on = useStore((s) => isProviderEnabled(s.settings, provider))
  return <Switch checked={on} label={`Use ${providerDescriptor(provider).name}`} onChange={(v) => void setProviderEnabled(provider, v)} />
}

function ProviderStatus({ provider }: { provider: ProviderId }) {
  const info = useStore((s) => s.providers[provider])
  if (!info || info.checking) return <span className="muted"><Icon name="loading" spin /> Checking…</span>
  const problems = (info.readiness ?? []).filter((r) => r.level !== 'info')
  return (
    <div className="flex" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {info.found ? (
        <Tooltip content={info.path}>
          <span className="badge success">
            <Icon name="check" /> {info.version} · {info.source}
          </span>
        </Tooltip>
      ) : (
        <span className="badge error">CLI not installed</span>
      )}
      {info.found &&
        problems.map((r) => (
          <span key={r.id} className={cx('badge', r.level === 'error' ? 'error' : 'accent')}>
            {r.message}
          </span>
        ))}
      {info.updateAvailable && <span className="badge accent">{info.latestVersion} available</span>}
      <button className="btn small subtle" onClick={() => void actions.refreshProviders()}>
        Check now
      </button>
      <button className="btn small primary" onClick={() => set({ setupOpen: provider })}>
        {info.found ? 'Manage' : 'Install'}
      </button>
    </div>
  )
}

/** Every provider with its on/off switch and install state. */
function ProvidersList() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return (
    <div className="provider-list">
      {PROVIDERS.map((p) => {
        const info = providers[p.id]
        const on = isProviderEnabled(settings, p.id)
        const state = !info || info.checking ? 'Checking…' : !info.found ? 'Not installed' : info.readiness?.find((r) => r.level === 'error')?.message ?? `Installed · ${info.version}`
        return (
          <div key={p.id} className={cx('provider-row', !on && 'off')}>
            <ProviderIcon provider={p.id} />
            <div className="grow">
              <div>
                <strong>{p.name}</strong> <span className="faint">by {p.company}</span>
              </div>
              <div className="faint small">{state}</div>
            </div>
            <button className="btn small subtle" onClick={() => set({ settingsSection: providerSection(p.id), settingsQuery: '' })}>
              Settings
            </button>
            <Switch checked={on} label={`Use ${p.name}`} onChange={(v) => void setProviderEnabled(p.id, v)} />
          </div>
        )
      })}
    </div>
  )
}

function AssistantProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const current = settings?.assistant.provider ?? ''
  // The window re-renders when what's installed changes: Automatic follows it.
  useStore((s) => s.providers)
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { provider: e.target.value } })}>
      <option value="">Default provider ({defaultProviderLabel(settings)})</option>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {on.includes(p) ? '' : ' (off)'}
        </option>
      ))}
    </select>
  )
}

/** Hive's personas, for choosing a default before a workspace is open. */
const SHIPPED_PERSONAS = [
  { id: 'coordinator', name: 'Coordinator', icon: '🧭' },
  { id: 'planner', name: 'Planner', icon: '🗺️' },
  { id: 'qa-triager', name: 'QA triager', icon: '🔍' },
  { id: 'release-manager', name: 'Release manager', icon: '📦' }
]

function AssistantPersonaPicker() {
  const current = useStore((s) => s.settings?.assistant.persona) || DEFAULT_PERSONA
  const own = usePersonas().filter((p) => p.bundled !== 'missing')
  const list = own.length ? own : SHIPPED_PERSONAS
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { persona: e.target.value } })}>
      {!list.some((p) => p.id === current) && <option value={current}>{current}</option>}
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.icon ? `${p.icon} ` : ''}
          {p.name}
        </option>
      ))}
    </select>
  )
}

/** The Assistant's model, effort, mode and arguments with one provider. */
function AssistantProviderDefaults({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const p = providerDescriptor(provider)
  const a = settings?.assistant.providers[provider] ?? { model: '', effort: '', permissionMode: '', extraArgs: '', use200kContext: '' as const }
  const g = providerSettings(settings, provider)
  const [args, setArgs] = useState(a.extraArgs)
  useEffect(() => setArgs(a.extraArgs), [a.extraArgs])
  const save = (patch: Partial<typeof a>): void => void saveSettings({ assistant: { providers: { [provider]: patch } } } as SettingsPatch)
  const info = useStore((s) => s.providers[provider])
  const cliDefault = info?.defaultModel ?? null
  const runModel = a.model || g.defaultModel || cliDefault
  const inherited = effortText(provider, g.defaultEffort, runModel, info, settings)
  const effortName = inherited === 'default' ? `${p.name}'s` : inherited
  return (
    <div className="agent-form assistant-defaults">
      <label>Model</label>
      <ModelPicker provider={provider} value={a.model} base={{ value: '', label: `${p.name} default${g.defaultModel ? ` (${runsAsName(provider, g.defaultModel, info)})` : ''}` }} onChange={(v) => save({ model: v })} />
      <label>Effort</label>
      <EffortPicker provider={provider} model={runModel} value={a.effort} base={{ value: '', label: `Default (${effortName})` }} onChange={(v) => save({ effort: v as EffortLevel | '' })} />
      <label>Permission mode</label>
      <select className="select" value={a.permissionMode} onChange={(e) => save({ permissionMode: e.target.value as PermissionMode | '' })}>
        <option value="">Default ({permissionLabel(provider, p.assistantMode)})</option>
        {offeredModes(provider, settings)
          .filter((m) => m.value !== p.assistantMode)
          .map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
      </select>
      <ModeCaveat provider={provider} mode={a.permissionMode || p.assistantMode} model={a.model || g.defaultModel || cliDefault} />
      {p.capabilities.contextLimit && (
        <>
          <label>Use 200K context (instead of 1M)</label>
          <select className="select" value={a.use200kContext ?? ''} onChange={(e) => save({ use200kContext: e.target.value as '' | 'on' | 'off' })}>
            <option value="">Default ({g.use200kContext ? 'On' : 'Off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </>
      )}
      <label>Extra arguments</label>
      <input className="input" value={args} placeholder="e.g. --verbose" onChange={(e) => setArgs(e.target.value)} onBlur={() => args !== a.extraArgs && save({ extraArgs: args.trim() })} />
    </div>
  )
}

function DefaultProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const def = SETTINGS.find((d) => d.key === 'defaultProvider')!
  const current = settings?.defaultProvider ?? ''
  // Automatic names what it picks now, which follows what's installed.
  useStore((s) => s.providers)
  return (
    <select className="select" value={current} onChange={(e) => void update(def, e.target.value)}>
      <option value={AUTO_PROVIDER}>{defaultProviderLabel(settings && { ...settings, defaultProvider: AUTO_PROVIDER })}</option>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {on.includes(p) ? '' : ' (off)'}
        </option>
      ))}
    </select>
  )
}

function ClearUsageCacheButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn subtle"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void call('session:clearUsageCache')
          .then(() => notify('info', 'Usage cache cleared', 'Each transcript is read again the next time it is shown.'))
          .catch((e) => notify('error', 'Could not clear the usage cache', errorMessage(e)))
          .finally(() => setBusy(false))
      }}
    >
      <Icon name="clear-all" /> Clear
    </button>
  )
}

function ResetMetricsButton() {
  const [busy, setBusy] = useState(false)
  const workspace = useStore((st) => st.workspace)
  return (
    <button
      className="btn subtle"
      disabled={busy || !workspace}
      onClick={() => {
        void confirm({ title: 'Reset performance metrics?', message: "Clear this workspace's recorded performance metrics?", detail: 'The history starts again from now.', confirmLabel: 'Reset', danger: true }).then((ok) => {
          if (!ok) return
          setBusy(true)
          void call('metrics:reset')
            .then(() => notify('info', 'Performance metrics reset'))
            .catch((e) => notify('error', 'Could not reset the performance metrics', errorMessage(e)))
            .finally(() => setBusy(false))
        })
      }}
    >
      <Icon name="discard" /> Reset
    </button>
  )
}

/** A colour picker per board column, saved a moment after the pick settles (the picker reports every drag). */
function ColumnColors() {
  const board = useStore((st) => st.settings!.board)
  const [draft, setDraft] = useState<Partial<Record<TaskColumn, string>>>({})
  useEffect(() => {
    if (!Object.keys(draft).length) return
    const t = setTimeout(() => {
      void saveSettings({ board: { colors: draft } } as SettingsPatch)
      setDraft({})
    }, 300)
    return () => clearTimeout(t)
  }, [draft])
  return (
    <div className={cx('column-colors', !board.columnColors && 'off')}>
      {TASK_COLUMNS.map((c) => {
        const value = draft[c.id] ?? columnColor(board.colors, c.id)
        return (
          <label key={c.id} className="column-color">
            <input type="color" value={value} aria-label={`${c.label} colour`} onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))} />
            <span>{c.label}</span>
            {value.toLowerCase() !== DEFAULT_COLUMN_COLORS[c.id] && (
              <IconButton icon="discard" title={`Reset ${c.label} to its default`} onClick={() => void saveSettings({ board: { colors: { [c.id]: DEFAULT_COLUMN_COLORS[c.id] } } } as SettingsPatch)} />
            )}
          </label>
        )
      })}
    </div>
  )
}

function ChimePicker() {
  const s = useStore((st) => st.settings!)
  const sounds: { value: ChimeSound; label: string }[] = [
    { value: 'chime', label: 'Chime' },
    { value: 'bell', label: 'Bell' },
    { value: 'soft', label: 'Soft' },
    { value: 'pop', label: 'Pop' }
  ]
  return (
    <div className="flex" style={{ width: '100%' }}>
      <select className="select" value={s.notifications.chimeSound} onChange={(e) => void call('settings:update', { notifications: { chimeSound: e.target.value as ChimeSound } }).then((ns) => set({ settings: ns }))}>
        {sounds.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconButton icon="play" title="Play" onClick={() => playChime(s.notifications.chimeSound, s.notifications.chimeVolume)} />
    </div>
  )
}

function ApiStatus() {
  const api = useStore((s) => s.api)
  if (!api) return null
  return api.running ? (
    <span className="badge success">
      <Icon name="broadcast" /> Listening on {api.url}
    </span>
  ) : api.error ? (
    <span className="badge error">{api.error}</span>
  ) : (
    <span className="badge">Off</span>
  )
}

function ApiToken() {
  const api = useStore((s) => s.api)
  const [show, setShow] = useState(false)
  if (!api) return null
  return (
    <div className="token-box">
      <input className="input" readOnly value={show ? api.token : '•'.repeat(24)} />
      <IconButton icon={show ? 'eye-closed' : 'eye'} title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} />
      <IconButton
        icon="copy"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(api.token)
          notify('success', 'Token copied')
        }}
      />
      <IconButton
        icon="refresh"
        title="Regenerate"
        onClick={async () => {
          if (!(await confirm({ title: 'Regenerate token?', message: 'Programs using the current token will stop working. Running sessions pick up the new token when restarted.', confirmLabel: 'Regenerate', danger: true }))) return
          set({ api: await call('api:regenerateToken') })
        }}
      />
    </div>
  )
}

function DataFolder() {
  const info = useStore((s) => s.appInfo)
  const path = info ? `${info.userData}\\config.json` : ''
  return (
    <div className="token-box">
      <input className="input" readOnly value={path} />
      <IconButton
        icon="copy"
        title="Copy path"
        onClick={() => {
          void navigator.clipboard.writeText(path)
          notify('success', 'Path copied')
        }}
      />
    </div>
  )
}

function ResetAll() {
  return (
    <button
      className="btn danger"
      onClick={async () => {
        if (!(await confirm({ title: 'Reset all settings?', message: 'Every setting on this page returns to its default.', confirmLabel: 'Reset', danger: true }))) return
        set({ settings: await call('settings:reset') })
        notify('success', 'Settings reset')
      }}
    >
      Reset
    </button>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const section = useStore((s) => s.settingsSection) as Section
  const query = useStore((s) => s.settingsQuery)
  const [modifiedOnly, setModifiedOnly] = useState(false)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SETTINGS.filter((d) => {
      if (q && !`${d.title} ${d.desc} ${d.tip} ${d.key}`.toLowerCase().includes(q)) return false
      if (modifiedOnly && (d.type === 'custom' || getValue(settings!, d) === defaultValue(d))) return false
      if (!q && !modifiedOnly && d.section !== section) return false
      return true
    })
  }, [query, section, settings, modifiedOnly])

  if (!settings) return null
  const grouped = SECTIONS.map((s) => ({ ...s, items: visible.filter((d) => d.section === s.id) })).filter((g) => g.items.length)
  const navIcon = (s: (typeof SECTIONS)[number]): React.ReactNode => (s.provider ? <ProviderIcon provider={s.provider} /> : <Icon name={s.icon} />)

  return (
    <div className="settings">
      <div className="settings-top">
        <Icon name="search" />
        <SearchInput autoFocus placeholder="Search settings" value={query} onChange={(v) => set({ settingsQuery: v })} />
        <label className="flex muted">
          <input type="checkbox" className="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} /> Modified only
        </label>
      </div>
      <div className="settings-body">
        <div className="settings-nav">
          {SECTIONS.map((s) => (
            <div key={s.id} className={cx('row', !query && !modifiedOnly && section === s.id && 'selected')} onClick={() => {
                set({ settingsSection: s.id, settingsQuery: '' })
                setModifiedOnly(false)
              }}
            >
              {navIcon(s)} <span className={cx('label', s.provider && 'settings-sub')}>{s.label}</span>
            </div>
          ))}
        </div>
        <div className="settings-content">
          {grouped.length === 0 && <div className="empty-state">No settings match.</div>}
          {grouped.map((g) => (
            <div key={g.id} className="settings-group">
              <h2>{g.label}</h2>
              <p>{g.desc}</p>
              {g.items.map((d) => {
                const modified = (d.type !== 'custom' || ['defaultModel', 'defaultEffort', 'defaultProvider', 'modelFallback', 'effortFallback'].includes(d.key)) && getValue(settings, d) !== defaultValue(d)
                return (
                  d.wide ? (
                    <div key={`${d.section}.${d.key}`} className="setting wide">
                      <div className="s-text">
                        <div className="s-title">
                          {d.title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{d.tip}</span>} />
                        </div>
                        {d.desc && <div className="s-desc">{d.desc}</div>}
                        {d.render?.()}
                      </div>
                    </div>
                  ) : (
                  <div key={`${d.section}.${d.key}`} className={cx('setting', d.danger && 'danger')}>
                    <div className="s-text">
                      <div className="s-title">
                        {modified && (
                          <Tooltip content="Modified from the default">
                            <span className="modified" />
                          </Tooltip>
                        )}
                        {d.title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{d.tip}</span>} />
                        {modified && (
                          <IconButton icon="discard" title={`Reset to default (${String(defaultValue(d) || 'empty')})`} onClick={() => void update(d, defaultValue(d))} />
                        )}
                      </div>
                      {d.desc && <div className="s-desc">{d.desc}</div>}
                      {d.disabledBy?.(settings) && <div className="s-desc muted">{d.disabledBy(settings)}</div>}
                    </div>
                    <div className="s-control">
                      <Control def={d} settings={settings} />
                    </div>
                  </div>
                  )
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
