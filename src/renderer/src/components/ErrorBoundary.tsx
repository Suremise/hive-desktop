import { Component, type ErrorInfo, type ReactNode } from 'react'
import { call } from '../api'
import { saveAllDrafts, unsavedFiles } from './FileView'

interface Props {
  children: ReactNode
  /** What failed, for the message ("This tab", "Hive"). */
  label?: string
  /** A new value (e.g. another project or tab) clears the error and tries again. */
  resetKey?: string
  /** The whole window failed: offer a reload instead of trying the view again. */
  root?: boolean
}

/**
 * Catches an error while rendering one view, so a bug there (e.g. an unexpected file in a preview)
 * shows a message in that view instead of blanking the whole window. Sessions keep running.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null; key?: string; saveResult?: string }> {
  state: { error: Error | null; key?: string; saveResult?: string } = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label ?? 'View'} failed`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="empty-state error-boundary" role="alert">
        <span className="codicon codicon-warning" />
        <strong>{this.props.label ?? 'This view'} ran into a problem and couldn't be shown.</strong>
        <code className="error-boundary-message">{error.message || String(error)}</code>
        <span className="faint">Running sessions are not affected.</span>
        {this.state.saveResult && <span>{this.state.saveResult}</span>}
        <div className="flex" style={{ gap: 8, justifyContent: 'center' }}>
          {this.props.root ? (
            <>
              {unsavedFiles().length > 0 && (
                <button
                  className="btn"
                  onClick={() =>
                    void saveAllDrafts().then((r) => {
                      this.setState({ saveResult: r.failed.length ? `Couldn't save: ${r.failed.map((f) => f.message).join('; ')}` : `Saved ${r.saved} file${r.saved === 1 ? '' : 's'}.` })
                    })
                  }
                >
                  Save {unsavedFiles().length} Unsaved File{unsavedFiles().length === 1 ? '' : 's'}
                </button>
              )}
              <button className="btn primary" onClick={() => location.reload()}>
                Reload Window
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              Try Again
            </button>
          )}
          <button className="btn subtle" onClick={() => void call('app:openLogs')}>
            Open Logs
          </button>
        </div>
      </div>
    )
  }
}
