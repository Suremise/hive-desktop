import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from '@shared/devConsole'
import { clockTime, filterChoices, filterEvents, mergeEvents, sourceGroups, sourceOption, startsOpen } from '@shared/consoleView'
import type { AppSettings, HiveEvent } from '@shared/types'
import { providerName } from '@shared/providers'
import { call, errorMessage } from './api'
import { Icon, IconButton, SearchInput } from './components/ui'
import { cx } from './util'
import './styles/console.css'

/**
 * The developer console window (#366, #637): pick a source (an agent's session, the Assistant or Hive itself) and watch
 * what comes in next to what Hive made of it. Capture runs while this window watches a source (#636); pause stops the
 * list moving (capture goes on, and resuming fills in from the ring), clear hides what came before. Record writes the
 * source's events from then on to a file in main (#638), redacted unless the user ticks text for that recording. While
 * Settings → Advanced → Developer console: show text is on (#699), main sends this window the text too (never secrets):
 * a banner says so, and the recording box starts ticked.
 */

function applyTheme(s: AppSettings | null): void {
  if (!s) return
  const t = s.appearance.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.appearance.theme
  document.documentElement.dataset.theme = t
  document.documentElement.style.setProperty('--ui-font-size', `${s.appearance.uiFontSize}px`)
}

const NO_SOURCES: ConsoleSource[] = []

export function ConsoleApp() {
  const [sources, setSources] = useState<ConsoleSource[]>(NO_SOURCES)
  const [source, setSource] = useState('')
  const [events, setEvents] = useState<ConsoleEvent[]>([])
  const [paused, setPaused] = useState(false)
  const [waiting, setWaiting] = useState(0)
  const [dropped, setDropped] = useState(0)
  const [afterSeq, setAfterSeq] = useState(0)
  const [provider, setProvider] = useState('')
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const [error, setError] = useState('')
  // This window's recording: going on, or the last one it stopped (#638). Text is asked for each time.
  const [recording, setRecording] = useState<ConsoleRecordingInfo | null>(null)
  const [recordMenu, setRecordMenu] = useState(false)
  const [withText, setWithText] = useState(false)
  // Settings → Advanced → Developer console: show text (#699); main decides what it sends, this says so.
  const [showText, setShowText] = useState(false)
  const recordingRef = useRef(false)
  recordingRef.current = !!recording?.recording
  const pausedRef = useRef(false)
  const sourceRef = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const eventsRef = useRef(events)
  eventsRef.current = events
  // The newest event received for the source, shown or held while paused: Clear hides everything up to it.
  const latestRef = useRef(0)
  // Clear's boundary: events at or before it never come back (a resume's snapshot included).
  const clearedRef = useRef(0)

  useEffect(() => {
    let settings: AppSettings | null = null
    void call('settings:get').then((s) => {
      settings = s
      applyTheme(s)
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => applyTheme(settings)
    mq.addEventListener('change', onScheme)
    const off = window.hive.onEvent((e: HiveEvent) => {
      if (e.type === 'settings-changed') {
        settings = e.settings
        applyTheme(e.settings)
      } else if (e.type === 'console-recording') {
        setRecording(e.recording)
      } else if (e.type === 'console-options') {
        setShowText(e.showText)
      } else if (e.type === 'console-events') {
        const mine = e.events.filter((x) => x.source === sourceRef.current && x.seq > clearedRef.current)
        if (e.dropped) setDropped((n) => n + e.dropped!)
        if (!mine.length) return
        latestRef.current = Math.max(latestRef.current, ...mine.map((x) => x.seq))
        if (pausedRef.current) setWaiting((n) => n + mine.length)
        else setEvents((list) => mergeEvents(list, mine))
      }
    })
    return () => {
      off()
      mq.removeEventListener('change', onScheme)
    }
  }, [])

  const loadSources = useCallback(() => {
    call('console:sources').then(
      (list) => {
        setSources(list)
        setError('')
      },
      (e) => setError(errorMessage(e))
    )
  }, [])

  useEffect(() => {
    void call('console:options').then((o) => setShowText(o.showText), () => undefined)
  }, [])

  // Text turned on or off: what is listed is read again as main now sends it (turned off, no text stays on screen).
  const shownText = useRef<boolean | null>(null)
  useEffect(() => {
    const was = shownText.current
    shownText.current = showText
    const from = sourceRef.current
    if (was === null || was === showText || !from) return
    void call('console:snapshot', from, clearedRef.current).then((got) => {
      if (sourceRef.current !== from) return
      // Paused, the list stays as it was: only what it shows is read again.
      const list = eventsRef.current
      const upTo = pausedRef.current ? (list.length ? list[list.length - 1].seq : 0) : Infinity
      const kept = got.filter((x) => x.seq > clearedRef.current && x.seq <= upTo)
      if (kept.length) latestRef.current = Math.max(latestRef.current, kept[kept.length - 1].seq)
      setEvents(kept)
    })
  }, [showText])

  useEffect(() => {
    loadSources()
    window.addEventListener('focus', loadSources)
    return () => window.removeEventListener('focus', loadSources)
  }, [loadSources])

  // Watching a source starts its capture; another source replaces it, none ends it.
  useEffect(() => {
    sourceRef.current = source
    // A recording is of one source: picking another stops it.
    if (recordingRef.current) void call('console:stopRecording').then((r) => r && setRecording(r), () => undefined)
    setRecordMenu(false)
    setEvents([])
    setPicked(null)
    setWaiting(0)
    setDropped(0)
    setAfterSeq(0)
    latestRef.current = 0
    clearedRef.current = 0
    stick.current = true
    if (!source) {
      void call('console:subscribe', []).catch(() => undefined)
      return
    }
    let stale = false
    call('console:subscribe', [source]).then(
      (got) => {
        if (stale) return
        const first = got[source] ?? []
        if (first.length) latestRef.current = Math.max(latestRef.current, first[first.length - 1].seq)
        setEvents((list) => mergeEvents(list, first))
        loadSources()
      },
      (e) => !stale && setError(errorMessage(e))
    )
    return () => {
      stale = true
    }
  }, [source, loadSources])

  const resume = useCallback(() => {
    pausedRef.current = false
    setPaused(false)
    setWaiting(0)
    const from = sourceRef.current
    if (!from) return
    // What came while paused is still in the source's ring.
    const list = eventsRef.current
    const since = list.length ? list[list.length - 1].seq : 0
    void call('console:snapshot', from, Math.max(since, clearedRef.current)).then((got) => {
      if (sourceRef.current !== from) return
      const kept = got.filter((x) => x.seq > clearedRef.current)
      if (kept.length) latestRef.current = Math.max(latestRef.current, kept[kept.length - 1].seq)
      setEvents((l) => mergeEvents(l, kept))
    })
  }, [])

  const pause = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
  }, [])

  // Clear empties the list through the newest event received, held ones too: only what comes after shows.
  const clear = useCallback(() => {
    const list = eventsRef.current
    const upTo = Math.max(latestRef.current, list.length ? list[list.length - 1].seq : 0)
    clearedRef.current = upTo
    setAfterSeq(upTo)
    setEvents([])
    setWaiting(0)
    setPicked(null)
    setDropped(0)
  }, [])

  const startRecording = (): void => {
    const from = sourceRef.current
    if (!from) return
    setRecordMenu(false)
    call('console:record', from, { includeText: withText }).then(setRecording, (e) => setError(errorMessage(e)))
  }
  // The box starts as the setting says each time the menu opens.
  const toggleRecordMenu = (): void => {
    if (!recordMenu) setWithText(showText)
    setRecordMenu(!recordMenu)
  }
  const stopRecording = (): void => void call('console:stopRecording').then((r) => r && setRecording(r), (e) => setError(errorMessage(e)))

  const choices = useMemo(() => filterChoices(events), [events])
  const shown = useMemo(() => filterEvents(events, { provider, hiddenKinds, search, afterSeq }), [events, provider, hiddenKinds, search, afterSeq])
  const current = picked === null ? null : (shown.find((e) => e.seq === picked) ?? events.find((e) => e.seq === picked) ?? null)
  const groups = useMemo(() => sourceGroups(sources), [sources])
  const watched = sources.find((s) => s.id === source)

  // The list follows new events while it is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement !== searchRef.current) setPicked(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleKind = (k: string): void =>
    setHiddenKinds((h) => {
      const next = new Set(h)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div className="dc">
      <div className="dc-toolbar">
        <select className="dc-source" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">Pick a source…</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {sourceOption(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <IconButton icon="refresh" title="Refresh the sources" onClick={loadSources} />
        <span className={cx('dc-live', !source ? 'off' : paused ? 'paused' : 'live')} role="status">
          <Icon name={!source ? 'circle-large-outline' : paused ? 'debug-pause' : 'circle-filled'} />
          {!source ? 'Not watching' : paused ? `Paused${waiting ? ` (${waiting} new)` : ''}` : 'Live'}
        </span>
        <IconButton icon={paused ? 'debug-start' : 'debug-pause'} title={paused ? 'Resume' : 'Pause'} onClick={paused ? resume : pause} disabled={!source} className="dc-pause" />
        <IconButton icon="clear-all" title="Clear" onClick={clear} disabled={!events.length && !waiting} className="dc-clear" />
        {recording?.recording ? (
          <button className="btn small dc-record-stop" onClick={stopRecording}>
            <Icon name="debug-stop" /> Stop recording
          </button>
        ) : (
          <span className="dc-record-wrap">
            <IconButton icon="record" title="Record to a file" onClick={toggleRecordMenu} disabled={!source} className="dc-record" expanded={recordMenu} />
            {recordMenu && (
              <div className="dc-record-menu" role="dialog" aria-label="Record">
                <div>
                  Record {watched ? sourceOption({ ...watched, events: 0 }) : 'this source'} to a file, from now until you stop. Redacted unless you tick text: no prompt or reply text, commands, tokens or sign-ins.
                </div>
                <label className="flex dialog-check">
                  <input type="checkbox" className="checkbox" checked={withText} onChange={(e) => setWithText(e.target.checked)} /> Include prompt and reply text in this recording (tokens and sign-ins stay masked)
                </label>
                <div className="dc-record-actions">
                  <button className="btn small subtle" onClick={() => setRecordMenu(false)}>
                    Cancel
                  </button>
                  <button className="btn small primary dc-record-start" onClick={startRecording}>
                    Start recording
                  </button>
                </div>
              </div>
            )}
          </span>
        )}
        <span className="dc-sep" />
        <div className="dc-search">
          <Icon name="search" />
          <SearchInput ref={searchRef} value={search} onChange={setSearch} placeholder="Search events (Ctrl+F)" aria-label="Search events" spellCheck={false} />
        </div>
        <select className="dc-provider" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          <option value="">All providers</option>
          {choices.providers.map((p) => (
            <option key={p} value={p}>
              {providerName(p as never) || p}
            </option>
          ))}
        </select>
      </div>
      {choices.kinds.length > 0 && (
        <div className="dc-kinds" role="group" aria-label="Event types">
          {choices.kinds.map((k) => (
            <button key={k} className={cx('dc-kind', !hiddenKinds.has(k) && 'on')} aria-pressed={!hiddenKinds.has(k)} onClick={() => toggleKind(k)} data-kind={k}>
              {k}
            </button>
          ))}
        </div>
      )}
      {showText && (
        <div className="banner warn dc-unredacted" role="status">
          <Icon name="unlock" />
          <span>
            <b>Unredacted:</b> this console shows prompt, reply and command text (Settings → Advanced → Developer console: show prompt, reply and command text). Tokens, API keys and sign-in details stay masked.
          </span>
        </div>
      )}
      {error && <div className="dc-error">{error}</div>}
      <div className={cx('dc-body', current && 'with-detail')}>
        <div
          className="dc-list"
          ref={listRef}
          role="list"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {!source && (
            <div className="dc-empty">
              Pick a source to watch. Hive captures a source only while this window watches it, and what it captures is redacted:{' '}
              {showText ? 'no tokens or sign-in details (this window shows prompt, reply and command text while the setting is on).' : 'no prompt or reply text, commands, tokens or sign-in details.'}
            </div>
          )}
          {source && !shown.length && <div className="dc-empty">{events.length ? 'No events match.' : 'Waiting for events…'}</div>}
          {shown.map((e) => (
            <div key={e.seq} role="listitem" className={cx('dc-row', picked === e.seq && 'picked')} data-kind={e.kind} data-seq={e.seq} onClick={() => setPicked(picked === e.seq ? null : e.seq)}>
              <span className="dc-time">{clockTime(e.at)}</span>
              <span className="dc-kind-tag">{e.kind}</span>
              <span className="dc-name">{e.name}</span>
              <span className="dc-summary" title={e.summary}>
                {e.summary}
              </span>
              {e.truncated && <Icon name="fold" title="Cut down to its outline (too large)" />}
            </div>
          ))}
        </div>
        {current && (
          <div className="dc-detail">
            <div className="dc-detail-head">
              <span className="dc-name">{current.name}</span>
              <span className="dc-kind-tag">{current.kind}</span>
              {current.provider && <span className="dc-meta">{providerName(current.provider)}</span>}
              <span className="dc-meta">{clockTime(current.at)}</span>
              <span className="dc-meta">{current.bytes.toLocaleString()} bytes</span>
              {current.truncated && <span className="dc-meta">cut down to its outline</span>}
              <span className="dc-sep" />
              <IconButton icon="close" title="Close (Esc)" onClick={() => setPicked(null)} />
            </div>
            <div className="dc-summary-full">{current.summary}</div>
            <div className="dc-sides">
              <section className="dc-side dc-raw">
                <h3>Raw</h3>
                <Payload value={current.raw} />
              </section>
              <section className="dc-side dc-made">
                <h3>What Hive made of it</h3>
                <Payload value={current.made} />
              </section>
            </div>
          </div>
        )}
      </div>
      <div className="dc-status">
        <span>
          {shown.length === events.length ? `${events.length} events` : `${shown.length} of ${events.length} events`}
          {afterSeq ? ' (cleared)' : ''}
        </span>
        {dropped > 0 && <span className="dc-dropped">{dropped} not delivered (too many at once)</span>}
        {watched && <span>{watched.capturing ? 'Capturing' : 'Not capturing'}</span>}
        {recording && (
          <span className={cx('dc-recording', recording.recording && 'on')}>
            {recording.recording ? (
              <>
                <Icon name="record" /> Recording {recording.events} events to {recording.name}
                {recording.includeText ? ' (with text)' : ''}
              </>
            ) : (
              <>
                {recording.reason === 'failed' ? (
                  <span className="dc-recording-failed">
                    <Icon name="error" /> Recording failed after {recording.events} events in {recording.name}: {recording.error ?? 'it could not be written'}
                  </span>
                ) : (
                  <>
                    Saved {recording.events} events to {recording.name}
                    {recording.reason === 'limit' ? ' (it reached its size limit)' : ''}
                  </>
                )}
                {' · '}
                <a className="dc-show-recording" onClick={() => void call('console:showRecording', recording.name).catch((e) => setError(errorMessage(e)))}>
                  Show in folder
                </a>
              </>
            )}
          </span>
        )}
        <span className="dc-sep" />
        <span className={cx('dc-redaction', showText && 'unredacted')}>{showText ? 'Unredacted: text shown; tokens and sign-ins masked' : 'Redacted: no prompt or reply text, commands, tokens or sign-ins'}</span>
      </div>
    </div>
  )
}

/** A payload as a tree; a large node starts collapsed below the top level. */
function Payload({ value }: { value: unknown }) {
  if (value === undefined) return <div className="dc-none">Nothing</div>
  return (
    <div className="dc-tree">
      <Node value={value} depth={0} />
    </div>
  )
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(() => startsOpen(value, depth))
  const label = name !== undefined && <span className="dc-key">{name}: </span>
  if (value === null || typeof value !== 'object') {
    return (
      <div className="dc-leaf">
        {label}
        <span className={cx('dc-val', `dc-${value === null ? 'null' : typeof value}`)}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
      </div>
    )
  }
  const list = Array.isArray(value)
  const entries: [string, unknown][] = list ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>)
  const count = list ? `[${entries.length}]` : `{${entries.length}}`
  return (
    <div className="dc-branch">
      <div className="dc-toggle" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {label}
        <span className="dc-count">{count}</span>
      </div>
      {open && (
        <div className="dc-children">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
