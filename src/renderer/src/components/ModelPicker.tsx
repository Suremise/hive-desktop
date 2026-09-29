import { useEffect, useState } from 'react'
import { MODEL_GROUPS, MODEL_PRESETS, baseModel, isOlderModel, isOneM, supportsOneM, withOneM, type ModelOption } from '@shared/defaults'

/**
 * Model choice for global and project settings: latest aliases, pinned versions, older versions
 * (hidden until asked for), a custom model ID, and the 1M-context variant where there is one.
 * `base` is the option meaning "no choice here" (Inherit, or Claude Code's default).
 */
export function ModelPicker({ value, base, onChange }: { value: string; base: ModelOption; onChange: (value: string) => void }) {
  const known = MODEL_PRESETS.some((m) => m.value === baseModel(value))
  const [custom, setCustom] = useState(value !== base.value && !known)
  const [draft, setDraft] = useState(custom ? value : '')
  const [showOlder, setShowOlder] = useState(isOlderModel(value))
  useEffect(() => {
    if (isOlderModel(value)) setShowOlder(true)
  }, [value])

  const selected = custom ? 'custom' : value === base.value ? base.value : baseModel(value)
  const chosen = value !== base.value && !custom
  const oneMOk = chosen && supportsOneM(value)

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
            onChange(v === base.value ? v : withOneM(v, isOneM(value)))
          }}
        >
          <option value={base.value}>{base.label}</option>
          {MODEL_GROUPS.filter((g) => !g.older || showOlder).map((g) => (
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
        <label className="flex muted" style={{ whiteSpace: 'nowrap', opacity: oneMOk ? 1 : 0.5 }} title={oneMOk ? 'Use the 1M-token context window' : 'This model has no 1M-context version'}>
          <input type="checkbox" className="checkbox" disabled={!oneMOk} checked={oneMOk && isOneM(value)} onChange={(e) => onChange(withOneM(value, e.target.checked))} /> 1M context
        </label>
      </div>
      {custom && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          placeholder="Full model ID, e.g. claude-opus-5-5"
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
      <a className="model-picker-older" onClick={() => setShowOlder(!showOlder)}>
        {showOlder ? 'Hide older versions' : 'Show older versions'}
      </a>
    </div>
  )
}
