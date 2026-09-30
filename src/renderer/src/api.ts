import type { HiveChannel, HiveRequests } from '@shared/api'

/** Calls the main process and unwraps Electron's "Error invoking remote method" prefix from errors. */
export async function call<C extends HiveChannel>(channel: C, ...args: Parameters<HiveRequests[C]>): Promise<Awaited<ReturnType<HiveRequests[C]>>> {
  try {
    return (await window.hive.invoke(channel, ...args)) as Awaited<ReturnType<HiveRequests[C]>>
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { cause: e })
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
