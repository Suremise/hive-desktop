import { useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { GITIGNORE_CHOICES, initAbout, initProblem, type GitInitCheck, type GitignoreChoice } from '@shared/gitInit'
import { call, errorMessage } from '../api'
import { bumpGit, notify, set, useStore } from '../store'
import { BusyButton, Icon, Modal, useBusy } from './ui'

/**
 * Initialise repository (#701): the button on the Git tab of a project that isn't a git repository (or is inside
 * another one, or has no commit yet), and its dialog: a starter .gitignore, the commit identity when git has none, and
 * the nested repository's confirmation. Main does the work (`git:init`) and says what it did. The dialog is the Git
 * tab's (`gitInitFor`, `InitRepoHost`), not the button's: it stays open while the tab changes under it (a repository
 * made, then a first commit still to make).
 */
export function InitRepoButton({ project, label = 'Initialise repository…', small }: { project: ProjectInfo; label?: string; small?: boolean }) {
  return (
    <button className={small ? 'btn small' : 'btn primary'} data-git-init="" onClick={() => set({ gitInitFor: project.path })}>
      <Icon name="repo" /> {label}
    </button>
  )
}

/** The project's Initialise dialog while it is open: in the Git tab, which stays as the page under it changes. */
export function InitRepoHost({ project }: { project: ProjectInfo }) {
  const open = useStore((s) => s.gitInitFor === project.path)
  return open ? <InitRepoDialog project={project} onClose={() => set({ gitInitFor: null })} /> : null
}

function InitRepoDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const [check, setCheck] = useState<GitInitCheck | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gitignore, setGitignore] = useState<GitignoreChoice>('minimal')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [nested, setNested] = useState(false)
  const { busy, error, run } = useBusy()
  useEffect(() => {
    let live = true
    call('git:initCheck', project.path).then(
      (c) => live && setCheck(c),
      (e) => live && setLoadError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [project.path])
  const problem = check && !check.refused ? initProblem(check, { name, email }) : null
  const blocked = !check || !!check.refused || !!problem || (!!check.parentRepo && !nested)
  const submit = async (): Promise<void> => {
    if (blocked || !check) return
    const r = await run('init', () => call('git:init', project.path, { gitignore: check.hasGitignore ? 'none' : gitignore, ...(check.identity.name ? {} : { name: name.trim() }), ...(check.identity.email ? {} : { email: email.trim() }), ...(check.parentRepo ? { nested: true } : {}) }))
    bumpGit(project.path)
    if (!r) {
      // It may have stopped part way (a repository made, no commit yet): asked again, the dialog goes on from there,
      // with the identity the new repository lacks, its failure still shown.
      await call('git:initCheck', project.path).then(setCheck, () => undefined)
      return
    }
    notify('success', r.value)
    onClose()
  }
  const asks = check && !check.refused
  return (
    <Modal
      title={check?.resume ? `Make the first commit in ${project.name}` : `Initialise ${project.name} as a git repository`}
      icon="repo"
      onClose={onClose}
      busy={!!busy}
      error={error ?? loadError}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {asks ? 'Cancel' : 'Close'}
          </button>
          {asks && (
            <BusyButton className="primary" busy={!!busy} busyLabel={check.resume ? 'Committing…' : 'Initialising…'} disabled={blocked} onClick={() => void submit()}>
              {check.resume ? 'Make first commit' : 'Initialise'}
            </BusyButton>
          )}
        </>
      }
    >
      {!check ? (
        !loadError && (
          <p className="hint">
            <Icon name="loading" spin /> Looking at the folder…
          </p>
        )
      ) : check.refused ? (
        <div className="banner warn" data-git-init-refused="">
          <Icon name="warning" /> {check.refused}
        </div>
      ) : (
        <div data-git-init-form="">
          <p className="hint">{initAbout(project.name, check)}</p>
          {check.parentRepo && (
            <div className="banner warn" data-git-init-nested="">
              <label className="flex">
                <input type="checkbox" className="checkbox" checked={nested} onChange={(e) => setNested(e.target.checked)} /> Make a repository of its own inside {check.parentRepo} anyway
              </label>
            </div>
          )}
          <div className="agent-form git-form">
            {!check.hasGitignore && (
              <>
                <label htmlFor="git-init-gitignore">Starter .gitignore</label>
                <select id="git-init-gitignore" className="select" value={gitignore} onChange={(e) => setGitignore(e.target.value as GitignoreChoice)}>
                  {GITIGNORE_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            {!check.identity.name && (
              <>
                <label htmlFor="git-init-name">Your name</label>
                <input id="git-init-name" className="input" value={name} placeholder="Your Name" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
              </>
            )}
            {!check.identity.email && (
              <>
                <label htmlFor="git-init-email">Your email</label>
                <input id="git-init-email" className="input" value={email} placeholder="id+you@users.noreply.github.com" autoFocus={!!check.identity.name} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
              </>
            )}
          </div>
          {!check.identity.name || !check.identity.email ? (
            <p className="hint">
              {check.conditionalIdentity
                ? `Your git config has conditional includes (includeIf), which may set the ${!check.identity.name && !check.identity.email ? 'name and email' : !check.identity.name ? 'name' : 'email'} for this repository. Hive uses what you enter only where they don't, and saves it to this repository's config only, never your global one.`
                : `Git has no ${!check.identity.name && !check.identity.email ? 'name or email' : !check.identity.name ? 'name' : 'email'} to commit as: Hive saves what you enter to this repository's config only, never your global one.`}{' '}
              On GitHub, its no-reply address keeps your email private.
            </p>
          ) : (
            <p className="hint faint">
              Commits as {check.identity.name} &lt;{check.identity.email}&gt;.
            </p>
          )}
          {problem && (name.trim() || email.trim()) && <div className="field-error">{problem}</div>}
        </div>
      )}
    </Modal>
  )
}
