import { useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { call } from '../api'
import { useNow } from '../usage'
import { set, setAssistantOpen, useStore } from '../store'
import { cx, formatNumber, formatTokens } from '../util'
import { SessionsTab } from '../views/SessionsTab'
import { PERIODS, money, periodFrom, sumUsage, useSessions, type Period } from '../views/ProjectTabs'
import { PERSONAS_TIP, PersonaList, PersonaView, createPersona } from './Personas'
import { Section } from './Sidebar'
import { Icon, IconButton, InfoTip, Tooltip } from './ui'

/**
 * The Hive Assistant's view (activity bar): a summary of what it has used, its conversations (the same browser
 * as a project's Sessions tab) and its personas. Its settings are in Settings → Assistant and its panel.
 */

const SUMMARY_TIP =
  "What this workspace's Assistant has used across its conversations, in the period chosen (by calendar day: Today is since midnight). It isn't counted in any project's Overview. The cost is what the work would have cost at API prices: on a subscription you are not charged this."

export function AssistantSidePanel() {
  const workspace = useStore((s) => s.workspace)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const section = useStore((s) => s.assistantSection)
  return (
    <>
      <div className="pane-header">
        Hive Assistant
        <InfoTip text="Your workspace's overseer: what it has used, its conversations and its personas. Its panel is on the right (Ctrl+Alt+I); its defaults are in Settings → Assistant." />
        <div className="actions">
          <IconButton icon="layout-sidebar-right" title="Show the Assistant's panel" disabled={!a} onClick={() => setAssistantOpen(true)} />
        </div>
      </div>
      <div className="pane-body">
        {!workspace || !a ? (
          <div className="pane-empty">Open a workspace to see its Assistant.</div>
        ) : (
          <>
            <AssistantSummary assistant={a} />
            <Section title="Conversations">
              <div className={cx('row', section === 'conversations' && 'selected')} onClick={() => set({ assistantSection: 'conversations' })}>
                <Icon name="comment-discussion" />
                <span className="label">All Conversations</span>
              </div>
            </Section>
            <Section
              title="Personas"
              tip={PERSONAS_TIP}
              buttons={
                <>
                  <IconButton icon="add" title="New Persona…" onClick={() => void createPersona()} />
                  <IconButton icon="refresh" title="Refresh" onClick={() => set((s) => ({ personasVersion: s.personasVersion + 1 }))} />
                  <IconButton icon="folder-opened" title="Open Personas Folder" onClick={() => void call('app:openPath', `${workspace.path}\\.hive\\personas`)} />
                </>
              }
            >
              <PersonaList />
            </Section>
          </>
        )}
      </div>
    </>
  )
}

/** Tokens, cost and conversations of the Assistant, for a period (by calendar day) or all time. */
function AssistantSummary({ assistant }: { assistant: ProjectInfo }) {
  const { items } = useSessions(assistant)
  const [period, setPeriod] = useState<Period>('all')
  const now = useNow(60000)
  const hive = (items ?? []).filter((i) => i.source === 'hive')
  const t = sumUsage(hive, periodFrom(period, now))
  const tokens = t.input + t.cached + t.cacheWrite + t.output
  return (
    <div className="assistant-summary">
      <div className="assistant-summary-title">
        Used so far
        <InfoTip text={SUMMARY_TIP} />
      </div>
      <div className="segmented assistant-periods" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => setPeriod(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="assistant-summary-grid">
        <Stat label="Conversations" value={items ? String(t.sessions) : '…'} />
        <Stat label="Prompts" value={items ? formatNumber(t.prompts) : '…'} />
        <Stat label="Tokens" value={items ? formatTokens(tokens) : '…'} />
        <Stat label="Cost" value={items ? `${t.estimated ? '≈ ' : ''}${money(t.cost)}` : '…'} tip={t.unpriced ? `${t.unpriced} conversation${t.unpriced === 1 ? '' : 's'} without a price` : undefined} />
      </div>
    </div>
  )
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  const body = (
    <div className="assistant-stat">
      <span className="faint">{label}</span>
      <strong>{value}</strong>
    </div>
  )
  return tip ? <Tooltip content={tip}>{body}</Tooltip> : body
}

/** The main area: the conversation browser, or the selected persona. */
export function AssistantMain() {
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const section = useStore((s) => s.assistantSection)
  if (section === 'personas') return <PersonaView />
  if (!a) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="comment-discussion" />
        Open a workspace to see its Assistant's conversations.
      </div>
    )
  }
  return <SessionsTab project={a} assistant />
}
