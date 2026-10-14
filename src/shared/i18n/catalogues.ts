/// <reference types="vite/client" />
/**
 * The translations (#767): `locales/<code>/<area>.json`, id → ICU message, a file per area of the app. The loader finds
 * the files itself: adding a language is its folder and a line in LANGUAGES (languages.ts). The main process loads the
 * chosen language once and gives it to each window (app:info, language-changed), so only main imports this module
 * (each file is its own chunk there, read when its language is chosen). English needs none: its text is the messages'
 * own, and `locales/en/` holds the extracted source catalogue for translators, with a note per message.
 */
import type { Catalogue } from './index'

const FILES = import.meta.glob<{ default: unknown }>(['../../../locales/*/*.json', '!../../../locales/en/*.json'])

/** Each file's language: the folder it is in. */
const languageOfFile = (path: string): string => path.split('/').at(-2) ?? ''

/** The languages that have translations (a folder with a file in it), English aside. */
export const availableLanguages = (): string[] => [...new Set(Object.keys(FILES).map(languageOfFile))].sort()

/**
 * A language's translations, every area merged; {} for English, the pseudo-locale or a language with none. A value
 * that isn't text is left out (FormatJS then shows the English) and reported.
 */
export async function loadCatalogue(code: string, report: (text: string) => void = () => undefined): Promise<Catalogue> {
  const out: Catalogue = {}
  const files = Object.entries(FILES).filter(([path]) => languageOfFile(path) === code)
  for (const [path, load] of files.sort(([a], [b]) => a.localeCompare(b))) {
    const data = (await load()).default
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      report(`i18n (${code}): ${path.split('/').at(-1)} is not an object of messages`)
      continue
    }
    for (const [id, text] of Object.entries(data)) {
      if (typeof text === 'string') out[id] = text
      else report(`i18n (${code}): ${id} in ${path.split('/').at(-1)} is not text`)
    }
  }
  return out
}
