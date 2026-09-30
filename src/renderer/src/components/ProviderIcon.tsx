import { providerDescriptor } from '@shared/providers'
import type { ProviderId } from '@shared/types'
import claudeMark from '../assets/providers/claude.svg'
import openaiMark from '../assets/providers/openai.svg'
import { cx } from '../util'
import { Icon } from './ui'

/**
 * Each provider's own mark (its trademark, used to identify it), keyed by the descriptor's icon. A
 * provider without one here shows a neutral terminal icon.
 */
const MARKS: Record<string, string> = {
  claude: claudeMark
}

/** Single-colour marks, drawn in the text colour so they work on dark, light and the status bar. */
const MONO_MARKS: Record<string, string> = {
  codex: openaiMark
}

/**
 * A provider's mark, next to its name or in place of it (with the name as a tooltip by the caller). `mono` draws
 * even a coloured mark in the text colour, for coloured backgrounds such as the status bar.
 */
export function ProviderIcon({ provider, className, mono: monoOnly }: { provider: ProviderId; className?: string; mono?: boolean }) {
  const p = providerDescriptor(provider)
  const mark = monoOnly ? undefined : MARKS[p.icon]
  const mono = MONO_MARKS[p.icon] ?? (monoOnly ? MARKS[p.icon] : undefined)
  return (
    <span className={cx('provider-icon', `provider-${p.icon}`, className)} aria-label={p.name} role="img">
      {mark ? (
        <img src={mark} alt="" draggable={false} />
      ) : mono ? (
        <span className="provider-mono" style={{ maskImage: `url("${mono}")`, WebkitMaskImage: `url("${mono}")` }} />
      ) : (
        <Icon name="terminal" />
      )}
    </span>
  )
}
