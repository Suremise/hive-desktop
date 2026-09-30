import { useEffect, useRef, useState } from 'react'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { confirm, notify } from '../store'
import { basename } from '../util'
import { CodeEditor } from './Editors'
import { Icon, IconButton, Markdown } from './ui'

/**
 * Loads a file through the main process, edits it in Monaco and saves with Ctrl+S.
 * Markdown files open in preview mode by default.
 */
export function DocEditor({
  path,
  title,
  readOnly,
  createIfMissing,
  toolbarExtra,
  defaultPreview,
  onSaved
}: {
  path: string
  title?: string
  readOnly?: boolean
  createIfMissing?: string
  toolbarExtra?: React.ReactNode
  defaultPreview?: boolean
  onSaved?: () => void
}) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [touched, setTouched] = useState(false)
  const isMd = /\.(md|markdown)$/i.test(path)
  const [preview, setPreview] = useState(defaultPreview ?? isMd)
  const dirty = text !== saved
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty && touched

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void call('file:read', path)
      .then((t) => {
        if (cancelled) return
        const isMissing = t === '' && !!createIfMissing
        setText(isMissing ? createIfMissing! : t)
        setSaved(t)
        setTouched(false)
        setMissing(isMissing)
        if (isMissing) setPreview(false)
      })
      .catch((e) => notify('error', 'Could not open file', errorMessage(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path, createIfMissing])

  const save = async (): Promise<void> => {
    if (readOnly) return
    try {
      await call('file:write', path, text)
      setSaved(text)
      setTouched(false)
      setMissing(false)
      onSaved?.()
    } catch (e) {
      notify('error', 'Could not save', errorMessage(e))
    }
  }

  // Warn before losing edits when the component is replaced by another file.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) notify('warning', `Unsaved changes to ${basename(path)} were discarded`)
    }
  }, [path])

  return (
    <div className="split-main">
      <div className="editor-toolbar">
        <Icon name={isMd ? 'markdown' : 'file'} />
        <span className="path" title={path}>
          <strong>{title ?? basename(path)}</strong>
          {dirty && (missing ? ' (new)' : ' ●')} <span className="faint">{path}</span>
        </span>
        {toolbarExtra}
        {isMd && <IconButton icon={preview ? (readOnly ? 'code' : 'edit') : 'open-preview'} title={preview ? (readOnly ? 'View source' : 'Edit') : 'Preview'} onClick={() => setPreview(!preview)} />}
        <IconButton icon="folder-opened" title="Reveal in File Explorer" onClick={() => void call('app:showInFolder', path)} disabled={missing} />
        {!readOnly && (
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> Save
          </button>
        )}
      </div>
      <div className="editor-host">
        {loading ? null : preview ? (
          <div className="scroll-page">
            {text.trim() ? <Markdown source={text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')} /> : <div className="empty-state">This file is empty.</div>}
          </div>
        ) : (
          <CodeEditor
            value={text}
            language={languageFor(path)}
            onChange={(v) => {
              setText(v)
              setTouched(true)
            }}
            onSave={() => void save()}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  )
}

export async function confirmDiscard(dirty: boolean): Promise<boolean> {
  if (!dirty) return true
  return confirm({ title: 'Discard changes?', message: 'You have unsaved changes.', confirmLabel: 'Discard', danger: true })
}
