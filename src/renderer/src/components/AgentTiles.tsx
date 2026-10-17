import { msg, tr } from '@shared/i18n'
import type { ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { Icon } from './ui'

/**
 * The Session tab's Tiles view (#975 switches to it; #976 builds it): a small tile per agent. Until #976 lands on the
 * feature branch it says so and offers Panes. ProjectView shows it in place of the panes while the project's view is
 * Tiles; the toolbar above it (Panes | Tiles, the summary chip, + Add ▾) stays.
 */
export function AgentTiles({ project }: { project: ProjectInfo }) {
  return (
    <div className="agent-tiles empty-state" data-placeholder="">
      <Icon name="layout" />
      {tr(msg({ id: 'panes.tiles.placeholder', defaultMessage: 'Tiles are on their way: a small tile per agent, so a whole team fits on one screen.', description: 'The Session tab in the Tiles view, before the tiles themselves are built: what they will be.' }))}
      <div>
        <button className="btn" onClick={() => void actions.setSessionView(project.path, 'panes')}>
          {tr(msg({ id: 'panes.tiles.backToPanes', defaultMessage: 'Back to Panes', description: "Button in the Tiles view's placeholder: switches the Session tab back to Panes (the agents' terminals)." }))}
        </button>
      </div>
    </div>
  )
}
