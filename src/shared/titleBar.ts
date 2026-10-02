/**
 * The native window buttons (minimise, maximise/restore, close) are painted by Windows over the page, so a dialog's
 * backdrop can't dim them. Instead their colours are dimmed the same way: the backdrop's black at its opacity
 * over the title bar's colour and the buttons' symbols, once for each backdrop up (a question over a card is two,
 * and the page darkens twice).
 */

/** The dialog backdrop's darkness (.overlay in app.css: rgba(0, 0, 0, 0.45)). */
export const BACKDROP_ALPHA = 0.45

/** A colour (#rgb or #rrggbb) as it shows under `layers` backdrops. Anything else is returned as it is. */
export function dimColor(color: string, layers = 1, alpha = BACKDROP_ALPHA): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const dim = (i: number): string =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - alpha) ** Math.max(0, layers))
      .toString(16)
      .padStart(2, '0')
  return `#${dim(0)}${dim(2)}${dim(4)}`
}

/** The window buttons' colours: the theme's, dimmed once for each backdrop up. */
export function titleBarOverlayColors(base: { color: string; symbolColor: string }, backdrops: number): { color: string; symbolColor: string } {
  return backdrops > 0 ? { color: dimColor(base.color, backdrops), symbolColor: dimColor(base.symbolColor, backdrops) } : { ...base }
}
