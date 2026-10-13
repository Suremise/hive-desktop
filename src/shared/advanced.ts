/**
 * Advanced settings (#367): the details Hive relies on that a CLI update can break, or that only power users change,
 * gathered as named, documented defaults. A CLI's prompt text, the field names it sends, the timeouts Hive gives its
 * hooks and the hive MCP server: when one changes, an override in Settings → Advanced (or advanced.json) fixes it
 * without a Hive release. Data only, never code: patterns, names, numbers. Each value is checked before it is used, and
 * one that doesn't check out falls back to the default with a warning.
 *
 * A CLI's value (CLI-facing: what Hive reads from it, or gives it) carries samples from recorded fixtures
 * (tests/fixtures/advanced and the other recordings; tests/advanced.test.ts checks each sample is in its fixture): for one
 * Hive reads, what the CLI sent, which the default must read; for one Hive gives the CLI, the CLI taking it (its hooks
 * arriving, its own listing of the value). An override is tried against the same samples: one that no longer reads them
 * is kept (that's the point when the CLI changed) and says so. A CLI's override records the CLI version it was made for,
 * and is flagged once another version is installed.
 *
 * Pure data and helpers: no React, no Node (Settings, the main process and the Assistant's settings tools share it).
 */
import { CLAUDE_FOOTER_MODES } from './claude'
import { COPILOT_FOOTER_MODES } from './copilot'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX } from './defaults'
import { SAFEGUARD_DEFAULTS } from './safeguards'
import type { ProviderId } from './types'

/** What a value is: a regular expression's source (its flags are fixed), a piece of text, a field name, a list of names, a whole number, on or off. */
export type AdvancedKind = 'pattern' | 'text' | 'field' | 'list' | 'number' | 'boolean'

/** Where a value is listed: Hive's own, or one CLI's. */
export type AdvancedGroup = 'hive' | ProviderId

/**
 * A recording of the CLI: for a value Hive reads, the text a pattern or text must find, or the field names a field is
 * looked up among; for a value Hive gives the CLI, text showing the CLI took it (`shows` says what).
 */
export interface AdvancedSample {
  /** The recorded fixture it is taken from (a path from the repository's root). */
  from: string
  /** The CLI version it was recorded with. */
  version: string
  /** Text the CLI showed or sent, which the value must find (a pattern or a text). */
  text?: string
  /** The fields the CLI sent where this one is looked up (a field). */
  fields?: string[]
  /** For a value Hive gives the CLI: what the recording shows of it taking the value. */
  shows?: string
}

export interface AdvancedDef {
  /** Stable, as advanced.json names it: "<provider or hive>.<what>.<which>". */
  id: string
  group: AdvancedGroup
  title: string
  /** What it is for and what goes wrong when it's wrong. */
  desc: string
  kind: AdvancedKind
  default: string | number | string[] | boolean
  /** A pattern's flags: part of the default, not of the value. */
  flags?: string
  min?: number
  max?: number
  /** A number's unit, for the list. */
  unit?: string
  /** One of Hive's settings shown here and kept in advanced.json too, under its own key ("advanced.showDeveloperFeatures"). */
  setting?: string
  /** A workspace can set its own (Settings → Advanced, This workspace). */
  workspace?: boolean
  /** Who takes a change: at once, or sessions started afterwards. */
  applies: 'now' | 'sessions'
  samples?: AdvancedSample[]
}

/** The advanced.json format: written first in the file, so an older or newer Hive can tell. */
export const ADVANCED_FORMAT = 1

const MAX_PATTERN = 500
const MAX_TEXT = 200
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME = /^[a-z0-9][a-z0-9_-]*$/i

const FIX = 'tests/fixtures'

/** A CLI's value (not Hive's own): it needs recorded samples, and an override records the CLI version it was made for. */
export const cliFacing = (d: AdvancedDef): boolean => d.group !== 'hive'

/** Recordings of each CLI taking Hive's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: Record<string, AdvancedSample> = {
  'claude-code': { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "PreToolUse"', shows: "Claude Code sending Hive's hooks, PreToolUse too" },
  codex: { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "PreToolUse"', shows: "Codex running Hive's hooks (trusted, so their timeouts match the hashes Hive gave it), PreToolUse too" },
  copilot: { from: `${FIX}/console/copilot.json`, version: '1.0.95', text: '"name": "PreToolUse"', shows: "Copilot sending Hive's hooks from its launch plugin, PreToolUse too" }
}

/** The agents-per-project value's id (#562). */
export const AGENTS_PER_PROJECT = 'hive.agents.perProject'

/** Each CLI's footer in each mode, from screens recorded in it (#696). */
const FOOTER_SAMPLES: Record<string, AdvancedSample> = {
  'claude-code.manual': { from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '⏸ manual mode on · ? for shortcuts' },
  'claude-code.acceptEdits': { from: `${FIX}/advanced/footer-claude-2.1.296-acceptEdits.txt`, version: '2.1.296', text: '⏵⏵ accept edits on (shift+tab to cycle)' },
  'claude-code.plan': { from: `${FIX}/advanced/footer-claude-2.1.296-plan.txt`, version: '2.1.296', text: '⏸ plan mode on (shift+tab to cycle)' },
  'claude-code.auto': { from: `${FIX}/screen-claude-2.1.296-hive-idle.txt`, version: '2.1.296', text: '⏵⏵ auto mode on (shift+tab to cycle)' },
  'claude-code.bypassPermissions': { from: `${FIX}/advanced/footer-claude-2.1.296-bypassPermissions.txt`, version: '2.1.296', text: '⏵⏵ bypass permissions on (shift+tab to cycle)' },
  'claude-code.dontAsk': { from: `${FIX}/advanced/footer-claude-2.1.296-dontAsk.txt`, version: '2.1.296', text: "⏵⏵ don't ask on (shift+tab to cycle)" },
  'copilot.ask': { from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '· Interactive · Manual Approval ·' },
  'copilot.allowAll': { from: `${FIX}/advanced/footer-copilot-1.0.95-allow-all.txt`, version: '1.0.95', text: '· Interactive · Allow All ·' },
  'copilot.plan': { from: `${FIX}/advanced/footer-copilot-1.0.95-plan.txt`, version: '1.0.95', text: '· Plan · Manual Approval ·' },
  'copilot.autopilot': { from: `${FIX}/advanced/footer-copilot-1.0.95-autopilot.txt`, version: '1.0.95', text: '· Autopilot · Manual Approval ·' }
}

/** Every advanced value, in the order Settings lists them (by group). */
export const ADVANCED_DEFS: readonly AdvancedDef[] = [
  // Hive's own
  {
    id: 'hive.showDeveloperFeatures',
    group: 'hive',
    title: 'Show developer features',
    desc: 'Show Help → Developer Console (Ctrl+Alt+J): what each CLI sends Hive, next to what Hive made of it.',
    kind: 'boolean',
    default: false,
    setting: 'advanced.showDeveloperFeatures',
    applies: 'now'
  },
  {
    id: 'hive.console.showText',
    group: 'hive',
    title: 'Developer console: show prompt, reply and command text',
    desc: "Show the text in the developer console: prompts, replies, commands and tools' arguments, under a banner saying it is unredacted, and start each recording with its text box ticked. Tokens, API keys and sign-in details stay masked whatever this says; agents' hive_console stays redacted, and a recording with text is never attached to Copy Diagnostics.",
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.mcp.replySeconds',
    group: 'hive',
    title: 'hive tools: reply timeout',
    desc: "How long the hive MCP server waits for Hive to answer one of its tools (a wait's own time comes on top). Raise it when a slow or very busy machine makes hive tools fail with \"Hive didn't reply within 300 s\" (#371).",
    kind: 'number',
    default: 300,
    min: 30,
    max: 3600,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'hive.wait.cardMaxSeconds',
    group: 'hive',
    title: 'Card waits: longest',
    desc: "The longest an agent's hive_wait_for_tasks call (without wake) waits before it answers. It has to stay under the CLIs' own tool timeouts, so Hive keeps it a minute below Codex's hive tool timeout whatever is set here.",
    kind: 'number',
    default: 840,
    min: 60,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'hive.wait.agentsMaxSeconds',
    group: 'hive',
    title: 'Agent waits: longest',
    desc: "The longest hive_wait_for_agents waits for agents to finish before it answers. Kept a minute below Codex's hive tool timeout, as card waits are.",
    kind: 'number',
    default: 600,
    min: 30,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'hive.progress.lanesShown',
    group: 'hive',
    title: 'Progress panel: lanes shown',
    desc: "How many card-loop lanes the Progress panel shows before its lanes scroll, until you drag the section's top edge (the drag is kept per workspace). A workspace that runs many lanes at once can set its own.",
    kind: 'number',
    default: 4,
    min: 1,
    max: 24,
    unit: 'lanes',
    workspace: true,
    applies: 'now'
  },
  {
    id: AGENTS_PER_PROJECT,
    group: 'hive',
    title: 'Agents per project',
    desc: `How many agents a project can have (#562): ${AGENT_LIMIT_DEFAULT} unless you need more, up to ${AGENT_LIMIT_MAX}. Each agent runs its own copy of its CLI, so more agents take more memory, and they all share your plans' usage limits. Lowering it removes no agents: a project with more just can't add another. Templates and the Agent API keep to it too.`,
    kind: 'number',
    default: AGENT_LIMIT_DEFAULT,
    min: 1,
    max: AGENT_LIMIT_MAX,
    unit: 'agents',
    workspace: true,
    applies: 'now'
  },
  // Claude Code
  {
    id: 'claude-code.trust.prompt',
    group: 'claude-code',
    title: 'Trust question',
    desc: "Claude Code's question before a folder's first session. Hive shows the agent as waiting for you while it is on screen.",
    kind: 'pattern',
    default: 'trust this folder',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-claude-2.1.296.txt`, version: '2.1.296', text: 'Yes, I trust this folder' }]
  },
  {
    id: 'claude-code.signIn.stopError',
    group: 'claude-code',
    title: 'Sign-in refused: StopFailure error',
    desc: "The error a StopFailure hook names when Claude Code's sign-in was refused (expired, revoked, an invalid key): Hive shows the agent signed out and offers to carry on once it's renewed (#309). Any other error ends the turn as failed.",
    kind: 'text',
    default: 'authentication_failed',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-claude-2.1.291.json`, version: '2.1.291', text: 'authentication_failed' }]
  },
  {
    id: 'claude-code.statusLine.rateLimits',
    group: 'claude-code',
    title: 'Status line: plan limits field',
    desc: "The status line's field with a subscription's limits (the 5-hour and weekly use the status bar shows). Wrong, Hive shows no plan limits for Claude Code.",
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'claude-code.statusLine.fiveHour',
    group: 'claude-code',
    title: 'Status line: 5-hour limit field',
    desc: "The plan limits' field for the 5-hour window.",
    kind: 'field',
    default: 'five_hour',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.weekly',
    group: 'claude-code',
    title: 'Status line: weekly limit field',
    desc: "The plan limits' field for the weekly window.",
    kind: 'field',
    default: 'seven_day',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.usedPercent',
    group: 'claude-code',
    title: 'Status line: percentage used field',
    desc: "A limit's field with the percentage used.",
    kind: 'field',
    default: 'used_percentage',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['used_percentage', 'resets_at'] }]
  },
  {
    id: 'claude-code.hooks.timeoutSeconds',
    group: 'claude-code',
    title: 'Hooks: timeout',
    desc: "How long Claude Code waits for Hive to take one of its hooks (a turn starting or ending, a notification). Hive answers at once; raise it only if Hive's log shows hooks timing out on a slow machine.",
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['claude-code']]
  },
  {
    id: 'claude-code.hooks.preToolUseTimeoutSeconds',
    group: 'claude-code',
    title: 'Hooks: before a tool, timeout',
    desc: "How long Claude Code waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.",
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['claude-code']]
  },
  {
    id: 'claude-code.turnScreen.done',
    group: 'claude-code',
    title: 'Screen: turn done',
    desc: "Claude Code's line above its input when the last turn is done (\"✻ Worked for 12s · done 16:52\"). When Hive missed a turn's end, it takes this on screen to mean the agent is idle; wrong, it leaves such an agent's status unknown, with Mark idle.",
    kind: 'pattern',
    default: String.raw`\bfor (?:\d+[hms]\s*)+· done \d{1,2}:\d{2}\b`,
    applies: 'now',
    samples: [{ from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '✻ Worked for 0s · done 2:19' }]
  },
  {
    id: 'claude-code.safeguard.note',
    group: 'claude-code',
    title: 'Safeguard stop: transcript note',
    desc: "Claude Code's note in its transcript when its safety classifier stops a response, and the notice it adds for the model (#606). Wrong, Hive misses such stops: no shield on the agent's pane, and Performance doesn't count them.",
    kind: 'pattern',
    default: SAFEGUARD_DEFAULTS.claudeNote,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" },
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: 'Your response above was stopped by a safety classifier' }
    ]
  },
  {
    id: 'claude-code.safeguard.prompt',
    group: 'claude-code',
    title: 'Safeguard stop: question',
    desc: "Claude Code's question after a safeguard stop, whether to switch models, told by its open dialog's choices in the lines it wrote last. Hive shows the agent waiting for you, and why, while it is open; wrong, the agent shows only \"Claude needs your permission\".",
    kind: 'pattern',
    default: SAFEGUARD_DEFAULTS.claudePrompt,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/safeguard-prompt-claude-2.1.296.txt`, version: '2.1.296', text: ' ❯ 1. Switch automatically\n      Continue on Opus 4.8 now, and switch without asking from now on\n   2. Stay on Opus 5.5' }]
  },
  ...CLAUDE_FOOTER_MODES.map(
    (m): AdvancedDef => ({
      id: `claude-code.footer.${m.key}`,
      group: 'claude-code',
      title: `Footer: ${m.label}`,
      desc: `Claude Code's footer in the ${m.label} mode ("${FOOTER_SAMPLES[`claude-code.${m.key}`].text}"). Hive reads an agent's permission mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Hive doesn't see the agent in ${m.label}, and can't switch to it without a restart.`,
      kind: 'pattern',
      default: m.pattern,
      flags: 'i',
      applies: 'now',
      samples: [FOOTER_SAMPLES[`claude-code.${m.key}`]]
    })
  ),
  // Codex
  {
    id: 'codex.trust.prompt',
    group: 'codex',
    title: 'Trust question',
    desc: "Codex's question before a folder's first session (in a Git repository). Hive shows the agent as waiting for you while it is on screen.",
    kind: 'pattern',
    default: 'trust this folder',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-codex-0.162.1.txt`, version: '0.162.1', text: 'Trust this folder? Codex can read, edit, and run files here' }]
  },
  {
    id: 'codex.ready.placeholder',
    group: 'codex',
    title: 'Composer placeholder',
    desc: "The text Codex's empty input shows. Codex only says it has started with the first prompt, so Hive takes this text on screen to mean it is ready, and an input line showing only this to mean it is idle.",
    kind: 'text',
    default: 'Ask Codex to do anything',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-idle.txt`, version: '0.162.1', text: '› Ask Codex to do anything' }]
  },
  {
    id: 'codex.signIn.expired',
    group: 'codex',
    title: 'Sign-in refused: error message',
    desc: "A turn's error, in Codex's session file, that means its sign-in was refused or has expired, when Codex doesn't mark the error itself (#309).",
    kind: 'pattern',
    default: String.raw`^unexpected status 401 Unauthorized\b|access token could not be refreshed|refresh token (?:has expired|was already used|was revoked)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-codex-0.160.0.jsonl`, version: '0.160.0', text: 'unexpected status 401 Unauthorized: Incorrect API key provided' }]
  },
  {
    id: 'codex.rateLimits.field',
    group: 'codex',
    title: 'Session file: plan limits field',
    desc: "The field of Codex's token counts with a subscription's limits. Wrong, Hive shows no plan limits for Codex.",
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['type', 'info', 'rate_limits'] }]
  },
  {
    id: 'codex.rateLimits.usedPercent',
    group: 'codex',
    title: 'Session file: percentage used field',
    desc: "A limit's field with the percentage used.",
    kind: 'field',
    default: 'used_percent',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  {
    id: 'codex.rateLimits.windowMinutes',
    group: 'codex',
    title: "Session file: limit's window field",
    desc: "A limit's field with its window in minutes (300 is the 5-hour limit, 10080 the weekly one).",
    kind: 'field',
    default: 'window_minutes',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  {
    id: 'codex.title.items',
    group: 'codex',
    title: 'Terminal title items',
    desc: "What Hive asks Codex to put in its terminal title (tui.terminal_title): its activity, which shows the busy spinner and \"Action Required\", and the project's name. Without activity, Hive can't tell from the title that Codex is working or needs you.",
    kind: 'list',
    default: ['activity', 'project-name'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ hive-codex-setup', shows: "Codex's title with its activity spinner, from the title items Hive gave its setup task" }]
  },
  {
    id: 'codex.hooks.timeoutSeconds',
    group: 'codex',
    title: 'Hooks: timeout',
    desc: "How long Codex waits for Hive to take one of its hooks. Codex itself holds the interrupt and session-end hooks to 3 s at most. Hive approves its hooks for Codex itself, so a change needs no review in Codex.",
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['codex']]
  },
  {
    id: 'codex.hooks.preToolUseTimeoutSeconds',
    group: 'codex',
    title: 'Hooks: before a tool, timeout',
    desc: "How long Codex waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.",
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['codex']]
  },
  {
    id: 'codex.mcp.toolTimeoutSeconds',
    group: 'codex',
    title: 'hive tools: timeout in Codex',
    desc: "How long Codex lets one of Hive's tools run (its tool_timeout_sec for the hive server). Hive's waits stay a minute under it.",
    kind: 'number',
    default: 900,
    min: 120,
    max: 3600,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.162.1.json`, version: '0.162.1', text: '"tool_timeout_sec": 900.0', shows: "Codex reading the hive server's tool_timeout_sec from Hive's -c override (codex mcp list --json)" }]
  },
  {
    id: 'codex.turnScreen.working',
    group: 'codex',
    title: 'Screen: working',
    desc: "Codex's Working line, drawn only while a turn runs. When Hive missed a turn's start or end, it takes this on screen to mean the agent is working; wrong, it can take a working agent for idle.",
    kind: 'pattern',
    default: String.raw`esc to interrupt|\bWorking \(`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: '• Working (5s • esc to interrupt)' }]
  },
  {
    id: 'codex.queue.hint',
    group: 'codex',
    title: 'Screen: holding what was typed',
    desc: "Codex's hint on the last line it draws while it is busy and queues what is typed. Hive waits for it to go before typing into Codex (a message, its /permissions menu at setup); wrong, what Hive types can be queued rather than run.",
    kind: 'pattern',
    default: String.raw`^tab to queue message\b`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: 'tab to queue message' }]
  },
  ...(
    [
      ['readOnly', 'Read Only', 'read-only'],
      ['ask', 'Ask for approval', 'ask'],
      ['approveForMe', 'Approve for me', 'approve-for-me'],
      ['fullAccess', 'Full Access', 'full-access']
    ] as const
  ).map(
    ([key, label, mode]): AdvancedDef => ({
      id: `codex.permissions.${key}`,
      group: 'codex',
      title: `/permissions menu: ${label}`,
      desc: `The label Codex's /permissions menu shows for its ${label} preset. Hive types the number beside it to give an agent the ${mode} mode; wrong, Hive can't find it, and says so rather than choosing another.`,
      kind: 'text',
      default: label,
      applies: 'now',
      samples: [{ from: `${FIX}/codex-0.161-permissions-ask.txt`, version: '0.161', text: label }]
    })
  ),
  // GitHub Copilot
  {
    id: 'copilot.trust.prompt',
    group: 'copilot',
    title: 'Trust question',
    desc: "Copilot's question before a folder's first session. Hive shows the agent as waiting for you while it is on screen.",
    kind: 'pattern',
    default: String.raw`Do you trust the files in this folder\?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-copilot-1.0.95.txt`, version: '1.0.95', text: 'Do you trust the files in this folder?' }]
  },
  {
    id: 'copilot.ready.footer',
    group: 'copilot',
    title: 'Ready footer',
    desc: 'Copilot only says it has started with the first prompt, so Hive takes its footer on screen to mean it is ready.',
    kind: 'pattern',
    default: String.raw`· \/ commands ·`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '← open sidebar · Interactive · Manual Approval · / commands · ? help' }]
  },
  ...COPILOT_FOOTER_MODES.map(
    (m): AdvancedDef => ({
      id: `copilot.footer.${m.key}`,
      group: 'copilot',
      title: `Footer: ${m.label}`,
      desc: `Copilot's footer in the ${m.label} mode ("${FOOTER_SAMPLES[`copilot.${m.key}`].text}")${m.mode === 'ask' ? ', which Ask and Accept edits share (Hive tells them apart by the mode the session started in)' : ''}. Hive reads an agent's mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Hive doesn't see the agent in that mode, and can't switch to it without a restart.`,
      kind: 'pattern',
      default: m.pattern,
      applies: 'now',
      samples: [FOOTER_SAMPLES[`copilot.${m.key}`]]
    })
  ),
  {
    id: 'copilot.signIn.errorType',
    group: 'copilot',
    title: 'Sign-in refused: error type',
    desc: "A session error's type, in Copilot's session file, that means its sign-in was refused or is missing (#309): Hive shows the agent signed out.",
    kind: 'pattern',
    default: '^auth',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'authentication' }]
  },
  {
    id: 'copilot.signIn.errorMessage',
    group: 'copilot',
    title: 'Sign-in refused: error message',
    desc: "A session error's message, in Copilot's session file, that means its sign-in was refused, when its type doesn't say so.",
    kind: 'pattern',
    default: String.raw`please use \/login|sign in to use copilot|not (?:signed|logged) in|\b401\b|bad credentials`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }]
  },
  {
    id: 'copilot.signIn.hookMessage',
    group: 'copilot',
    title: 'Sign-in refused: ErrorOccurred hook',
    desc: "The message of Copilot's ErrorOccurred hook that means a model call was refused for the sign-in: the turn ends signed out. Another error that ends the turn ends it as failed.",
    kind: 'pattern',
    default: String.raw`\b401\b|unauthori[sz]ed|bad credentials|not (logged|signed) in|\/login|token (has )?expired`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }]
  },
  {
    id: 'copilot.hooks.timeoutSeconds',
    group: 'copilot',
    title: 'Hooks: timeout',
    desc: 'How long Copilot waits for Hive to take one of its hooks.',
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['copilot']]
  },
  {
    id: 'copilot.hooks.preToolUseTimeoutSeconds',
    group: 'copilot',
    title: 'Hooks: before a tool, timeout',
    desc: "How long Copilot waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.",
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['copilot']]
  }
]

const BY_ID = new Map(ADVANCED_DEFS.map((d) => [d.id, d]))

export function advancedDef(id: string): AdvancedDef | undefined {
  return BY_ID.get(id)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A value as the setting takes it, or why not: a pattern that compiles (with its flags) and doesn't match empty text
 * (it would match any screen), one line of text, a field name, a list of names, a whole number in range. A list also
 * takes comma-separated text.
 */
export function checkAdvanced(def: AdvancedDef, raw: unknown): { value: string | number | string[] | boolean } | { error: string } {
  switch (def.kind) {
    case 'pattern': {
      if (typeof raw !== 'string' || !raw.trim()) return { error: `${def.title} takes a regular expression (as text).` }
      if (raw.length > MAX_PATTERN || /[\r\n]/.test(raw)) return { error: `${def.title} takes one line of at most ${MAX_PATTERN} characters.` }
      let re: RegExp
      try {
        re = new RegExp(raw, def.flags ?? '')
      } catch (e) {
        return { error: `${def.title} isn't a valid regular expression: ${(e as Error).message}` }
      }
      if (re.test('')) return { error: `${def.title} would match anything (it matches empty text).` }
      return { value: raw }
    }
    case 'text': {
      if (typeof raw !== 'string' || !raw.trim()) return { error: `${def.title} takes text.` }
      if (raw.length > MAX_TEXT || /[\r\n]/.test(raw)) return { error: `${def.title} takes one line of at most ${MAX_TEXT} characters.` }
      return { value: raw }
    }
    case 'field': {
      if (typeof raw !== 'string' || !FIELD.test(raw)) return { error: `${def.title} takes a field name: letters, digits and _ (not starting with a digit).` }
      return { value: raw }
    }
    case 'list': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null
      if (!list || !list.length || list.length > 10 || list.some((x) => typeof x !== 'string' || !NAME.test(x))) return { error: `${def.title} takes 1 to 10 names (letters, digits, - and _), as a list or separated by commas.` }
      return { value: list as string[] }
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'true' || raw === 'on') return { value: true }
      if (raw === 'false' || raw === 'off') return { value: false }
      return { error: `${def.title} takes true or false.` }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN
      if (!Number.isInteger(n) || n < (def.min ?? -Infinity) || n > (def.max ?? Infinity)) return { error: `${def.title} takes a whole number from ${def.min} to ${def.max}.` }
      return { value: n }
    }
  }
}

/** A pattern value as a regular expression, with its flags. */
export const advancedRegExp = (def: AdvancedDef, value: string): RegExp => new RegExp(value, def.flags ?? '')

/** A text value as a regular expression that finds it literally. */
export const literalRegExp = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

/** Whether a value reads one sample. */
function reads(def: AdvancedDef, value: unknown, s: AdvancedSample): boolean {
  if (def.kind === 'pattern' && typeof value === 'string' && s.text !== undefined) return advancedRegExp(def, value).test(s.text)
  if (def.kind === 'text' && typeof value === 'string' && s.text !== undefined) return s.text.includes(value)
  if (def.kind === 'field' && typeof value === 'string' && s.fields) return s.fields.includes(value)
  return true
}

/**
 * Whether a (valid) value still reads what the CLI was recorded sending: null when it does (or there is nothing to
 * try it on), else what it misses. Only said, never refused: an override is usually made because the CLI changed.
 */
export function sampleMiss(def: AdvancedDef, value: unknown): string | null {
  const samples = def.samples ?? []
  if (!samples.length || samples.some((s) => reads(def, value, s))) return null
  const s = samples.filter((x) => !x.shows)[0] ?? samples[samples.length - 1]
  const cli = groupName(def.group)
  if (def.kind === 'field') return `${cli} ${s.version} sent no field "${String(value)}" here (it sent ${s.fields?.join(', ')}). Fine if ${cli} has changed since.`
  return `It doesn't find what ${cli} ${s.version} showed ("${s.text}"). Fine if ${cli} has changed since.`
}

const GROUP_NAMES: Record<string, string> = { hive: 'Hive', 'claude-code': 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot' }
export const groupName = (g: AdvancedGroup): string => GROUP_NAMES[g] ?? g

/** The CLI version an override was made for: the installed one when it was set, and the value it was set to. */
export interface MadeFor {
  version: string | null
  value: unknown
}

/** What Settings → Advanced shows and the main process keeps: advanced.json's overrides and this workspace's own. */
export interface AdvancedState {
  /** advanced.json's full path. */
  file: string
  /** Why advanced.json couldn't be read as it is now (not JSON, not an object): Hive keeps what it read before. */
  fileError: string | null
  /** The overrides in advanced.json, as written (an invalid one too: it falls back to the default). */
  values: Record<string, unknown>
  /** For a CLI-facing override: the CLI version it was made for. */
  madeFor: Record<string, MadeFor>
  /** Ids in advanced.json that this Hive doesn't know (a typo, or a newer Hive's): kept, not used. */
  unknown: string[]
  /** The open workspace's own values (workspace.json), for the values a workspace can set; null without one. */
  workspace: Record<string, unknown> | null
  /** Each CLI's installed version, as Hive last found it. */
  cli: Partial<Record<ProviderId, string | null>>
}

/** One value as Settings lists it. */
export interface AdvancedRow {
  def: AdvancedDef
  /** What Hive uses now (for this workspace, when it has its own). */
  value: string | number | string[] | boolean
  /** advanced.json's override, as written (undefined: none). */
  override: unknown
  /** This workspace's own (undefined: none). */
  workspaceValue: unknown
  /** Why an override isn't used (the default is, instead). */
  problem: string | null
  /** An override that no longer reads what the CLI was recorded sending. */
  miss: string | null
  /** A CLI-facing override made for another CLI version than the installed one: "2.1.296". */
  madeForOther: string | null
}

/** A value used: the workspace's own (if the def takes one and it checks out), else the override, else the default. */
export function advancedRow(def: AdvancedDef, state: Pick<AdvancedState, 'values' | 'madeFor' | 'workspace' | 'cli'> | null): AdvancedRow {
  const override = state?.values[def.id]
  const own = def.workspace ? state?.workspace?.[def.id] : undefined
  const checked = override === undefined ? null : checkAdvanced(def, override)
  const ownChecked = own === undefined || own === null ? null : checkAdvanced(def, own)
  const problem = checked && 'error' in checked ? checked.error : ownChecked && 'error' in ownChecked ? `This workspace's: ${ownChecked.error}` : null
  const value = ownChecked && 'value' in ownChecked ? ownChecked.value : checked && 'value' in checked ? checked.value : def.default
  const made = state?.madeFor[def.id]
  const installed = cliFacing(def) ? state?.cli[def.group as ProviderId] : null
  return {
    def,
    value,
    override,
    workspaceValue: own ?? undefined,
    problem,
    miss: checked && 'value' in checked ? sampleMiss(def, checked.value) : null,
    madeForOther: cliFacing(def) && override !== undefined && made?.version && installed && made.version !== installed ? made.version : null
  }
}

/** A value as the list and the tools show it. */
export function advancedText(def: AdvancedDef, v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (def.kind === 'number') return `${String(v)}${def.unit ? ` ${def.unit}` : ''}`
  return String(v)
}

/** advanced.json's content: its format, the overrides and the versions they were made for, keys in order. */
export function advancedFileText(values: Record<string, unknown>, madeFor: Record<string, MadeFor>): string {
  const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  return `${JSON.stringify({ format: ADVANCED_FORMAT, values: sorted(values), madeFor: sorted(madeFor) }, null, 2)}\n`
}

/** advanced.json read: its overrides and versions, or why it can't be used (then Hive keeps what it had). */
export function parseAdvancedFile(text: string): { values: Record<string, unknown>; madeFor: Record<string, MadeFor>; unknown: string[] } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { error: `advanced.json isn't valid JSON: ${(e as Error).message}` }
  }
  if (!isPlainObject(raw)) return { error: 'advanced.json should hold an object: { "format": 1, "values": { … } }.' }
  if (typeof raw.format === 'number' && raw.format > ADVANCED_FORMAT) return { error: `advanced.json is from a newer Hive (format ${raw.format}): this one reads format ${ADVANCED_FORMAT}.` }
  const values = raw.values === undefined ? {} : raw.values
  if (!isPlainObject(values)) return { error: 'advanced.json\'s "values" should be an object of setting → value.' }
  const madeFor: Record<string, MadeFor> = {}
  if (isPlainObject(raw.madeFor))
    for (const [k, m] of Object.entries(raw.madeFor)) if (isPlainObject(m) && k in values) madeFor[k] = { version: typeof m.version === 'string' ? m.version : null, value: m.value }
  return { values: { ...values }, madeFor, unknown: Object.keys(values).filter((k) => !BY_ID.has(k)) }
}

/** What a value takes, in words. */
export function advancedTakes(d: AdvancedDef): string {
  switch (d.kind) {
    case 'number':
      return `A whole number of ${d.unit === 's' ? 'seconds' : (d.unit ?? 'units')}, ${d.min} to ${d.max}.`
    case 'pattern':
      return `A regular expression (JavaScript${d.flags ? `, flags ${d.flags}` : ''}).`
    case 'field':
      return 'A field name.'
    case 'list':
      return 'Names separated by commas.'
    case 'text':
      return 'Text, found as it is.'
    case 'boolean':
      return 'On or off (true or false).'
  }
}
