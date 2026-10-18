import { readStore, saveStore, type StoreName } from '../src/main/storeRows'

/** A store's entries as the workspace database keeps them (#1018), in order: what its file held before. */
export const storeDocs = <T = Record<string, unknown>>(workspacePath: string, store: StoreName, scope = ''): T[] => readStore(workspacePath, store, scope).rows.map((r) => JSON.parse(r.doc) as T)

/** A store's value kept beside its entries (e.g. watches' and deliveries' `invalid`), parsed; undefined when there is none. */
export const storeMeta = <T = unknown>(workspacePath: string, store: StoreName, key: string, scope = ''): T | undefined => {
  const v = readStore(workspacePath, store, scope).meta.get(key)
  return v === undefined ? undefined : (JSON.parse(v) as T)
}

/**
 * Saves a store's entries as Hive would have (a test's stand-in for writing its file by hand before #1018): `key` gives
 * each entry's row key (its id by default), `meta` its values (JSON-encoded here; null removes one).
 */
export async function putStoreDocs(workspacePath: string, store: StoreName, docs: unknown[], o: { scope?: string; meta?: Record<string, unknown>; key?: (doc: unknown, i: number) => string } = {}): Promise<void> {
  const key = o.key ?? ((d: unknown, i: number) => (d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? (d as { id: string }).id : `row-${i}`))
  const meta: Record<string, string | null> = { imported: JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }) }
  for (const [k, v] of Object.entries(o.meta ?? {})) meta[k] = v === null ? null : JSON.stringify(v)
  await saveStore(workspacePath, store, o.scope ?? '', docs.map((d, i) => ({ key: key(d, i), doc: JSON.stringify(d) })), meta)
}
