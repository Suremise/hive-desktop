import { useEffect, useState } from 'react'
import { parseDocRef } from '@shared/docRefs'
import type { HiveRequests } from '@shared/api'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { openFileLink } from '../fileLinks'
import { get, set, showView, useLanguage } from '../store'
import { Markdown, Modal } from './ui'

type Section = Awaited<ReturnType<HiveRequests['docs:section']>>

const M = {
  open: msg({ id: 'board.context.open', defaultMessage: 'Open in Files', description: "Button in the doc section viewer (a card's Read first reference, #818): opens the project's file in the Files tab, at the section." }),
  openNote: msg({ id: 'board.context.openNote', defaultMessage: 'Open in Shared Notes', description: "Button in the doc section viewer (a card's Read first reference to a shared note, #818): opens the note in the Shared Notes view." }),
  close: msg({ id: 'board.context.close', defaultMessage: 'Close', description: 'Button: closes the doc section viewer.' }),
  loading: msg({ id: 'board.context.loading', defaultMessage: 'Reading…', description: 'The doc section viewer while it reads the section.' }),
  problem: msg({
    id: 'board.context.problem',
    defaultMessage: "{why, select, noHeading {That heading isn't in the file} notFound {The file isn't there} notMarkdown {It isn't a Markdown file} invalid {It isn't a doc section (a Markdown file, optionally with # and a heading's slug)} tooBig {The file is too big to read} other {It can't be read here}}.{closest, select, none {} other { Closest headings: {closest}.}}",
    description: "The doc section viewer when a card's Read first reference doesn't lead to a section (#818): why ({why}, select: translate each) and, when its heading isn't there, the closest headings' slugs ({closest}; none: leave that branch empty)."
  })
}

/**
 * A card's Read first reference (#818), read: the section (the whole document when it names no heading) in Hive's
 * Markdown, with a button to open its file in the Files tab at the heading, or a shared note in Shared Notes.
 */
export function DocRefViewer({ projectPath, docRef, onClose, onOpen }: { projectPath: string | null; docRef: string; onClose: () => void; onOpen?: (go: () => void) => void }) {
  useLanguage()
  const [section, setSection] = useState<Section | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    call('docs:section', projectPath, docRef).then(
      (s) => live && setSection(s),
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [projectPath, docRef])
  const parsed = parseDocRef(docRef)
  const shared = !!parsed?.path.startsWith('shared:')
  const line = section && 'line' in section ? section.line : undefined
  const go = (): void => {
    if (!parsed) return
    if (shared) {
      const ws = get().workspace?.path
      if (!ws) return
      showView('notes')
      set({ selectedNote: [ws, '.hive', 'shared', ...parsed.path.slice('shared:'.length).split('/')].join('\\') })
    } else if (projectPath) openFileLink({ project: projectPath, agentId: null, root: projectPath, rel: parsed.path }, line)
  }
  // The viewer closes, then whatever it opens over (the card dialog) closes the way it does, asking about unsaved edits:
  // only then is the file or note shown, so nothing is left covering it.
  const open = (): void => {
    onClose()
    if (onOpen) onOpen(go)
    else go()
  }
  return (
    <Modal
      title={docRef}
      icon="book"
      wide
      onClose={onClose}
      error={error}
      footer={
        <>
          {parsed && (shared || projectPath) && (
            <button className="btn" onClick={open}>
              {tr(shared ? M.openNote : M.open)}
            </button>
          )}
          <button className="btn solid" onClick={onClose}>
            {tr(M.close)}
          </button>
        </>
      }
    >
      {!section && !error && <p className="faint">{tr(M.loading)}</p>}
      {section && 'content' in section && <Markdown className="doc-ref-section" source={section.content} />}
      {section && 'problem' in section && <p className="banner warn">{tr(M.problem, { why: section.problem, closest: section.closest?.length ? fmt.list(section.closest.map((s) => `#${s}`)) : 'none' })}</p>}
    </Modal>
  )
}
