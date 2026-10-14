import { msg, type MessageArgs, type Msg } from './i18n/msg'
import type { StoredText } from './types'

/**
 * What Hive writes in a card's history (#846, E10b of #677), as messages: main stores each entry's English in `what`
 * (agents read it, Hive's own code matches it, scenarios too) and its message's id and values in `whatText`, and the
 * card dialog shows that in the window's language. Imports only msg.ts: hive-mcp reaches shared/tasks, and this stays
 * out of its way. A column (`{column}`) or a reason (`{why}`) is stored as its key and the message chooses its words;
 * other values are names, numbers and the user's own words, the same in every language.
 */
export const HISTORY = {
  created: msg({ id: 'tasks.history.created', defaultMessage: 'Created in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: the card was added, in this column. {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  moved: msg({ id: 'tasks.history.moved', defaultMessage: 'Moved to {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: the card was moved to this column. {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  movedTop: msg({ id: 'tasks.history.movedTop', defaultMessage: 'Moved to the top of {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: the card was put first in this column. {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  movedBottom: msg({ id: 'tasks.history.movedBottom', defaultMessage: 'Moved to the bottom of {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: the card was put last in this column. {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  movedBefore: msg({ id: 'tasks.history.movedBefore', defaultMessage: 'Moved to {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}, before #{before}', description: "A line in a card's history: the card was moved to this column, just above card #{before} (a number). {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  movedBeforeIn: msg({ id: 'tasks.history.movedBeforeIn', defaultMessage: 'Moved before #{before} in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: within its column, the card was moved just above card #{before} (a number). {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  placed: msg({ id: 'tasks.history.placed', defaultMessage: 'Placed {place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A line in a card's history: an agent put the column's cards in order, and this card is now at place {place} (an ordinal: 2nd, 3rd). {column} is a board column (select: On Hold, Todo, Doing, Review, Passed, Done): translate each." }),
  returned: msg({ id: 'tasks.history.returned', defaultMessage: 'Returned for review, round {round}', description: "A line in a card's history: after a failed review, the card was sent back for its next review; {round} is the round's number." }),
  renamed: msg({ id: 'tasks.history.renamed', defaultMessage: 'Renamed to "{title}"', description: "A line in a card's history: the card's title was changed to {title}." }),
  description: msg({ id: 'tasks.history.description', defaultMessage: 'Changed the description', description: "A line in a card's history: the card's description was edited." }),
  toProject: msg({ id: 'tasks.history.toProject', defaultMessage: 'Moved to {project}', description: "A line in a card's history: the card now belongs to another project ({project}, its folder name)." }),
  toWorkspace: msg({ id: 'tasks.history.toWorkspace', defaultMessage: 'Moved to the workspace', description: "A line in a card's history: the card no longer belongs to a project, only to the workspace." }),
  takenFromOf: msg({ id: 'tasks.history.takenFromOf', defaultMessage: 'Taken from {agent} of {project}', description: "A line in a card's history: the card was moved to another project, so it no longer belongs to {agent} (an agent's name) of its old project {project}." }),
  takenFromOfWorkspace: msg({ id: 'tasks.history.takenFromOfWorkspace', defaultMessage: 'Taken from {agent} of the workspace', description: "A line in a card's history: the card was moved to a project, so it no longer belongs to {agent} (an agent's name) of the workspace." }),
  given: msg({ id: 'tasks.history.given', defaultMessage: 'Given to {agent}', description: "A line in a card's history: the card was given to the agent {agent} (its name) to work on." }),
  takenFrom: msg({ id: 'tasks.history.takenFrom', defaultMessage: 'Taken from {agent}', description: "A line in a card's history: the card no longer belongs to the agent {agent} (its name)." }),
  takenFromAgent: msg({ id: 'tasks.history.takenFromAgent', defaultMessage: 'Taken from its agent', description: "A line in a card's history: the card no longer belongs to the agent it had (whose name isn't known)." }),
  reviewStarted: msg({ id: 'tasks.history.reviewStarted', defaultMessage: 'Started reviewing', description: "A line in a card's history: an agent (named beside it) began reviewing the card." }),
  reviewPassed: msg({ id: 'tasks.history.reviewPassed', defaultMessage: 'Review passed', description: "A line in a card's history: the reviewer (named beside it) passed the card's review." }),
  reviewFailed: msg({ id: 'tasks.history.reviewFailed', defaultMessage: 'Review failed', description: "A line in a card's history: the reviewer (named beside it) failed the card's review: it needs more work." }),
  reviewStopped: msg({ id: 'tasks.history.reviewStopped', defaultMessage: 'Review by {agent} stopped', description: "A line in a card's history: the review the agent {agent} (its name) had going on the card ended without a verdict (the card moved on)." }),
  reviewEnded: msg({ id: 'tasks.history.reviewEnded', defaultMessage: 'Review by {agent} stopped: {why, select, sessionEnded {its session ended} agentRemoved {the agent was removed} other {{why}}}', description: "A line in a card's history: the review the agent {agent} (its name) had going on the card ended, because its session ended or it was removed from the project ({why}, select: translate each)." }),
  decision: msg({ id: 'tasks.history.decision', defaultMessage: 'Recorded a decision: "{decision}"', description: "A line in a card's history: a decision the user made was written on the card; {decision} is its text (cut short)." }),
  decisionRemoved: msg({ id: 'tasks.history.decisionRemoved', defaultMessage: 'Removed a decision: "{decision}"', description: "A line in a card's history: the user removed one of the card's decisions; {decision} is its text (cut short)." }),
  decisionChanged: msg({ id: 'tasks.history.decisionChanged', defaultMessage: 'Changed a decision to "{decision}" (was "{was}")', description: "A line in a card's history: the user changed the words of one of the card's decisions; {decision} is the new text and {was} the old (each cut short)." }),
  labels: msg({ id: 'tasks.history.labels', defaultMessage: 'Labels: {labels}', description: "A line in a card's history: the card's labels were set to these ({labels}: the user's labels, separated by commas)." }),
  labelsRemoved: msg({ id: 'tasks.history.labelsRemoved', defaultMessage: 'Removed the labels', description: "A line in a card's history: the card's labels were all removed." }),
  blocked: msg({ id: 'tasks.history.blocked', defaultMessage: 'Blocked: {reason}', description: "A line in a card's history: the card was marked blocked, with this reason ({reason}, written by whoever blocked it)." }),
  unblocked: msg({ id: 'tasks.history.unblocked', defaultMessage: 'No longer blocked', description: "A line in a card's history: the card's blocked reason was cleared." }),
  dependsOn: msg({ id: 'tasks.history.dependsOn', defaultMessage: 'Depends on {cards}', description: "A line in a card's history: the cards that have to be done first were set to these ({cards}: card numbers such as \"#3, #4\")." }),
  noDependencies: msg({ id: 'tasks.history.noDependencies', defaultMessage: 'No longer depends on other cards', description: "A line in a card's history: the list of cards that had to be done first was cleared." }),
  linked: msg({ id: 'tasks.history.linked', defaultMessage: 'Linked to {cards}', description: "A line in a card's history: the card's related cards were set to these ({cards}: card numbers such as \"#3, #4\")." }),
  linksRemoved: msg({ id: 'tasks.history.linksRemoved', defaultMessage: 'Removed the links', description: "A line in a card's history: the card's links to related cards were all removed." }),
  archived: msg({ id: 'tasks.history.archived', defaultMessage: 'Archived', description: "A line in a card's history: the user archived the card (hidden from the board, kept)." }),
  unarchived: msg({ id: 'tasks.history.unarchived', defaultMessage: 'Brought back from the archive', description: "A line in a card's history: the user brought the card back onto the board from the archive." }),
  archivedInBatch: msg({ id: 'tasks.history.archivedInBatch', defaultMessage: 'Archived in a batch of {n} ({label})', description: "A line in a card's history: the user archived {n} cards at once (Archive All), this one among them; {label} is the batch's name (\"All in Done\")." }),
  backWithBatch: msg({ id: 'tasks.history.backWithBatch', defaultMessage: 'Brought back with its batch ({label})', description: "A line in a card's history: the user undid an Archive All, which brought this card back; {label} is the batch's name (\"All in Done\")." }),
  archivedDone: msg({ id: 'tasks.history.archivedDone', defaultMessage: 'Archived after {days, plural, one {# day} other {# days}} in Done', description: "A line in a card's history: Hive archived the card on its own, because it had been in the Done column for {days} days (Settings → Board)." }),
  archivedHidden: msg({ id: 'tasks.history.archivedHidden', defaultMessage: 'Archived: {project} was hidden', description: "A line in a card's history: the card was archived because the user hid its project {project} (its folder name) from Hive." }),
  archivedRemoved: msg({ id: 'tasks.history.archivedRemoved', defaultMessage: 'Archived: {project} was removed from Hive', description: "A line in a card's history: the card was archived because the user removed its project {project} (its folder name) from Hive." }),
  restored: msg({ id: 'tasks.history.restored', defaultMessage: 'Brought back: {project} was restored', description: "A line in a card's history: the card came back onto the board because the user restored its project {project} (its folder name)." }),
  imported: msg({ id: 'tasks.history.imported', defaultMessage: 'Brought back with {project} (it was #{was})', description: "A line in a card's history: the card came back with its removed project {project} (its folder name), under a new number; {was} was its number before." }),
  repaired: msg({ id: 'tasks.history.repaired', defaultMessage: 'Project: {from} → {to} (renamed or moved)', description: "A line in a card's history, by Repair: the card was given to the project {to}, the new name of its project {from} (folder names), which was renamed or moved." })
}

/**
 * Who wrote a history line or a comment as Hive stores it (in English: agents read it), in the window's language: the
 * user, the Assistant, Repair; Hive and an agent's name stay as they are.
 */
export const BY_TEXT: Record<string, Msg> = {
  You: msg({ id: 'tasks.by.you', defaultMessage: 'You', description: "Who made a change or wrote a comment on a card (beside a history line or a comment): the user. Short." }),
  Assistant: msg({ id: 'tasks.by.assistant', defaultMessage: 'Assistant', description: "Who made a change or wrote a comment on a card (beside a history line or a comment): the Hive Assistant. Short." }),
  Repair: msg({ id: 'tasks.by.repair', defaultMessage: 'Repair', description: "Who made a change on a card (beside a history line): Hive's Repair, which gave cards of a renamed or moved project back to it. Short." })
}

const BY_ID = new Map<string, Msg>(Object.values(HISTORY).map((m) => [m.id, m]))

/** The message a stored line names, by its id: null for an id this Hive doesn't know (a record from a newer one). */
export const storedMessage = (s: StoredText | undefined): Msg | null => (s ? (BY_ID.get(s.id) ?? null) : null)

/** A message and its values as they are kept in a card's file: its id and values, never its English. */
export function storedText<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): StoredText {
  const v = values[0] as Record<string, string | number> | undefined
  return v ? { id: m.id, values: v } : { id: m.id }
}
