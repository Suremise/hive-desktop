import { msg, type Msg } from './i18n/msg'

/**
 * The flight recorder's "something unknown arriving" trigger (#698): a CLI's hook named outside the events Hive knows it
 * sends, or a hook or (Claude Code) status line with a top-level field outside the fields it knows. Often the first sign
 * that a CLI update changed something. The known lists are each CLI's advanced values (`<cli>.hooks.knownEvents`,
 * `<cli>.hooks.knownFields`, `<cli>.statusLine.knownFields`, shared/advanced.ts, with recorded samples), so a harmless
 * newcomer can be added without a release; a CLI without one is never judged.
 */

/** The advanced values that list what a CLI is known to send. */
export const knownIds = (provider: string): { events: string; fields: string; statusFields: string } => ({ events: `${provider}.hooks.knownEvents`, fields: `${provider}.hooks.knownFields`, statusFields: `${provider}.statusLine.knownFields` })

/** A name as the recorder repeats it: a name's own characters only, cut short, so nothing else rides along. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/
const safeName = (k: string): string => (NAME.test(k) ? k : '<name>')

/**
 * What of a CLI's hook or status line Hive doesn't know: its event's name (a hook named outside `known.events`) and its
 * top-level fields outside `known.fields` (sorted, at most 10), each a safe name or `<name>`. Nothing for a list the CLI
 * doesn't have, or a payload that isn't an object.
 */
export function unknownIn(kind: 'hook' | 'statusline', body: unknown, known: { events?: readonly string[]; fields?: readonly string[] }): { event: string | null; fields: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { event: null, fields: [] }
  const b = body as Record<string, unknown>
  const name = kind === 'hook' ? (b.hook_event_name ?? b.hookEventName) : undefined
  const event = typeof name === 'string' && known.events && !known.events.includes(name) ? safeName(name) : null
  const fields = known.fields
    ? Object.keys(b)
        .filter((k) => !known.fields!.includes(k))
        .map(safeName)
        .sort()
        .slice(0, 10)
    : []
  return { event, fields }
}

/** The flight recorder's triggers, as their Settings → Advanced values name them (`hive.recorder.<trigger>`). */
export const FLIGHT_TRIGGERS = ['safeguard', 'unknown', 'version', 'stalled', 'pattern'] as const
export type FlightTrigger = (typeof FLIGHT_TRIGGERS)[number]

/** The pattern trigger's default: it never matches anything, so it is off until set. */
export const FLIGHT_PATTERN_OFF = '(?!)'

/** What the notice and the console's list of captures call each trigger, in Hive's language. */
export const FLIGHT_TRIGGER_NAME: Record<FlightTrigger, Msg> = {
  safeguard: msg({ id: 'console.flight.trigger.safeguard', defaultMessage: 'a safeguard stop', description: "What the flight recorder caught, in \"Captured {trigger} on {agent}\": a model's safeguards stopped a response or switched the model." }),
  unknown: msg({ id: 'console.flight.trigger.unknown', defaultMessage: 'something unknown from its CLI', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the CLI sent a field Hive doesn\'t know.' }),
  version: msg({ id: 'console.flight.trigger.version', defaultMessage: 'a CLI version change', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the agent started on a new version of its CLI.' }),
  stalled: msg({ id: 'console.flight.trigger.stalled', defaultMessage: 'a silence past its limit', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the agent went silent in a turn for longer than its limit.' }),
  pattern: msg({ id: 'console.flight.trigger.pattern', defaultMessage: 'an event matching your pattern', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": an event the pattern in Settings → Advanced found.' })
}
