import { useEffect, useState } from 'react'
import { baseModel, isOneM, supportsOneM, withOneM } from '@shared/claude'
import { providerDescriptor, type ModelOption } from '@shared/providers'
import type { ProviderId } from '@shared/types'
import { useStore } from '../store'

/**
 * Model choice for a provider's settings: its model groups (for Claude Code: latest aliases, pinned
 * versions, older versions hidden until asked for), a custom model ID, and the 1M-context variant where
 * the provider has one. `base` is the option meaning "no choice here" (Inherit, or the CLI's default).
 */
export function ModelPicker({ provider, value, base, onChange }: { provider: ProviderId; value: string; base: ModelOption; onChange: (value: string) => void }) {
  const p = providerDescriptor(provider)
  // The installed CLI's own list where it gives one (new models appear without a Hive update), else Hive's.
  const catalog = useStore((s) => s.providers[provider]?.models)
  const groups = catalog?.length ? [{ label: `${p.name} models`, models: catalog, older: false }] : p.modelGroups
  const oneM = p.capabilities.oneMContext
  const plain = (v: string): string => (oneM ? baseModel(v) : v)
  const presets = groups.flatMap((g) => g.models)
  const isOlder = (v: string): boolean => groups.some((g) => g.older && g.models.some((m) => m.value === plain(v)))
  const known = presets.some((m) => m.value === plain(value))
  const [custom, setCustom] = useState(value !== base.value && !known)
  const [draft, setDraft] = useState(custom ? value : '')
  const [showOlder, setShowOlder] = useState(isOlder(value))
  const older = isOlder(value)
  useEffect(() => {
    if (older) setShowOlder(true)
  }, [older])

  const selected = custom ? 'custom' : value === base.value ? base.value : plain(value)
  const chosen = value !== base.value && !custom
  const oneMOk = oneM && chosen && supportsOneM(value)
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
            // Keep the 1M choice when switching between models that have it.
            onChange(v === base.value || !oneM ? v : withOneM(v, isOneM(value)))
          }}
        >
          <option value={base.value}>{base.label}</option>
          {groups
            .filter((g) => !g.older || showOlder)
            .map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          <option value="custom">Custom model ID…</option>
        </select>
        {oneM && (
          <label className="flex muted" style={{ whiteSpace: 'nowrap', opacity: oneMOk ? 1 : 0.5 }} title={oneMOk ? 'Use the 1M-token context window' : 'This model has no 1M-context version'}>
            <input type="checkbox" className="checkbox" disabled={!oneMOk} checked={oneMOk && isOneM(value)} onChange={(e) => onChange(withOneM(value, e.target.checked))} /> 1M context
          </label>
        )}
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
