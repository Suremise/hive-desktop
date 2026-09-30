import type { McpServerDef } from '../shared/types'

/** Spotting literal secrets in MCP server definitions (they should be ${ENV} references). */

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|authorization)/i
const SECRET_VALUE = /^(sk-[A-Za-z0-9]|ghp_|gho_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|glpat-)/

function isEnvRef(v: string): boolean {
  const t = v.trim()
  return /^\$\{[^}]+\}$/.test(t) || /^\$[A-Z_][A-Z0-9_]*$/.test(t)
}

/** Flags values that look like literal secrets rather than ${ENV} references. */
export function findSecretWarnings(def: McpServerDef): string[] {
  const warnings: string[] = []
  const check = (where: string, key: string, raw: unknown): void => {
    if (typeof raw !== 'string') return
    const value = raw.replace(/^Bearer\s+/i, '').trim()
    if (!value || isEnvRef(value) || value.includes('${')) return
    // A file or folder that holds a secret (e.g. HIVE_API_TOKEN_FILE) isn't one itself.
    if (/_(FILE|PATH|DIR)$/i.test(key)) return
    if (SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && value.length >= 8)) {
      const envName = key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      warnings.push(`${where} "${key}" looks like a literal secret. Use an environment variable reference such as "\${${envName}}".`)
    }
  }
  for (const [k, v] of Object.entries(def.env ?? {})) check('env', k, v)
  for (const [k, v] of Object.entries(def.headers ?? {})) check('header', k, v)
  for (const a of def.args ?? []) {
    if (typeof a === 'string' && SECRET_VALUE.test(a.trim())) warnings.push(`An argument starting "${a.slice(0, 6)}…" looks like a literal secret.`)
  }
  return warnings
}
