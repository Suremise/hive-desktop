/**
 * Whether what a terminal sent to its program is the user typing, not xterm answering the program: focus in/out,
 * cursor and device reports (CSI), colour queries (OSC 10/11, which Codex sends at start, ended by BEL or ST) and
 * DCS/APC/PM/SOS replies such as xterm's version.
 */
const REPLIES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1bO?./g

/** What the user typed, without xterm's replies ('' when it was only replies). */
export function typedText(data: string): string {
  return data.replace(REPLIES, '')
}

export function isTyping(data: string): boolean {
  return typedText(data) !== ''
}
