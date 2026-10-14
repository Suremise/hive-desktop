// Typed values (#768): each message's placeholders and their types, generated per area from the English catalogue
// (locales/en/<area>.json) into src/shared/i18n/values/<area>.d.ts, so `tr(m, values)` checks the names and the types
// under TypeScript (shared/i18n/msg.ts, HiveMessageValues). `npm run i18n:extract` writes them with the catalogues, and
// tests/i18nCatalogues.test.ts fails when one is out of date.
import { parse, TYPE } from '@formatjs/icu-messageformat-parser'

/** What a placeholder takes, by how the message uses it. Tags are tRich()'s, which isn't typed: they're left out. */
const typeOf = (el) => (el.type === TYPE.plural || el.type === TYPE.number ? 'number' : el.type === TYPE.date || el.type === TYPE.time ? 'Date | number' : el.type === TYPE.select ? 'string' : 'string | number')

/** A message's placeholders and their types, in the order they first appear. The most specific use wins: `{n}` and `{n, plural, …}` take a number. */
export function placeholderTypes(message) {
  const out = new Map()
  const walk = (els) => {
    for (const el of els) {
      if (el.type === TYPE.literal || el.type === TYPE.pound) continue
      if (el.type === TYPE.tag) {
        walk(el.children)
        continue
      }
      const prev = out.get(el.value)
      out.set(el.value, prev && prev !== 'string | number' ? prev : typeOf(el))
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
    }
  }
  walk(parse(message))
  return out
}

/** The .d.ts of an area's catalogue (id → { defaultMessage, description }), with \n endings. */
export function valuesDts(area, catalogue) {
  const lines = [
    `// Generated from locales/en/${area}.json: do not edit. Each message's placeholders and their types, for tr(): a`,
    "// global script, so its interface merges with every other area's (shared/i18n/msg.ts).",
    'interface HiveMessageValues {'
  ]
  for (const [id, m] of Object.entries(catalogue)) {
    const args = [...placeholderTypes(m.defaultMessage)]
    lines.push(`  '${id.replace(/[\\']/g, '\\$&')}': ${args.length ? `{ ${args.map(([k, t]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${t}`).join('; ')} }` : 'undefined'}`)
  }
  lines.push('}', '')
  return lines.join('\n')
}
