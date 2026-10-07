// One colour per session action (#344): each action's tokens exist in both themes, Stop's and Remove's differ, and
// every label meets WCAG AA (4.5:1) on its button: on the tinted wash, resting and hovered, over each surface the
// buttons sit on, and on the solid fill.
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
const ACTIONS = ['stop', 'remove', 'start', 'archive-start', 'resume']

/** A theme block's custom properties, `var()` references resolved within it. */
function theme(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('}', start))
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
  const resolve = (v: string): string => v.replace(/var\((--[\w-]+)\)/g, (_, n: string) => resolve(vars[n] ?? ''))
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, resolve(v)]))
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const lum = (c: number[]): number => {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: number[], b: number[]): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const mix = (c: number[], bg: number[], p: number): number[] => c.map((v, i) => v * p + bg[i] * (1 - p))
const hue = ([r, g, b]: number[]): number => {
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)]
  const d = max - min
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

describe.each([
  ['dark', "[data-theme='dark']", ['--bg', '--bg-sidebar', '--bg-elevated']],
  ['light', "[data-theme='light']", ['--bg', '--bg-sidebar', '--bg-elevated']]
])('%s theme', (_, selector, surfaces) => {
  const t = theme(selector)
  const hex = (name: string): number[] => {
    expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i)
    return rgb(t[name])
  }

  it('has a colour and a label colour for every action', () => {
    for (const a of ACTIONS) for (const name of [`--act-${a}`, `--act-${a}-fg`]) expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('keeps Remove apart from Stop: a clearly different hue', () => {
    const distance = Math.abs(hue(hex('--act-remove')) - hue(hex('--act-stop')))
    expect(Math.min(distance, 360 - distance)).toBeGreaterThan(60)
  })

  it('gives every tinted label AA contrast on its wash, resting (10%) and hovered (18%), on each surface', () => {
    for (const a of ACTIONS)
      for (const s of surfaces)
        for (const p of [0.1, 0.18]) expect(contrast(hex(`--act-${a}-fg`), mix(hex(`--act-${a}`), hex(s), p)), `${a} on ${s} at ${p}`).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps a menu entry readable while hovered or chosen from the keyboard: its label, icon, shortcut and detail on its 18% wash', () => {
    for (const a of ACTIONS) {
      const wash = mix(hex(`--act-${a}`), hex('--bg-elevated'), 0.18)
      for (const fg of ['--fg-strong', `--act-${a}-fg`, '--fg']) expect(contrast(hex(fg), wash), `${a}: ${fg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps a disabled action readable: its muted label on each surface (no wash)', () => {
    for (const s of surfaces) expect(contrast(hex('--fg-muted'), hex(s)), s).toBeGreaterThanOrEqual(4.5)
  })

  // The narrow forms' counts are filled like a solid button, so this covers them too.
  it('gives every solid label (and count) AA contrast on its fill, resting and hovered', () => {
    for (const a of ACTIONS) {
      const on = hex(a === 'resume' ? '--act-resume-on' : '--act-on')
      const shade = hex(a === 'resume' ? '--act-resume-shade' : '--act-shade')
      for (const p of [1, 0.88]) expect(contrast(on, mix(hex(`--act-${a}`), shade, p)), `${a} at ${p}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
