import type { ProviderId } from '../../shared/types'
import { claudeCode } from './claude/adapter'
import { codex } from './codex/adapter'
import { copilot } from './copilot/adapter'
import type { ProviderAdapter } from './types'

/** Every provider adapter, in display order. Adding a provider: its descriptor in shared/providers.ts and its adapter here. */
const ADAPTERS: ProviderAdapter[] = [claudeCode, codex, copilot]

export function allProviders(): ProviderAdapter[] {
  return ADAPTERS
}

export function hasProvider(id: unknown): id is ProviderId {
  return ADAPTERS.some((a) => a.id === id)
}

/** The adapter for a provider id; throws for an unknown one (e.g. a config written by a newer Hive). */
export function provider(id: ProviderId): ProviderAdapter {
  const a = ADAPTERS.find((x) => x.id === id)
  if (!a) throw new Error(`Unknown provider "${id}". It may need a newer version of Hive.`)
  return a
}
