import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { LiveSessionState, SessionStatus } from '@shared/types'
import { actClass, cx, type SessionAction } from '../util'
import { call, errorMessage } from '../api'
import { formatWhen } from '@shared/dates'
import { providerDescriptor, providerName } from '@shared/providers'
import { placeTip, type Box } from '@shared/tipPlacement'

export function Icon({ name, className, title, spin }: { name: string; className?: string; title?: string; spin?: boolean }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'spin', className)} title={title} aria-hidden={!title} />
}

/** A tooltip's way to tell the one around it that it is showing, so only the innermost one shows (#287). */
const TipParent = createContext<((inner: boolean) => void) | null>(null)

/**
 * Hover tooltip rendered in a portal so it is never clipped by scroll containers. It is measured hidden first, then
 * placed by its real size next to its anchor (placeTip), so one near the window's edge stays beside its button. One
 * inside another's (an icon in an agent tab) hides the outer one while it shows. `focus`: also shown while what it
 * wraps has the keyboard focus.
 */
export function Tooltip({ content, children, delay = 350, block, side, focus }: { content: ReactNode; children: ReactNode; delay?: number; block?: boolean; side?: 'right'; focus?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Box | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  // Taller than the window at its usual width: as wide as the window (and, still too tall, cut at its height and faded).
  const [fit, setFit] = useState<'normal' | 'wide' | 'clipped'>('normal')
  const [inner, setInner] = useState(false)
  const parent = useContext(TipParent)
  const shown = !!anchor
  useEffect(() => {
    if (!parent || !shown) return
    parent(true)
    return () => parent(false)
  }, [parent, shown])
  const timer = useRef<number | undefined>(undefined)
  const show = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      setPlaced(null)
      setFit('normal')
      setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }, delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setAnchor(null)
    setPlaced(null)
    setFit('normal')
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // Before it paints, and again when its content changes while shown (placed by its new size; set only on a change).
  useLayoutEffect(() => {
    const el = tipRef.current
    const tip = el?.getBoundingClientRect()
    if (!anchor || !el || !tip) return
    // Taller than the window has room for (its max-height cuts it): measured again as wide as the window allows before
    // it is placed, and only if it still doesn't fit, cut and faded (#372).
    const cut = el.scrollHeight > el.clientHeight + 1
    if (cut && fit === 'normal') return setFit('wide')
    if (cut && fit === 'wide') return setFit('clipped')
    const next = placeTip(anchor, { width: tip.width, height: tip.height }, { width: window.innerWidth, height: window.innerHeight }, side)
    if (!placed || next.left !== placed.left || next.top !== placed.top) setPlaced(next)
  }, [anchor, placed, side, content, fit])
  if (!content) return <>{children}</>
  return (
    <span
      className="tip-wrap"
      style={block ? { display: 'flex' } : undefined}
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={focus ? (e) => (e.target as Element).matches(':focus-visible') && show() : undefined}
      onBlur={focus ? hide : undefined}
    >
      <TipParent.Provider value={setInner}>{children}</TipParent.Provider>
      {anchor &&
        !inner &&
        createPortal(
          <div ref={tipRef} className={cx('tip', fit !== 'normal' && 'wide', fit === 'clipped' && 'clipped')} style={placed ?? { left: 0, top: 0, visibility: 'hidden' }}>
            {content}
          </div>,
          document.body
        )}
    </span>
  )
}

export function InfoTip({ text }: { text: ReactNode }) {
  return (
    <Tooltip content={text} delay={100}>
      <Icon name="info" className="info-icon" />
    </Tooltip>
  )
}

/**
 * A load that failed with nothing to show: says so, with Retry, so it doesn't read as an empty result. `inline` fits
 * a list pane; without it, the panel's empty state.
 */
export function LoadFailed({ what, error, onRetry, inline }: { what: string; error: string; onRetry: () => void; inline?: boolean }) {
  return (
    <div className={cx(inline ? 'pane-empty' : 'empty-state', 'load-failed')} role="alert">
      <Icon name="error" /> Could not load {what}: {error}
      <div>
        <button className="btn small" onClick={onRetry}>
          <Icon name="refresh" /> Retry
        </button>
      </div>
    </div>
  )
}

/** A refresh that failed while the last results stay on screen: when they're from (the error on hover), and Retry. */
export function StaleNote({ what, error, at, onRetry }: { what: string; error: string; at: number; onRetry: () => void }) {
  return (
    <div className="banner warn load-stale" role="status">
      <Tooltip content={error}>
        <span>
          <Icon name="warning" /> Could not refresh {what}{at ? `; last updated ${formatWhen(at)}` : ''}.
        </span>
      </Tooltip>
      <button className="btn small" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

export function IconButton({
  icon,
  title,
  onClick,
  disabled,
  active,
  className,
  expanded,
  spin
}: {
  icon: string
  title: string
  onClick?: (e: React.MouseEvent) => void
  disabled?: boolean
  active?: boolean
  className?: string
  /** For a button that opens and closes something: whether it is open (aria-expanded). */
  expanded?: boolean
  /** Its icon turns (a loading icon, while what it does runs). */
  spin?: boolean
}) {
  return (
    <Tooltip content={title}>
      <button
        className={cx('icon-btn', active && 'active', className)}
        onClick={(e) => {
          e.stopPropagation()
          onClick?.(e)
        }}
        disabled={disabled}
        aria-label={title}
        aria-expanded={expanded}
      >
        <Icon name={icon} spin={spin} />
      </button>
    </Tooltip>
  )
}

/**
 * A search or filter box with a × that clears it (#433): shown only while there is text, inside the box on the right,
 * named "Clear". Clicking it, or Escape with text in the box, clears the text as typing would and keeps the focus in
 * the box; with the box empty, Escape does what it did before (a dialog or the palette closes). It takes the box's
 * place in the layout (`.search-box`, which the parent's rules size); `className` and `style` are the input's.
 */
export function SearchInput({
  value,
  onChange,
  onKeyDown,
  className,
  ref,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void; ref?: React.Ref<HTMLInputElement> }) {
  const input = useRef<HTMLInputElement | null>(null)
  const setRef = (el: HTMLInputElement | null): void => {
    input.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el
  }
  return (
    <span className={cx('search-box', value && 'has-text')}>
      <input
        {...rest}
        ref={setRef}
        className={cx('input', className)}
        data-clearable=""
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // The first Escape clears the text; the next one is the box's own (or its dialog's).
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
            return
          }
          onKeyDown?.(e)
        }}
      />
      {value && (
        <span className="search-clear">
          <IconButton
            icon="close"
            title="Clear"
            onClick={() => {
              onChange('')
              input.current?.focus()
            }}
          />
        </span>
      )}
    </span>
  )
}

/** Whether an Escape is for clearing a search box (`SearchInput`) that has text: dialogs leave it to the box. */
export function escapeClearsSearch(e: KeyboardEvent): boolean {
  const t = e.target
  return t instanceof HTMLInputElement && t.hasAttribute('data-clearable') && t.value !== ''
}

export function Switch({ checked, onChange, disabled, small, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; small?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'on', small && 'small')}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
    />
  )
}

export const STATUS_TEXT: Record<SessionStatus | 'idle', string> = {
  idle: 'No session',
  stopped: 'Stopped',
  starting: 'Starting…',
  ready: 'Ready',
  working: 'Working…',
  waiting: 'Needs your input',
  background: 'Background tasks',
  watching: 'Waiting on cards',
  finished: 'Finished',
  error: 'Error',
  signin: 'Needs sign-in'
}

const tasks = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`

/** What an agent is doing, in words: its status message, else its status with any background tasks it is running. */
export function statusText(live: Pick<LiveSessionState, 'status' | 'statusMessage' | 'mergeSlot' | 'backgroundTasks' | 'question' | 'watch'>): string {
  const text = ((): string => {
    // Waiting on cards: what for ("Waiting for #12 → Review").
    if (live.status === 'watching' && live.watch) return live.watch.label
    if (live.statusMessage) return live.statusMessage
    // At the merge slot (#350): waiting for it, or merging.
    if (live.mergeSlot) return live.mergeSlot
    const n = live.backgroundTasks ?? 0
    if (live.status === 'background') return `Waiting on ${tasks(n)}`
    return n && (live.status === 'finished' || live.status === 'ready') ? `${STATUS_TEXT[live.status]} · ${tasks(n)} running` : STATUS_TEXT[live.status]
  })()
  // A question it doesn't stop for: it works on meanwhile.
  return live.question && live.status !== 'waiting' ? `${text} · has a question for you` : text
}

/**
 * An action under the CLI's automatic review (Codex's Approve for me): a small shield beside the status, which stays
 * Working…. What is asked shows on hover only; the status, other labels and what is announced never carry it.
 */
export function ReviewMark({ live }: { live: Pick<LiveSessionState, 'review' | 'provider'> | null | undefined }) {
  if (!live?.review) return null
  return (
    <Tooltip
      content={
        <>
          <div>{providerName(live.provider)}'s reviewer is checking an action; you aren't needed.</div>
          <div className="faint review-mark-detail">{live.review}</div>
        </>
      }
    >
      <span className="review-mark" role="img" aria-label="An action is being reviewed automatically">
        <Icon name="shield" />
      </span>
    </Tooltip>
  )
}

/**
 * For the tooltips of an agent whose turn a refused sign-in stopped (#309): what its CLI said and how to sign in again
 * (while it needs sign-in), then that Resume (n) carries it on. Null for any other agent.
 */
export function signInNote(live: Pick<LiveSessionState, 'status' | 'signIn' | 'provider'> | null | undefined): string | null {
  if (!live?.signIn) return null
  const d = providerDescriptor(live.provider)
  const said = live.signIn.message.length > 160 ? `${live.signIn.message.slice(0, 160)}…` : live.signIn.message
  if (live.status === 'signin') return `${d.name} says: ${said}\n${d.signInHelp} Then Resume in the project's header carries on the agents it stopped.`
  if (live.status === 'ready' || live.status === 'finished') return `Its turn stopped when ${d.name}'s sign-in expired. Resume in the project's header carries it on.`
  return null
}

export function StatusDot({ live, active }: { live: LiveSessionState | null; active: boolean }) {
  const status = live?.status ?? (active ? 'idle' : 'stopped')
  const said = live?.statusMessage ?? live?.mergeSlot
  const base = !live ? STATUS_TEXT[status] : said ? `${STATUS_TEXT[status]} — ${said}` : statusText(live)
  const reviewed = live?.review ? `${base} · an action is being reviewed automatically` : base
  const note = signInNote(live)
  const text = note ? <span style={{ whiteSpace: 'pre-line' }}>{`${reviewed}\n${note}`}</span> : reviewed
  return (
    <Tooltip content={text}>
      <span className={cx('dot', status, live?.unseen && 'unseen')} />
    </Tooltip>
  )
}

/**
 * One action at a time for a dialog or a button. `run(name, fn)` ignores a second call while one runs; `busy` names
 * the one running (for its button's spinner and "…ing" label), and `error` holds the last failure (cleared by the next
 * run). It resolves to `{ value }` on success and null on failure or when ignored.
 */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<{ value: T } | null> => {
    if (running.current) return null
    running.current = true
    setBusy(name)
    setError(null)
    try {
      return { value: await fn() }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
      return null
    } finally {
      running.current = false
      if (mounted.current) setBusy(null)
    }
  }, [])
  return { busy, error, run, setError }
}

/** A button for an action that takes a moment: while `busy`, a spinner and its "…ing" label, and it can't be clicked. */
export function BusyButton({
  busy,
  busyLabel,
  className,
  disabled,
  autoFocus,
  onClick,
  children
}: {
  busy: boolean
  busyLabel: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button className={cx('btn', className)} disabled={disabled || busy} aria-busy={busy || undefined} autoFocus={autoFocus} onClick={onClick}>
      {busy ? (
        <>
          <Icon name="loading" spin /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}

/** The backdrops up in this window, oldest first: dialogs, nested or not, and the command palette. */
const backdrops: symbol[] = []

/**
 * A backdrop is up while the calling component is mounted: the window is dimmed (once more for each backdrop, as their
 * layers stack), and its native buttons (painted by Windows over the page, where the backdrop can't reach) are dimmed
 * to match, as each comes and goes. Returns whether it is the top one: only that one answers Escape.
 */
export function useBackdrop(): () => boolean {
  const me = useRef(Symbol('backdrop'))
  useEffect(() => {
    const id = me.current
    backdrops.push(id)
    void call('window:setBackdrops', backdrops.length).catch(() => undefined)
    return () => {
      const i = backdrops.lastIndexOf(id)
      if (i >= 0) backdrops.splice(i, 1)
      void call('window:setBackdrops', backdrops.length).catch(() => undefined)
    }
  }, [])
  return useCallback(() => backdrops[backdrops.length - 1] === me.current, [])
}

/** Where a moved dialog may go: its header wholly in the window, below Hive's title bar (whose native buttons would cover its ×). */
function clampOffset(dialog: HTMLElement, offset: { x: number; y: number }, want: { x: number; y: number }): { x: number; y: number } {
  const header = dialog.querySelector('.dialog-header')
  if (!header) return want
  const r = dialog.getBoundingClientRect()
  const h = header.getBoundingClientRect()
  // Where it sits unmoved.
  const left = r.left - offset.x
  const top = r.top - offset.y
  const minTop = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0
  // Wider than the window: its right edge (the ×) stays in it.
  const maxLeft = window.innerWidth - r.width
  const x = Math.min(Math.max(left + want.x, Math.min(0, maxLeft)), maxLeft) - left
  // The header's bottom (below the dialog's border) stays in the window.
  const y = Math.min(Math.max(top + want.y, minTop), Math.max(minTop, window.innerHeight - (h.bottom - r.top))) - top
  return { x: Math.round(x), y: Math.round(y) }
}

/** What a press on a dialog's header leaves alone: its buttons and anything typed in or selected. */
const NOT_A_HANDLE = 'button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** The keys held down now, so a dialog that one of them closes can keep the rest of that key press from its opener. */
const heldKeys = new Set<string>()
/** Keys whose press, still going on, is kept from what has the focus now (holdBackKeyPress), each until it is released. */
const heldBack = new Set<string>()
window.addEventListener('keydown', (e) => heldKeys.add(e.key), true)
// Enter's keypress (which presses a button) and Space's keyup (likewise) of a held-back press go nowhere.
window.addEventListener(
  'keypress',
  (e) => {
    if (!heldBack.has(e.key)) return
    e.preventDefault()
    e.stopPropagation()
  },
  true
)
window.addEventListener(
  'keyup',
  (e) => {
    heldKeys.delete(e.key)
    if (!heldBack.delete(e.key)) return
    e.preventDefault()
    e.stopPropagation()
  },
  true
)
// Released in another window, a key's keyup never comes here: nothing stays held, or held back (#355).
window.addEventListener('blur', () => {
  heldKeys.clear()
  heldBack.clear()
})

/**
 * A dialog closed by Enter or Space (Enter in a prompt's field) gives the focus back to its opener while that key is
 * still down: the rest of the press (Enter's keypress, Space's keyup) would press the opener, a button that opens the
 * dialog again (#355). Kept from it until that key is released (each key on its own), or the window loses the focus.
 */
function holdBackKeyPress(): void {
  for (const k of ['Enter', ' ']) if (heldKeys.has(k)) heldBack.add(k)
}

/**
 * A dialog. While `busy` (an action it started is running) it can't be closed (Escape, outside, ×) and its fields and
 * other buttons are disabled; `error` shows the action's failure above the buttons. Every dialog can be dragged by its
 * header within the window, busy or not (Escape while dragging puts it back), and opens centred each time (#133);
 * `movable={false}` keeps one in place (the image viewers, sized to their image, with their own controls).
 */
export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  busy,
  error,
  movable = true
}: {
  title: string
  icon?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  busy?: boolean
  error?: string | null
  movable?: boolean
}) {
  const busyNow = useRef(busy)
  busyNow.current = busy
  // Escape runs this render's onClose, never an earlier one's: a dialog whose fields fill in after it opens would
  // otherwise answer an Escape with its first render's view of them (#288).
  const onCloseNow = useRef(onClose)
  onCloseNow.current = onClose
  // Dialogs open over each other (a question over a card), and the command palette over them: Escape is for the top one.
  const isTop = useBackdrop()
  const dialog = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const offsetNow = useRef(offset)
  offsetNow.current = offset
  const drag = useRef<{ pointer: number; x: number; y: number; from: { x: number; y: number }; header: HTMLElement } | null>(null)
  const [dragging, setDragging] = useState(false)
  const endDrag = (back: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    // Back where the drag began, as far as the window allows now (it may have shrunk meanwhile).
    if (back) setOffset(dialog.current ? clampOffset(dialog.current, offsetNow.current, d.from) : d.from)
    if (d.header.hasPointerCapture(d.pointer)) d.header.releasePointerCapture(d.pointer)
  }
  // The window got smaller (or was restored): moved back in, so its header and × stay reachable.
  useEffect(() => {
    if (!movable) return
    const onResize = (): void => setOffset((o) => (dialog.current ? clampOffset(dialog.current, o, o) : o))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [movable])
  // Listening from the moment it is on screen (a layout effect), so an Escape straight after it opens closes it.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A search box with text in the dialog takes this Escape to clear itself (#433): the next one closes the dialog.
      if (e.key !== 'Escape' || !isTop() || escapeClearsSearch(e)) return
      // Every dialog listens on the window: only this one may act on this Escape. Once it closes, the one under it is on
      // top, and would close too (or ask again) if its listener came later in the window's list (#133).
      e.stopImmediatePropagation()
      // While it is being dragged, Escape puts it back instead.
      if (drag.current) return endDrag(true)
      if (!busyNow.current) onCloseNow.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // endDrag works through refs and state setters, so the first render's is as good as the latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTop])
  // Closed, it gives the keyboard back to what had it (a terminal, a list): noted while rendering for the
  // first time, before a field inside takes the focus.
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const before = opener.current
    return () => {
      if (before instanceof HTMLElement && before.isConnected) {
        before.focus()
        holdBackKeyPress()
      }
    }
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={dialog}
        className={cx('dialog', wide && 'wide', busy && 'busy', movable && 'movable', dragging && 'dragging')}
        style={offset.x || offset.y ? { translate: `${offset.x}px ${offset.y}px` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
      >
        <div
          className="dialog-header"
          onPointerDown={(e) => {
            if (!movable || e.button !== 0 || (e.target as Element).closest(NOT_A_HANDLE)) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: offsetNow.current, header: e.currentTarget }
            setDragging(true)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d || d.pointer !== e.pointerId || !dialog.current) return
            setOffset(clampOffset(dialog.current, offsetNow.current, { x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }))
          }}
          onPointerUp={() => endDrag(false)}
          onPointerCancel={() => endDrag(false)}
          onLostPointerCapture={() => endDrag(false)}
        >
          {icon && <Icon name={icon} />}
          <h2>{title}</h2>
          <IconButton icon="close" title={busy ? 'Wait for it to finish' : 'Close (Esc)'} disabled={busy} onClick={onClose} />
        </div>
        <div className="dialog-body" inert={busy || undefined}>
          {children}
        </div>
        {error && (
          <div className="dialog-error" role="alert">
            <Icon name="error" /> <span>{error}</span>
          </div>
        )}
        {footer && (
          <div className="dialog-footer" inert={busy || undefined}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

marked.setOptions({ gfm: true, breaks: false })
// GitHub-style heading ids, so the docs' #links work in Hive as they do on GitHub.
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const id = text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    }
  }
})

export function Markdown({ source, className, onLink }: { source: string; className?: string; onLink?: (href: string) => boolean }) {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string)
  return (
    <div
      className={cx('markdown', className)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        const href = a.getAttribute('href') ?? ''
        e.preventDefault()
        if (onLink?.(href)) return
        if (/^https?:/.test(href)) void window.hive.invoke('app:openExternal', href)
        else if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' })
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Context menu anchored at the mouse position. */
export interface MenuEntry {
  label?: string
  icon?: string
  keybinding?: string
  disabled?: boolean
  danger?: boolean
  /** A session action (Stop, Resumeâ€¦): its icon takes that action's colour (#344). */
  action?: SessionAction
  separator?: boolean
  /** A non-clickable heading. */
  header?: boolean
  /** A second, smaller line under the label. */
  detail?: string
  /** Shown greyed out but still clickable. */
  muted?: boolean
  /** Opens another menu in its place (a ▸ at its end; → opens it too). */
  more?: boolean
  /** `keyboard`: chosen with Enter or →, so a menu it opens can take the keys too. */
  onClick?: (keyboard: boolean) => void
}

/** Whether a menu entry can be chosen (with the arrow keys too). */
const choosable = (it: MenuEntry): boolean => !it.separator && !it.header && !it.disabled

/**
 * A menu at x, y. `above`: where its anchor's top is, so a menu that doesn't fit below opens above it instead. ↑ and ↓
 * move through its entries (Home, End), Enter chooses one, → opens one that leads to another menu; `keyboard` (opened
 * from the keyboard) starts on its first entry.
 */
export function ContextMenu({ x, y, above, items, keyboard, onClose }: { x: number; y: number; above?: number; items: MenuEntry[]; keyboard?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(() => (keyboard ? items.findIndex(choosable) : -1))
  const activeRef = useRef(active)
  activeRef.current = active
  const choose = (it: MenuEntry, byKey: boolean): void => {
    if (it.disabled) return
    onClose()
    it.onClick?.(byKey)
  }
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const fits = y + r.height + 8 <= window.innerHeight
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: fits || above === undefined ? Math.min(y, window.innerHeight - r.height - 8) : Math.max(8, above - r.height - 4) })
  }, [x, y, above])
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return onClose()
      const order = items.map((it, i) => (choosable(it) ? i : -1)).filter((i) => i >= 0)
      const at = order.indexOf(activeRef.current)
      const it = items[activeRef.current]
      let next: number | undefined
      if (e.key === 'ArrowDown') next = order[at < 0 ? 0 : (at + 1) % order.length]
      else if (e.key === 'ArrowUp') next = order[at <= 0 ? order.length - 1 : at - 1]
      else if (e.key === 'Home') next = order[0]
      else if (e.key === 'End') next = order[order.length - 1]
      else if (e.key === 'Enter' || (e.key === 'ArrowRight' && it?.more)) {
        // Taken from whatever has the focus (a button that opened the menu would open it again).
        e.preventDefault()
        e.stopPropagation()
        if (!it || !choosable(it)) return
        onClose()
        it.onClick?.(true)
        return
      } else return
      e.preventDefault()
      e.stopPropagation()
      if (next !== undefined) setActive(next)
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, items])
  useEffect(() => {
    if (active >= 0) ref.current?.querySelectorAll('[data-menu-index]').forEach((el) => el.getAttribute('data-menu-index') === String(active) && el.scrollIntoView({ block: 'nearest' }))
  }, [active])
  return createPortal(
    <div className="menu" ref={ref} role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : it.header ? (
          <div key={i} className="menu-header">
            {it.label}
          </div>
        ) : (
          <div
            key={i}
            data-menu-index={i}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={cx('menu-item', actClass(it.action), it.disabled && 'disabled', it.muted && 'muted', it.detail && 'two-line', active === i && 'active')}
            onMouseMove={() => active !== i && choosable(it) && setActive(i)}
            onClick={() => choose(it, false)}
          >
            <Icon name={it.icon ?? 'blank'} />
            {it.detail ? (
              <span className="menu-text">
                <span className="menu-label">{it.label}</span>
                <span className="menu-detail">{it.detail}</span>
              </span>
            ) : (
              <span style={it.danger ? { color: 'var(--error)' } : undefined}>{it.label}</span>
            )}
            {it.keybinding && <span className="menu-key">{it.keybinding}</span>}
            {it.more && (
              <span className="menu-key">
                <Icon name="chevron-right" />
              </span>
            )}
          </div>
        )
      )}
    </div>,
    document.body
  )
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; keyboard?: boolean; n: number } | null>(null)
  // Counts openings, so a menu opened from another's entry (closed in the same update) is a new one.
  const opened = useRef(0)
  const open = (e: React.MouseEvent, items: MenuEntry[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items, n: ++opened.current })
  }
  /** Opens the menu at a point, e.g. under a button; `keyboard`: opened from the keyboard, on its first entry. */
  const openAt = (x: number, y: number, items: MenuEntry[], keyboard?: boolean): void => setMenu({ x, y, items, keyboard, n: ++opened.current })
  const element = menu ? <ContextMenu key={menu.n} x={menu.x} y={menu.y} items={menu.items} keyboard={menu.keyboard} onClose={() => setMenu(null)} /> : null
  return { open, openAt, element }
}
