import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { LiveSessionState, SessionStatus } from '@shared/types'
import { cx } from '../util'
import { errorMessage } from '../api'
import { shortStartTime } from '@shared/defaults'
import { providerName } from '@shared/providers'

export function Icon({ name, className, title, spin }: { name: string; className?: string; title?: string; spin?: boolean }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'spin', className)} title={title} aria-hidden={!title} />
}

/** Hover tooltip rendered in a portal so it is never clipped by scroll containers. */
export function Tooltip({ content, children, delay = 350, block, side }: { content: ReactNode; children: ReactNode; delay?: number; block?: boolean; side?: 'right' }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean; right?: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      if (side === 'right') return setPos({ x: r.right + 8, y: r.top + r.height / 2, above: false, right: true })
      const above = r.bottom + 120 > window.innerHeight
      setPos({ x: Math.min(r.left, window.innerWidth - 380), y: above ? r.top - 8 : r.bottom + 8, above })
    }, delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setPos(null)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!content) return <>{children}</>
  return (
    <span className="tip-wrap" style={block ? { display: 'flex' } : undefined} ref={ref} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div className="tip" style={{ left: Math.max(8, pos.x), top: pos.y, transform: pos.right ? 'translateY(-50%)' : pos.above ? 'translateY(-100%)' : undefined }}>
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
          <Icon name="warning" /> Could not refresh {what}{at ? `; last updated ${shortStartTime(new Date(at).toISOString())}` : ''}.
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
  className
}: {
  icon: string
  title: string
  onClick?: (e: React.MouseEvent) => void
  disabled?: boolean
  active?: boolean
  className?: string
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
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
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
  finished: 'Finished',
  error: 'Error'
}

const tasks = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`

/** What an agent is doing, in words: its status message, else its status with any background tasks it is running. */
export function statusText(live: Pick<LiveSessionState, 'status' | 'statusMessage' | 'backgroundTasks' | 'question'>): string {
  const text = ((): string => {
    if (live.statusMessage) return live.statusMessage
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

export function StatusDot({ live, active }: { live: LiveSessionState | null; active: boolean }) {
  const status = live?.status ?? (active ? 'idle' : 'stopped')
  const base = !live ? STATUS_TEXT[status] : live.statusMessage ? `${STATUS_TEXT[status]} — ${live.statusMessage}` : statusText(live)
  const text = live?.review ? `${base} · an action is being reviewed automatically` : base
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

/** The dialogs open, oldest first. */
const openModals: symbol[] = []

/**
 * A dialog. While `busy` (an action it started is running) it can't be closed (Escape, outside, ×) and its fields and
 * other buttons are disabled; `error` shows the action's failure above the buttons.
 */
export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  busy,
  error
}: {
  title: string
  icon?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  busy?: boolean
  error?: string | null
}) {
  const busyNow = useRef(busy)
  busyNow.current = busy
  // Dialogs open over each other (a question over a card): Escape is for the top one only.
  const me = useRef(Symbol('dialog'))
  useEffect(() => {
    const id = me.current
    openModals.push(id)
    return () => {
      const i = openModals.lastIndexOf(id)
      if (i >= 0) openModals.splice(i, 1)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || openModals[openModals.length - 1] !== me.current) return
      e.stopPropagation()
      if (!busyNow.current) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // Closed, it gives the keyboard back to what had it (a terminal, a list): noted while rendering for the
  // first time, before a field inside takes the focus.
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const before = opener.current
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={cx('dialog', wide && 'wide', busy && 'busy')} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <div className="dialog-header">
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
  separator?: boolean
  /** A non-clickable heading. */
  header?: boolean
  /** A second, smaller line under the label. */
  detail?: string
  /** Shown greyed out but still clickable. */
  muted?: boolean
  onClick?: () => void
}

/** A menu at x, y. `above`: where its anchor's top is, so a menu that doesn't fit below opens above it instead. */
export function ContextMenu({ x, y, above, items, onClose }: { x: number; y: number; above?: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
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
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.header ? (
          <div key={i} className="menu-header">
            {it.label}
          </div>
        ) : (
          <div
            key={i}
            className={cx('menu-item', it.disabled && 'disabled', it.muted && 'muted', it.detail && 'two-line')}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onClick?.()
            }}
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
          </div>
        )
      )}
    </div>,
    document.body
  )
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const open = (e: React.MouseEvent, items: MenuEntry[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  /** Opens the menu at a point, e.g. under a button. */
  const openAt = (x: number, y: number, items: MenuEntry[]): void => setMenu({ x, y, items })
  const element = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null
  return { open, openAt, element }
}
