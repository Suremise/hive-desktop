import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { cornerPlacement } from '@shared/corner'
import { TIP_GROUPS, TIPS, type Tip } from '@shared/tips'
import { commandKeybinding, commands, runCommand } from '../commands'
import { call } from '../api'
import { set, useStore } from '../store'
import { closeTip, openGuideAt, showNextTip, turnOffTips } from '../tips'
import { cx, formatKeybinding } from '../util'
import { Icon, IconButton, Modal, Switch } from './ui'

/**
 * The tip card (bottom right, above the status bar; toasts stack above it) and Help → Tips…. Which tip shows, and
 * when, is in ../tips.ts and @shared/tips.
 */

/** A tip's command, when it can run now (Try it). */
const runnable = (tip: Tip): boolean => {
  const c = tip.command ? commands.find((x) => x.id === tip.command) : undefined
  return !!c && (!c.when || c.when())
}

/** A tip's text with its shortcuts as they are now: {key:<command>} shows the user's shortcut for it. */
function TipText({ text }: { text: string }) {
  const parts = text.split(/(\{key:[\w.]+\})/)
  return (
    <>
      {parts.map((p, i) => {
        const id = /^\{key:([\w.]+)\}$/.exec(p)?.[1]
        if (!id) return p
        const key = commandKeybinding(id)
        if (key) return <kbd key={i}>{formatKeybinding(key)}</kbd>
        // No shortcut: left out at the end, named by the command elsewhere.
        const last = parts.slice(i + 1).every((x) => !x.trim())
        return last ? null : `“${commands.find((c) => c.id === id)?.label ?? id}”`
      })}
    </>
  )
}

/**
 * Try it and Learn more, for the card and the list. Each calls its callback before it goes: Help → Tips… closes
 * for both, as it's modal; the card closes for Try it and stays beside the guide for Learn more.
 */
function TipActions({ tip, onTry, onLearn }: { tip: Tip; onTry?: () => void; onLearn?: () => void }) {
  return (
    <>
      {runnable(tip) && (
        <button
          className="btn small primary"
          onClick={() => {
            onTry?.()
            runCommand(tip.command!)
          }}
        >
          Try it
        </button>
      )}
      {tip.docs && (
        <button
          className="btn small subtle"
          onClick={() => {
            onLearn?.()
            openGuideAt(tip.docs!)
          }}
        >
          Learn more
        </button>
      )}
    </>
  )
}

/** Whether a focused terminal lies under the card: then it steps aside, so it never covers what you type. */
function useOverTerminal(ref: RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!on) return setOver(false)
    const check = (): void => {
      const term = (document.activeElement as HTMLElement | null)?.closest?.('.xterm')
      const card = ref.current
      if (!term || !card) return setOver(false)
      const a = term.getBoundingClientRect()
      const b = card.getBoundingClientRect()
      setOver(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
    }
    // Focus moving out lands on the next element after the event.
    const later = (): void => void setTimeout(check, 0)
    check()
    document.addEventListener('focusin', check)
    document.addEventListener('focusout', later)
    window.addEventListener('resize', check)
    return () => {
      document.removeEventListener('focusin', check)
      document.removeEventListener('focusout', later)
      window.removeEventListener('resize', check)
    }
  }, [on, ref])
  return over
}

/**
 * Keeps the bottom-right corner's tip card and toasts out of the way (@shared/corner): left of the Assistant's panel
 * while it is open, and just above an ended or couldn't-start bar under them, so its buttons can always be clicked.
 * Sets --corner-right and --corner-lift, which both use; worked out again (at most once a frame) as the window, the
 * panel or the bars change.
 */
export function CornerPlacement() {
  useEffect(() => {
    const root = document.documentElement
    let frame = 0
    const measure = (): void => {
      frame = 0
      const panel = document.querySelector<HTMLElement>('.assistant-panel')
      const bars = [...document.querySelectorAll<HTMLElement>('.session-ended')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
      const card = document.querySelector<HTMLElement>('.tip-card')
      const toasts = document.querySelector<HTMLElement>('.toasts')
      // The card is the lowest; with none, the toasts are.
      const w = card?.offsetWidth || toasts?.offsetWidth || 320
      const h = card?.offsetHeight || toasts?.offsetHeight || 0
      const { right, lift } = cornerPlacement(window.innerWidth, window.innerHeight, panel ? panel.getBoundingClientRect().left : null, bars, w, h)
      root.style.setProperty('--corner-right', `${right}px`)
      root.style.setProperty('--corner-lift', `${lift}px`)
    }
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const watch = new MutationObserver(soon)
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', soon)
    return () => {
      watch.disconnect()
      window.removeEventListener('resize', soon)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return null
}

export function TipCard() {
  const id = useStore((s) => s.tipShown)
  const tip = id ? TIPS.find((t) => t.id === id) : undefined
  const ref = useRef<HTMLDivElement>(null)
  const over = useOverTerminal(ref, !!tip)
  // Toasts stack above the card.
  useLayoutEffect(() => {
    const h = tip && !over ? (ref.current?.offsetHeight ?? 0) + 10 : 0
    document.documentElement.style.setProperty('--tip-space', `${h}px`)
  })
  if (!tip) return null
  return (
    <div ref={ref} className={cx('tip-card', over && 'stepped-aside')} role="complementary" aria-label="Tip" aria-hidden={over || undefined}>
      <div className="tip-head">
        <Icon name="lightbulb" />
        <span className="grow">
          Tip · {TIPS.indexOf(tip) + 1} of {TIPS.length}
        </span>
        <IconButton icon="close" title="Close" onClick={closeTip} />
      </div>
      <div className="tip-title">{tip.title}</div>
      <div className="tip-text">
        <TipText text={tip.text} />
      </div>
      <div className="tip-actions">
        <TipActions tip={tip} onTry={closeTip} />
        <button className="btn small subtle" onClick={showNextTip}>
          Next tip
        </button>
      </div>
      <button className="link tip-off" onClick={() => void turnOffTips()}>
        Don't show tips
      </button>
    </div>
  )
}

/** Help → Tips…: every tip, grouped and searchable, and the setting. */
export function TipsDialog() {
  const open = useStore((s) => s.tipsOpen)
  const on = useStore((s) => s.settings?.general.showTips !== false)
  const [query, setQuery] = useState('')
  if (!open) return null
  const close = (): void => {
    set({ tipsOpen: false })
    setQuery('')
  }
  const q = query.trim().toLowerCase()
  const found = TIPS.filter((t) => !q || `${t.title} ${t.text} ${t.group}`.toLowerCase().includes(q))
  return (
    <Modal
      title="Tips"
      icon="lightbulb"
      wide
      onClose={close}
      footer={
        <button className="btn primary" onClick={close}>
          Close
        </button>
      }
    >
      <div className="tips-top">
        <input className="input" autoFocus placeholder="Search tips" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex muted tips-switch">
          <Switch checked={on} label="Show a tip when Hive starts" onChange={(v) => void call('settings:update', { general: { showTips: v } }).then((s) => set({ settings: s }))} /> Show a tip when Hive starts
        </label>
      </div>
      <div className="tips-list">
        {TIP_GROUPS.map((g) => {
          const list = found.filter((t) => t.group === g)
          if (!list.length) return null
          return (
            <section key={g}>
              <h3>{g}</h3>
              {list.map((t) => (
                <div key={t.id} className="tips-item">
                  <div className="grow">
                    <div className="tip-title">{t.title}</div>
                    <div className="tip-text">
                      <TipText text={t.text} />
                    </div>
                  </div>
                  <div className="tip-actions">
                    <TipActions tip={t} onTry={close} onLearn={close} />
                  </div>
                </div>
              ))}
            </section>
          )
        })}
        {!found.length && <div className="pane-empty">No tips match “{query}”.</div>}
      </div>
    </Modal>
  )
}
