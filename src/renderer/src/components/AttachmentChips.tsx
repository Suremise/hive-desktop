import { ATTACHMENT_KIND_ICON, attachmentLabel } from '@shared/attachments'
import { msg, tr } from '@shared/i18n'
import { providerDescriptor } from '@shared/providers'
import type { ProviderId } from '@shared/types'
import { clearChips, useAttachedChips } from '../attach'
import { useLanguage } from '../store'
import { cx } from '../util'
import { Icon, Tooltip } from './ui'

/**
 * What was attached to a session's prompt since it was last sent (#387): a chip per file over the terminal's top right,
 * labelled with its kind, and "by path" when the agent's CLI doesn't read that kind itself. Sending the prompt (Enter)
 * clears them; × dismisses one (its path stays in the prompt).
 */
export function AttachmentChips({ ptyKey, provider }: { ptyKey: string; provider?: ProviderId }) {
  const chips = useAttachedChips(ptyKey)
  useLanguage()
  if (!chips.length) return null
  const d = providerDescriptor(provider ?? 'claude-code')
  return (
    <div className="attachment-chips" aria-label={tr(msg({ id: 'sessions.chips.label', defaultMessage: 'Attached to this prompt', description: "The attachment chips' accessible name, over an agent's terminal: files attached to the prompt being written." }))}>
      {chips.map((c) => {
        const l = attachmentLabel(c.kind, d.capabilities.attachments, d.name)
        return (
          <Tooltip key={c.path} content={<span style={{ whiteSpace: 'pre-line' }}>{`${c.path}\n${l.detail}`}</span>}>
            <span className={cx('attachment-chip', !l.native && 'by-path')} data-kind={c.kind}>
              <Icon name={ATTACHMENT_KIND_ICON[c.kind]} />
              <span className="attachment-chip-name">{c.name}</span>
              <span className="attachment-chip-label">{l.label}</span>
              <button className="attachment-chip-close" aria-label={tr(msg({ id: 'sessions.chips.dismiss', defaultMessage: 'Dismiss {file}', description: "An attachment chip's close button (its accessible name): removes the chip ({file}: the file's name); its path stays in the prompt." }), { file: c.name })} onClick={() => clearChips(ptyKey, c.path)}>
                <Icon name="close" />
              </button>
            </span>
          </Tooltip>
        )
      })}
    </div>
  )
}
