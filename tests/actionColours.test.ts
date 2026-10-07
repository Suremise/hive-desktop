// One colour per session action (#344): each action's tokens exist in both themes, Stop's and Remove's differ, and
// every label meets WCAG AA (4.5:1) on its button: on the tinted wash, resting and hovered, over each surface the
// buttons sit on, and on the solid fill. The amber primary button and the tinted Add Agent too (#360).
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

describe('the rules use those tokens (#360)', () => {
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    return css.slice(start, css.indexOf('}', start))
  }
  it('fills the primary button with --accent-fill and labels the tinted Add Agent like the tinted Resume', () => {
    expect(rule('.btn.primary')).toMatch(/background: var\(--accent-fill\)/)
    expect(rule('.btn.primary:hover:not(:disabled)')).toMatch(/background: var\(--accent-strong\)/)
    expect(rule('.btn.tint-amber')).toMatch(/color: var\(--act-resume-fg\)/)
  })
  it("fills a chosen menu entry and the palette's chosen row with --accent-fill, its other parts taking the label's colour (#362)", () => {
    expect(rule('.menu-item.active:not(.disabled)')).toMatch(/background: var\(--accent-fill\)/)
    expect(rule('.palette-item.active')).toMatch(/background: var\(--accent-fill\)/)
    expect(rule('.menu-item.recent-item:is(:hover, .active) .recent-remove:not(:hover)')).toMatch(/color: inherit/)
    expect(css).toContain('.menu-item:is(:hover, .active):not(.disabled) :is(.menu-detail, .menu-label),')
  })
})

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

  // The primary button (#360): Save, a dialog's default, Add Agent in dialogs. Its label on its fill, resting and hovered.
  it('gives the primary button AA contrast, resting (--accent-fill) and hovered (--accent-strong)', () => {
    for (const fill of ['--accent-fill', '--accent-strong']) expect(contrast(hex('--accent-fg'), hex(fill)), fill).toBeGreaterThanOrEqual(4.5)
  })

  // Only as dark as AA needs: the primary fill keeps the accent's amber hue (#360).
  it("keeps the primary button's amber: the accent's hue", () => {
    expect(Math.abs(hue(hex('--accent-fill')) - hue(hex('--accent')))).toBeLessThan(2)
  })

  // A hovered or keyboard-chosen menu entry and the palette's chosen row (#362): the label (and the icon, shortcut,
  // second line and a greyed entry's label, which take it) on the same fill as the primary button.
  it("gives a chosen menu entry's label AA contrast on its fill", () => {
    expect(contrast(hex('--accent-fg'), hex('--accent-fill'))).toBeGreaterThanOrEqual(4.5)
  })

  // The tinted Add Agent (#360): Resume's tinted label on the accent's wash (12% resting, 22% hovered) on each surface.
  it('gives the tinted Add Agent AA contrast on its wash, resting and hovered, on each surface', () => {
    for (const s of surfaces)
      for (const p of [0.12, 0.22]) expect(contrast(hex('--act-resume-fg'), mix(hex('--accent'), hex(s), p)), `${s} at ${p}`).toBeGreaterThanOrEqual(4.5)
  })
})
