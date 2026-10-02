import { useEffect, useRef, useState } from 'react'
import { parseNumberDraft } from '@shared/numberInput'

/**
 * A number setting's box, saved on blur or Enter (once). A blank box keeps the saved value, or inherits where
 * `inherit` is given; text that isn't a number in range shows a message under the box and saves nothing. Where
 * 0 turns the feature off, `off` adds a checkbox for it: ticking saves 0, unticking brings back the last other
 * value (or `off.restore`).
 */
export function NumberField({
  value,
  min,
  max,
  step,
  off,
  inherit,
  label,
  onCommit
}: {
  value: number | null
  min?: number
  max?: number
  step?: number
  off?: { label: string; restore: number | null }
  /** Placeholder for an empty box, which saves null (inherit). Without it, a blank box keeps the saved value. */
  inherit?: string
  label?: string
  onCommit: (value: number | null) => Promise<unknown> | void
}) {
  const shown = (v: number | null): string => (v === null ? '' : String(v))
  const [draft, setDraft] = useState(shown(value))
  const [error, setError] = useState<string | null>(null)
  // A value being saved, shown until the save ends (so Off ticks at once).
  const [saving, setSaving] = useState<{ value: number | null } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const current = useRef(value)
  current.current = value
  // What unticking Off brings back.
  const lastOn = useRef<number | null>(value ? value : null)
  if (value) lastOn.current = value
  useEffect(() => setDraft(shown(value)), [value])
  const isOff = !!off && (saving ? saving.value : value) === 0

  const reset = (): void => {
    setDraft(shown(current.current))
    // A number box holding text it can't read reports "", so React may not see a change to put right.
    if (input.current) input.current.value = shown(current.current)
  }
  const save = async (v: number | null): Promise<void> => {
    setError(null)
    if (v === current.current) return reset()
    setSaving({ value: v })
    try {
      await onCommit(v)
    } finally {
      setSaving(null)
    }
    // A failed save leaves the setting as it was: show that, not the draft.
    reset()
  }
  const commit = (): void => {
    const r = parseNumberDraft(draft, { min, max }, { badInput: input.current?.validity.badInput, off: !!off })
    if (r.kind === 'invalid') {
      setError(r.message)
      reset()
    } else if (r.kind === 'blank') {
      if (inherit !== undefined) void save(null)
      else {
        setError(null)
        reset()
      }
    } else void save(r.value)
  }

  return (
    <div className="number-field">
      <div className="number-field-row">
        <input
          ref={input}
          className="input"
          type="number"
          aria-label={label}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={isOff}
          value={isOff ? '' : draft}
          placeholder={isOff ? off.label : inherit}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              setError(null)
              reset()
            }
          }}
        />
        {off && (
          <label className="flex muted number-field-off">
            <input type="checkbox" className="checkbox" checked={isOff} onChange={(e) => void save(e.target.checked ? 0 : (lastOn.current ?? off.restore))} /> {off.label}
          </label>
        )}
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}
