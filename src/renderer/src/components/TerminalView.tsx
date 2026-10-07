import { useEffect, useRef, type CSSProperties } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { attempt } from '../actions'
import { call } from '../api'
import { deferredFocus } from '../deferredFocus'
import { isAppShortcut } from '../commands'
import { fileLinkProvider } from '../fileLinks'
import { useStore } from '../store'
import { offerTip } from '../tips'
import type { ProviderId } from '@shared/types'
import { carriesFiles, cx, HIVE_FILES_MIME, IMAGE_EXT, quotePath } from '../util'

type Listener = (data: string) => void
const dataListeners = new Map<string, Set<Listener>>()
const exitListeners = new Map<string, Set<(code: number) => void>>()
let wired = false
const terminals = new Map<string, Terminal>()

/**
 * WebGL contexts held by terminals. Chromium allows about 16 per window and silently drops the
 * oldest beyond that, which could be a terminal on screen. At most four terminals are on screen at
 * once; hidden ones give their context back after a while, or straight away when a visible terminal
 * needs one and the budget is used up. Everything else draws with the DOM renderer, so any number of
 * sessions can run.
 */
const WEBGL_BUDGET = 8
const webglHolders = new Map<string, { visible: boolean; since: number; release: () => void }>()

function makeRoomForWebgl(key: string): void {
  while (webglHolders.size >= WEBGL_BUDGET) {
    const idle = [...webglHolders.entries()].filter(([k, h]) => k !== key && !h.visible).sort((a, b) => a[1].since - b[1].since)[0]
    if (!idle) return
    idle[1].release()
  }
}

/**
 * Disposes a terminal's WebGL renderer and gives its context back at once. Disposing alone leaves the context alive
 * until garbage collection, so a batch of new sessions (Start New (All), #293) piled up contexts until Chromium dropped
 * the window's oldest live one: the Hive Assistant's, which went black and then drew again.
 */
function disposeWebgl(webgl: WebglAddon, canvases: HTMLCanvasElement[]): void {
  webgl.dispose()
  // A canvas that has a WebGL2 context returns that one; losing a context already lost does nothing.
  for (const c of canvases) c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
}

/** How many terminals hold a WebGL context (for tests). */
;(window as unknown as { __hiveWebglCount?: () => number }).__hiveWebglCount = () => webglHolders.size

/** Where some text is on screen in a terminal (the middle of its first character), for tests that point at it. */
;(window as unknown as { __hiveTerminalTextAt?: (key: string, text: string) => { x: number; y: number } | null }).__hiveTerminalTextAt = (key, text) => {
  const term = terminals.get(key)
  const screen = term?.element?.querySelector('.xterm-screen')
  if (!term || !screen) return null
  const box = screen.getBoundingClientRect()
  const buf = term.buffer.active
  for (let row = 0; row < term.rows; row++) {
    const col = buf.getLine(buf.viewportY + row)?.translateToString(true).indexOf(text) ?? -1
    if (col >= 0) return { x: box.left + ((col + 0.5) * box.width) / term.cols, y: box.top + ((row + 0.5) * box.height) / term.rows }
  }
  return null
}

/** A terminal's size and scroll, for tests: scrolled to the bottom when viewportY is baseY. */
;(window as unknown as { __hiveTerminalState?: (key: string) => { cols: number; rows: number; viewportY: number; baseY: number } | null }).__hiveTerminalState = (key) => {
  const term = terminals.get(key)
  if (!term) return null
  return { cols: term.cols, rows: term.rows, viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY }
}

/** Scrolls a terminal by some lines without any input, as xterm's own late scroll syncs do, for tests. */
;(window as unknown as { __hiveTerminalScrollLines?: (key: string, lines: number) => void }).__hiveTerminalScrollLines = (key, lines) => terminals.get(key)?.scrollLines(lines)

/**
 * Pastes text into a mounted terminal as a real paste (bracketed when the program asked for it),
 * so Claude Code treats pasted image paths as attachments. Returns false if no terminal is mounted.
 */
export function pasteIntoTerminal(ptyKey: string, text: string): boolean {
  const term = terminals.get(ptyKey)
  if (!term) return false
  term.paste(text)
  return true
}

/** Smaller than this is a measurement of a terminal not laid out (hidden, or mid-layout), never a pane's real size (#247). */
const MIN_COLS = 20
const MIN_ROWS = 5
/** A layout that is still settling (a view shown again re-renders its header as it measures it) is fitted once, at its final size. */
const FIT_SETTLE_MS = 100
/** How long after a fit, or being shown, a terminal following its output is held at the bottom (see TerminalView). */
const HOLD_BOTTOM_MS = 1000
/** How long after a wheel turn or a key a scroll counts as the user's. */
const USER_SCROLL_MS = 500

/**
 * Fits a terminal to its pane and tells its process the size: the only place that does (#247). Never while the
 * terminal is hidden (its own class, or an ancestor's display: none, as when Settings is open) or measures smaller than
 * MIN_COLS × MIN_ROWS: xterm would measure next to nothing, and Claude Code redraws into a column two characters wide.
 * The main process passes on only a change of size. True when it fitted.
 */
function fitTerminal(term: Terminal, fit: FitAddon, el: HTMLElement | null, visible: boolean, ptyKey: string): boolean {
  if (!visible || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return false
  try {
    const dims = fit.proposeDimensions()
    if (!dims || !(dims.cols >= MIN_COLS) || !(dims.rows >= MIN_ROWS)) return false
    fit.fit()
    void call('pty:resize', ptyKey, term.cols, term.rows)
    return true
  } catch {
    // ignore transient layout errors
    return false
  }
}

function wire(): void {
  if (wired) return
  wired = true
  window.hive.onPtyData((key, data) => dataListeners.get(key)?.forEach((l) => l(data)))
  window.hive.onPtyExit((key, code) => exitListeners.get(key)?.forEach((l) => l(code)))
}

function subscribe<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key)!.add(fn)
  return () => map.get(key)?.delete(fn)
}

const DARK: ITheme = {
  background: '#1a1a1a',
  foreground: '#d4d4d4',
  cursor: '#f59e0b',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#f59e0b55',
  black: '#1e1e1e',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#f5c451',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#ffc444',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

const LIGHT: ITheme = {
  background: '#fbfbfb',
  foreground: '#333333',
  cursor: '#d97706',
  cursorAccent: '#ffffff',
  selectionBackground: '#f59e0b44',
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

export function terminalTheme(): ITheme {
  return document.documentElement.dataset.theme === 'light' ? LIGHT : DARK
}

/**
 * An xterm.js view attached to a pty in the main process. The component stays mounted while
 * hidden so the terminal keeps its state when switching between projects.
 */
export function TerminalView({
  ptyKey,
  visible,
  onExit,
  autoFocus = true,
  projectPath,
  agentId,
  provider,
  style,
  onFocus
}: {
  ptyKey: string
  visible: boolean
  onExit?: (code: number) => void
  autoFocus?: boolean
  /** Set for session terminals: pasted and dropped images are saved into the project's .hive folder. */
  projectPath?: string
  /** The agent whose session this is. */
  agentId?: string
  /** The agent's provider: its terminal UI keeps its own shortcuts. */
  provider?: ProviderId
  /** Position within its layer (a pane), instead of filling it. */
  style?: CSSProperties
  /** Called when the terminal gets keyboard focus or is clicked. */
  onFocus?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** Fits the terminal to its pane and tells the process its size once the layout settles, if it is on screen (see fitTerminal). */
  const fitSoon = useRef<() => void>(() => {})
  /** Holds a terminal that follows its output at the bottom while the layout settles (hold, in the terminal's effect). */
  const holdBottom = useRef<() => void>(() => {})
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const appearance = useStore((s) => s.settings?.appearance)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onFocusRef = useRef(onFocus)
  const providerRef = useRef(provider)
  providerRef.current = provider
  // The key handler is set once per terminal; these keep it pointed at the current agent.
  const pathRef = useRef(projectPath)
  pathRef.current = projectPath
  const agentRef = useRef(agentId)
  agentRef.current = agentId
  onFocusRef.current = onFocus
  const webglRef = useRef<WebglAddon | null>(null)
  /** The canvases the WebGL renderer added, whose context is given back with it (disposeWebgl). */
  const webglCanvases = useRef<HTMLCanvasElement[]>([])
  const dropWebgl = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    wire()
    const a = useStore.getState().settings?.appearance
    const term = new Terminal({
      fontFamily: a?.terminalFontFamily,
      fontSize: a?.terminalFontSize ?? 13,
      scrollback: a?.terminalScrollback ?? 10000,
      cursorBlink: a?.terminalCursorBlink ?? true,
      allowProposedApi: true,
      theme: terminalTheme(),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // Symbols missing from the terminal font (e.g. Claude Code's close button) come from a wider
      // fallback font; squeeze them into their cell instead of letting the next cell paint over half.
      // Needs the WebGL renderer below.
      rescaleOverlappingGlyphs: true,
      windowsPty: { backend: 'conpty' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void call('app:openExternal', uri)))
    // A session's file paths: Ctrl+click opens them in the Files tab.
    term.registerLinkProvider(fileLinkProvider(term, () => ({ projectPath: pathRef.current, agentId: agentRef.current }), () => host.current))
    // xterm's fit addon measures the terminal's parent. With border-box sizing a padded parent reports
    // its padding as usable space, so the padding lives on the host and the terminal mounts in an
    // unpadded child — otherwise the last row/column can spill over the status bar or off the edge.
    term.open(mount.current!)
    termRef.current = term
    terminals.set(ptyKey, term)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      // Copy with Ctrl+C only when there is a selection; otherwise Ctrl+C interrupts the agent.
      if (mod && !e.altKey && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (mod && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        void navigator.clipboard.readText().then(async (t) => {
          if (t) term.paste(t)
          else if (pathRef.current) {
            // A screenshot: save it and paste its path, which the agent's CLI attaches as an image.
            const p = pathRef.current
            const saved = await attempt('Could not paste image', () => call('session:saveImage', p, undefined, agentRef.current))
            if (saved) {
              term.paste(quotePath(saved))
              offerTip('image-pasted')
            }
          }
        })
        e.preventDefault()
        return false
      }
      return !isAppShortcut(e, providerRef.current)
    })
    // Removed with the terminal: the host element can outlive it (a new ptyKey in the same view).
    const listeners = new AbortController()
    const { signal } = listeners
    host.current!.addEventListener('focusin', () => onFocusRef.current?.(), { signal })
    host.current!.addEventListener('mousedown', () => onFocusRef.current?.(), { signal })
    // Right-click is Hive's copy/paste (below). Keep the button from xterm, which would otherwise report it to
    // programs that track the mouse (Codex), and Codex pastes on right-click too: everything was pasted twice.
    for (const type of ['mousedown', 'mouseup'] as const) {
      host.current!.addEventListener(type, (e) => {
        if (e.button !== 2) return
        e.stopPropagation()
        if (type === 'mousedown') onFocusRef.current?.()
      }, { signal, capture: true })
    }
    host.current!.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      } else void navigator.clipboard.readText().then((t) => t && term.paste(t))
    }, { signal })

    // Files dropped from Explorer or Hive's Files/Images tabs are pasted as paths. Images are first
    // copied into .hive/images, unless they are already there.
    host.current!.addEventListener('dragover', (e) => {
      if (!carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }, { signal })
    host.current!.addEventListener('drop', (e) => {
      const dt = e.dataTransfer
      if (!carriesFiles(dt)) return
      e.preventDefault()
      const internal = dt!.getData(HIVE_FILES_MIME)
      const sources = internal ? (JSON.parse(internal) as { paths: string[] }).paths : [...dt!.files].map((f) => window.hive.pathForFile(f))
      void (async () => {
        const paths: string[] = []
        for (const p of sources) {
          if (!p) continue
          const project = pathRef.current
          const keep = project && IMAGE_EXT.test(p) && !/[\\/]\.hive[\\/]images[\\/]/i.test(p)
          const saved = keep ? await attempt('Could not add image', () => call('session:saveImage', project, p, agentRef.current)) : null
          if (saved) offerTip('image-pasted')
          paths.push(quotePath(saved || p))
        }
        if (paths.length) term.paste(paths.join(' ') + ' ')
        term.focus()
      })()
    }, { signal })

    const disposeInput = term.onData((d) => void call('pty:write', ptyKey, d))
    // IPC keeps event order, so anything received before the buffer reply is already in the buffer.
    let replayed = false
    const unsubData = subscribe(dataListeners, ptyKey, (d: string) => {
      if (replayed) term.write(d)
    })
    const unregister = (): void => {
      if (terminals.get(ptyKey) === term) terminals.delete(ptyKey)
    }
    const unsubExit = subscribe(exitListeners, ptyKey, (code: number) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
      onExitRef.current?.(code)
    })
    // Replay what the process printed before this view existed (e.g. after a window reload).
    void call('pty:buffer', ptyKey).then((buf) => {
      if (buf) term.write(buf)
      replayed = true
    })

    // Whether the user follows the output (at the bottom) or reads further up: only their own scrolling (wheel, keys,
    // the scrollbar) changes it. After a fit or being shown, xterm syncs its scroll position a frame or more later, from
    // one measured before (a hidden view's is 0), which can leave the view lines up or at the top (#247). For a while
    // after each, a terminal following its output is put back at the bottom whenever that happens; a reader stays put.
    const buf = (): typeof term.buffer.active => term.buffer.active
    const atBottom = (): boolean => buf().viewportY >= buf().baseY
    let follows = true
    let holdUntil = 0
    const hold = (): void => {
      holdUntil = Date.now() + HOLD_BOTTOM_MS
      if (follows && !atBottom()) term.scrollToBottom()
    }
    holdBottom.current = hold
    const keepAtBottom = (): void => {
      if (follows && Date.now() < holdUntil && !atBottom()) term.scrollToBottom()
    }
    // The user scrolls: just after a wheel turn or a key (a wheel's scroll can land a few frames later), or while a mouse
    // button is held (dragging the scrollbar). Each scroll then says whether they follow the output.
    let userUntil = 0
    let pressed = false
    const userActs = (): void => {
      holdUntil = 0
      userUntil = Date.now() + USER_SCROLL_MS
    }
    for (const type of ['wheel', 'keydown'] as const) host.current!.addEventListener(type, userActs, { signal, capture: true, passive: true })
    host.current!.addEventListener('mousedown', () => {
      userActs()
      pressed = true
    }, { signal, capture: true, passive: true })
    window.addEventListener('mouseup', () => {
      if (!pressed) return
      pressed = false
      userActs()
    }, { signal, capture: true, passive: true })
    const disposeScroll = term.onScroll(() => {
      if (pressed || Date.now() < userUntil) follows = atBottom()
      else keepAtBottom()
    })
    const disposeRender = term.onRender(keepAtBottom)

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      fitTimer = null
      if (fitTerminal(term, fit, host.current, visibleRef.current, ptyKey)) hold()
    }
    const scheduleFit = (): void => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(doFit, FIT_SETTLE_MS)
    }
    fitSoon.current = scheduleFit
    const ro = new ResizeObserver(scheduleFit)
    ro.observe(mount.current!)
    scheduleFit()

    return () => {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      webglHolders.delete(ptyKey)
      if (webglRef.current) disposeWebgl(webglRef.current, webglCanvases.current)
      webglRef.current = null
      listeners.abort()
      ro.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
      disposeScroll.dispose()
      disposeRender.dispose()
      disposeInput.dispose()
      unsubData()
      unsubExit()
      unregister()
      term.dispose()
      termRef.current = null
    }
  }, [ptyKey])

  useEffect(() => {
    const term = termRef.current
    if (!term || !appearance) return
    term.options.fontFamily = appearance.terminalFontFamily
    term.options.fontSize = appearance.terminalFontSize
    term.options.cursorBlink = appearance.terminalCursorBlink
    term.options.scrollback = appearance.terminalScrollback
    term.options.theme = terminalTheme()
    // A hidden terminal (Settings is open, say) isn't fitted now: it is when it's shown again.
    fitSoon.current()
  }, [appearance, ptyKey])

  // WebGL renderer (as in VS Code): faster, and needed for rescaleOverlappingGlyphs. Only visible
  // terminals take a context, within WEBGL_BUDGET (see above); hidden ones keep it for 30 seconds so
  // switching back is instant, then fall back to the DOM renderer.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const release = (): void => {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      dropWebgl.current = null
      webglHolders.delete(ptyKey)
      if (webglRef.current) disposeWebgl(webglRef.current, webglCanvases.current)
      webglRef.current = null
    }
    if (visible) {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      dropWebgl.current = null
      if (!webglRef.current) {
        makeRoomForWebgl(ptyKey)
        try {
          const webgl = new WebglAddon()
          const canvases = (): HTMLCanvasElement[] => [...(term.element?.querySelectorAll('canvas') ?? [])]
          const had = new Set(canvases())
          webgl.onContextLoss(() => {
            webgl.dispose()
            if (webglRef.current === webgl) {
              webglRef.current = null
              webglHolders.delete(ptyKey)
              // The DOM renderer measures its cells differently: fitted again, or the terminal spills past its pane.
              fitSoon.current()
            }
          })
          term.loadAddon(webgl)
          webglRef.current = webgl
          webglCanvases.current = canvases().filter((c) => !had.has(c))
        } catch {
          // DOM renderer it is.
        }
      }
      if (webglRef.current) webglHolders.set(ptyKey, { visible: true, since: Date.now(), release })
    } else if (webglRef.current) {
      webglHolders.set(ptyKey, { visible: false, since: Date.now(), release })
      if (!dropWebgl.current) dropWebgl.current = setTimeout(release, 30_000)
    }
  }, [visible, ptyKey])

  useEffect(() => {
    if (!visible) return
    // Shown again: held at the bottom if it follows its output, and fitted once the layout settles (or by the resize
    // observer once it has its size).
    holdBottom.current()
    fitSoon.current()
    // The next frame's focus, unless the user chose otherwise meanwhile (#327).
    const current = deferredFocus(() => host.current)
    requestAnimationFrame(() => {
      if (autoFocus && current()) termRef.current?.focus()
    })
  }, [visible, ptyKey, autoFocus])

  return (
    <div
      className={cx('terminal-host', !visible && 'hidden')}
      data-pty={ptyKey}
      style={{ ['--terminal-bg' as string]: terminalTheme().background, ...style }}
      ref={host}
    >
      <div className="terminal-mount" ref={mount} />
    </div>
  )
}
