import { useEffect, useRef, useState } from 'react'
import { call, errorMessage } from '../api'
import { clearEditorDraft, editorDraft, onEditorDrafts, setEditorDraft } from '../editorDrafts'
import { languageFor } from '../monacoLang'
import { confirm, notify } from '../store'
import { basename } from '../util'
import { CodeEditor } from './Editors'
import { Icon, IconButton, Markdown } from './ui'

/**
 * Loads a file through the main process, edits it in Monaco and saves with Ctrl+S.
 * Markdown files open in preview mode by default. Unsaved edits are kept (editorDrafts) when the view or
 * file changes, and saving won't overwrite a file changed on disk since it was loaded without asking.
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
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void call('file:read', path)
      .then((t) => {
        if (cancelled) return
        // Edits left unsaved earlier come back, still based on the text they were made to.
        const draft = editorDraft(path)
        const isMissing = t === '' && !!createIfMissing
        setText(draft ? draft.text : isMissing ? createIfMissing! : t)
        setSaved(draft ? draft.base : t)
        setTouched(!!draft)
        setMissing(isMissing)
        if (isMissing || draft) setPreview(false)
      })
      .catch((e) => notify('error', 'Could not open file', errorMessage(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path, createIfMissing, reload])

  // Saved or discarded from elsewhere (Save All before closing the workspace…): show the file as it now is.
  const state = useRef({ touched, dirty })
  state.current = { touched, dirty }
  useEffect(
    () =>
      onEditorDrafts(() => {
        if (state.current.touched && state.current.dirty && !editorDraft(path)) setReload((n) => n + 1)
      }),
    [path]
  )

  const writeFile = async (content: string, base: string): Promise<string> => {
    await call('file:write', path, content, base)
    return content
  }
  // What the edits are based on: a draft's base moves on when Save All saves text it has since changed.
  const baseText = (): string => editorDraft(path)?.base ?? saved

  const save = async (): Promise<void> => {
    if (readOnly) return
    try {
      await writeFile(text, baseText()).catch(async (e) => {
        if (!errorMessage(e).includes('CONFLICT')) throw e
        const overwrite = await confirm({
          title: 'Overwrite the changes on disk?',
          message: `${basename(path)} has changed on disk since you opened it (an agent may have edited it). Save your version over it?`,
          detail: 'Cancel keeps your edits here unsaved, so you can copy them and reopen the file.',
          confirmLabel: 'Overwrite',
          danger: true
        })
        if (!overwrite) throw new Error('CANCELLED')
        await call('file:write', path, text)
      })
      clearEditorDraft(path)
      setSaved(text)
      setTouched(false)
      setMissing(false)
      onSaved?.()
    } catch (e) {
      if (errorMessage(e).includes('CANCELLED')) return
      notify('error', 'Could not save', errorMessage(e))
    }
  }

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
              setEditorDraft({ key: path, label: title ?? basename(path), abs: path, text: v, base: baseText(), save: writeFile })
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
