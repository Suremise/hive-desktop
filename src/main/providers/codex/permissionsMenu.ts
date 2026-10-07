import type { PermissionMode } from '../../../shared/types'

/**
 * Codex's /permissions menu (#396): each preset on a numbered line, by the label Codex draws for it. Codex 0.160 listed
 * Read Only, Ask for approval, Approve for me, Full Access; 0.161 lists Ask for approval, Approve for me, Full Access,
 * Read Only, whichever is current. So Hive picks a preset by its label on the screen, never by where it used to be:
 *
 *   › 1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for …
 *     2. Approve for me              Only ask for actions detected as potentially unsafe
 */
export const PERMISSIONS_MENU_LABELS: Record<PermissionMode, string> = {
  'read-only': 'Read Only',
  ask: 'Ask for approval',
  'approve-for-me': 'Approve for me',
  'full-access': 'Full Access'
}

/** A menu line: its number and label, after the selection marker, before "(current)" and the description. */
const LINE = /^\s*(?:›\s*)?(\d+)\.\s+(.*?)(?:\s\(current\))?(?:\s{2,}.*)?$/

/**
 * The number to type for `target` in the /permissions menu on this screen (the rendered terminal, a line per row), or
 * null while no menu line shows its label. The lowest such line wins: the menu is drawn at the bottom.
 */
export function permissionsMenuNumber(screen: string, target: PermissionMode): string | null {
  const want = PERMISSIONS_MENU_LABELS[target]?.toLowerCase()
  if (!want) return null
  let found: string | null = null
  for (const line of screen.split('\n')) {
    const m = LINE.exec(line.trimEnd())
    if (m && m[2].trim().toLowerCase() === want) found = m[1]
  }
  return found
}
