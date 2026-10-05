import { useEffect, useState } from 'react'
import { providerDescriptor, type ModelOption } from '@shared/providers'
import { modelLabel } from '@shared/defaults'
import { effortName, modelCaps, modelGroups } from '@shared/models'
import type { ProviderId } from '@shared/types'
import { useStore } from '../store'
import { Icon } from './ui'

/**
 * Model choice for a provider's settings: the models the installed CLI reports (#125), else the fallback list in
 * Settings (for Claude Code as shipped: latest aliases, pinned versions, older versions hidden until asked for), and a
 * custom model ID. `base` is the option meaning "no choice here" (Inherit, or the CLI's default).
 */
export function ModelPicker({ provider, value, base, onChange }: { provider: ProviderId; value: string; base: ModelOption; onChange: (value: string) => void }) {
  const p = providerDescriptor(provider)
  const info = useStore((s) => s.providers[provider])
  const settings = useStore((s) => s.settings)
  const groups = modelGroups(provider, info, settings)
  const presets = groups.filter((g) => !g.unavailable).flatMap((g) => g.models)
  const isOlder = (v: string): boolean => groups.some((g) => g.older && g.models.some((m) => m.value === v))
  const known = presets.some((m) => m.value === value)
  const [custom, setCustom] = useState(value !== base.value && !known)
  const [draft, setDraft] = useState(custom ? value : '')
  const [showOlder, setShowOlder] = useState(isOlder(value))
  const older = isOlder(value)
  useEffect(() => {
    if (older) setShowOlder(true)
  }, [older])

  const selected = custom ? 'custom' : value === base.value ? base.value : value
  const hasOlder = groups.some((g) => g.older)

  return (
    <div className="model-picker">
      <div className="flex" style={{ gap: 8 }}>
        <select
          className="select"
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'custom') {
              setCustom(true)
              setDraft(value === base.value ? '' : value)
              return
            }
            setCustom(false)
            onChange(v)
          }}
        >
          <option value={base.value}>{base.label}</option>
          {groups
            .filter((g) => !g.older || showOlder)
            .map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.value} value={m.value} disabled={g.unavailable}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          <option value="custom">Custom model ID…</option>
        </select>
      </div>
      {custom && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          placeholder={p.modelPlaceholder}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim()
            if (v && v !== value) onChange(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {hasOlder && (
        <a className="model-picker-older" onClick={() => setShowOlder(!showOlder)}>
          {showOlder ? 'Hide older versions' : 'Show older versions'}
        </a>
      )}
    </div>
  )
}

/**
 * Effort choice for the model that would run (`model`; null: the CLI's default model): the levels the CLI says that
 * model takes, else the provider's fallback list. A choice the model doesn't take stays chosen and says so, rather
 * than being changed behind the user's back: the CLI decides what to do with it (#125).
 */
export function EffortPicker({ provider, model, value, base, onChange }: { provider: ProviderId; model: string | null | undefined; value: string; base: ModelOption; onChange: (value: string) => void }) {
  const info = useStore((s) => s.providers[provider])
  const settings = useStore((s) => s.settings)
  const caps = modelCaps(provider, model, info, settings)
  const name = caps.label ?? (model ? modelLabel(model, provider) : `${providerDescriptor(provider).name}'s default model`)
  const chosen = value && value !== base.value ? value : null
  const unsupported = !!chosen && !caps.efforts.some((e) => e.value === chosen)
  return (
    <div className="effort-picker-wrap">
      <select className="select effort-picker" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={base.value}>{base.label}</option>
        {caps.efforts.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
        {unsupported && <option value={chosen}>{effortName(provider, chosen, settings)} (not offered with {name})</option>}
      </select>
      {unsupported ? (
        <div className="mode-caveat effort-caveat">
          <Icon name="warning" /> <span>{`${providerDescriptor(provider).name} doesn't offer ${effortName(provider, chosen, settings)} with ${name}${caps.efforts.length ? ` (it offers ${caps.efforts.map((e) => e.label).join(', ')})` : ', which has no effort setting'}: it may refuse it or use another.`}</span>
        </div>
      ) : (
        caps.perModel && !caps.efforts.length && <div className="mode-caveat effort-caveat faint">{`${name} has no effort setting.`}</div>
      )}
    </div>
  )
}
