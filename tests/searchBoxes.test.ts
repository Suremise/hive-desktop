// Every search and filter box has a × that clears it (#433): they are SearchInput, never a plain <input> named or
// labelled for searching, filtering or finding. A new box that isn't fails here.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.tsx') ? [join(dir, d.name)] : []))

describe('search and filter boxes (#433)', () => {
  it('are all SearchInput (with its × and Escape), none a plain <input>', () => {
    const plain: string[] = []
    for (const f of files(RENDERER)) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/<input\b[\s\S]*?\/>/g)) {
        const tag = m[0]
        if (/type="(checkbox|radio|file|color|range)"/.test(tag)) continue
        const named = [...tag.matchAll(/(?:placeholder|aria-label)=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)].map((x) => x[1] ?? x[2] ?? x[3]).join(' ')
        if (/\b(search|filter|find)/i.test(named)) plain.push(`${f.slice(RENDERER.length + 1)}: ${named}`)
      }
    }
    expect(plain).toEqual([])
  })

  it('the boxes found when it was written use it', () => {
    const uses = files(RENDERER)
      .map((f) => [f.slice(RENDERER.length + 1).replace(/\\/g, '/'), (readFileSync(f, 'utf8').match(/<SearchInput\b/g) ?? []).length] as const)
      .filter(([, n]) => n > 0)
    expect(Object.fromEntries(uses)).toMatchObject({
      'components/Board.tsx': 1,
      'components/DataTable.tsx': 1,
      'components/Keybindings.tsx': 1,
      'components/Overlays.tsx': 1,
      'components/Sidebar.tsx': 2,
      'components/Tips.tsx': 1,
      'views/FilesTab.tsx': 1,
      'views/ProjectTabs.tsx': 1,
      'views/SessionsTab.tsx': 1,
      'views/SettingsView.tsx': 1
    })
  })
})
