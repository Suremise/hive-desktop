// The native window buttons dimmed with a dialog's backdrop: the same black at the same opacity over their colours.
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { BACKDROP_ALPHA, dimColor, titleBarOverlayColors } from '../src/shared/titleBar'

describe('window buttons under a backdrop', () => {
  it("dims a colour as the backdrop does, and leaves what isn't a hex colour", () => {
    expect(dimColor('#1f1f1f')).toBe('#111111')
    expect(dimColor('#f3f3f3')).toBe('#868686')
    expect(dimColor('#ccc')).toBe('#707070')
    expect(dimColor('#FFFFFF', 1, 0.5)).toBe('#808080')
    expect(dimColor('red')).toBe('red')
  })

  it('dims once more for each backdrop, as their layers stack on the page', () => {
    // Light, a question over a card: 243 × 0.55 × 0.55.
    expect(dimColor('#f3f3f3', 2)).toBe('#4a4a4a')
    expect(dimColor('#1f1f1f', 2)).toBe('#090909')
    expect(dimColor('#f3f3f3', 0)).toBe('#f3f3f3')
  })

  it("is the theme's colours with no backdrop, both dimmed for each one up", () => {
    const dark = { color: '#1f1f1f', symbolColor: '#cccccc' }
    expect(titleBarOverlayColors(dark, 0)).toEqual(dark)
    expect(titleBarOverlayColors(dark, 1)).toEqual({ color: '#111111', symbolColor: '#707070' })
    expect(titleBarOverlayColors(dark, 2)).toEqual({ color: '#090909', symbolColor: '#3e3e3e' })
  })

  it("uses the backdrop's own opacity", () => {
    const css = readFileSync(new URL('../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
    const overlay = /\.overlay\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*([\d.]+)\)/.exec(css)
    expect(Number(overlay?.[1])).toBe(BACKDROP_ALPHA)
  })
})
