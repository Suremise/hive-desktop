import { describe, expect, it } from 'vitest'
import { applyStep, hookStep, type HookAction, type HookStatusInput } from '../src/main/hookStatus'
import type { ProviderAdapter } from '../src/main/providers/types'
import type { SessionStatus } from '../src/shared/types'

/**
 * Hook calls as each CLI sends them, through its adapter's normaliser and the status rules, the way
 * SessionManager.handleHookNow does (it carries out the actions; here they're only recorded).
 */
interface Agent {
  status: SessionStatus
  statusMessage?: string
  unseen?: boolean
  askedAtStart: boolean
  compacting: HookStatusInput['compacting']
  tasks: number
  actions: HookAction[]
}

const agent = (status: SessionStatus, extra: Partial<Agent> = {}): Agent => ({ status, askedAtStart: false, compacting: null, tasks: 0, actions: [], ...extra })

function send(adapter: ProviderAdapter, a: Agent, ...bodies: Record<string, unknown>[]): Agent {
  for (const body of bodies) {
    const step = hookStep(adapter.normalizeHook(body).event, { ...a, backgroundWakes: adapter.descriptor.capabilities.backgroundWakes })
    a.actions.push(...step.actions)
    applyStep(a, step)
    if (step.actions.includes('compactBegan')) a.compacting = 'started'
    if (step.actions.includes('compactEnded')) {
      a.compacting = null
      // finishCompacting: back to ready.
      if (a.status === 'working') a.status = 'ready'
    }
  }
  return a
}

const providers = async (): Promise<[string, ProviderAdapter, Record<string, Record<string, unknown>>][]> => {
  const { claudeCode } = await import('../src/main/providers/claude/adapter')
  const { codex } = await import('../src/main/providers/codex/adapter')
  return [
    [
      'Claude Code',
      claudeCode,
      {
        start: { hook_event_name: 'SessionStart', source: 'startup' },
        prompt: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
        toolStart: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
        toolEnd: { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
        ask: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
        stop: { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
        compactStart: { hook_event_name: 'PreCompact', trigger: 'manual' },
        compactEnd: { hook_event_name: 'PostCompact' },
        end: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }
      }
    ],
    [
      'Codex',
      codex,
      {
        start: { hook_event_name: 'SessionStart', source: 'startup' },
        prompt: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
        toolStart: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
        toolEnd: { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
        ask: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
        stop: { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
        compactStart: { hook_event_name: 'PreCompact', trigger: 'manual' },
        compactEnd: { hook_event_name: 'PostCompact' },
        end: { hook_event_name: 'SessionEnd' }
      }
    ]
  ]
}

describe('hook → status, for each provider', () => {
  it('a turn: starting → ready → working → waiting → working → finished', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = agent('starting')
      expect(send(adapter, a, h.start).status, name).toBe('ready')
      expect(send(adapter, a, h.prompt, h.toolStart).status, name).toBe('working')
      send(adapter, a, h.ask)
      expect(a.status, name).toBe('waiting')
      expect(a.statusMessage, name).toMatch(name === 'Codex' ? /^Codex asks to run rm -rf build/ : /permission to use Bash/)
      expect(a.unseen, name).toBe(true)
      a.unseen = false
      // The user answers: the tool runs.
      send(adapter, a, h.toolEnd)
      expect([a.status, a.statusMessage], name).toEqual(['working', undefined])
      send(adapter, a, h.stop)
      expect([a.status, a.statusMessage, a.unseen], name).toEqual(['finished', undefined, true])
      expect(a.actions.filter((x) => x === 'notifyWaiting' || x === 'notifyFinished'), name).toEqual(['notifyWaiting', 'notifyFinished'])
      expect(a.actions, name).toContain('releaseLocks')
      expect(a.actions, name).toContain('turnEnded')
    }
  })

  it('a SessionStart later (a resume or /clear) leaves a running agent alone', async () => {
    for (const [name, adapter, h] of await providers()) {
      expect(send(adapter, agent('working'), h.start).status, name).toBe('working')
      expect(send(adapter, agent('finished'), h.start).status, name).toBe('finished')
      // But one that asked a question at start (folder trust) is ready once answered.
      expect(send(adapter, agent('waiting', { askedAtStart: true }), h.start).status, name).toBe('ready')
    }
  })

  it('a prompt from any state is working; a tool ending revives an idle agent', async () => {
    for (const [name, adapter, h] of await providers()) {
      for (const from of ['ready', 'finished', 'waiting', 'background'] as SessionStatus[]) {
        expect(send(adapter, agent(from), h.prompt).status, `${name} ${from}`).toBe('working')
        expect(send(adapter, agent(from), h.toolEnd).status, `${name} ${from}`).toBe('working')
      }
      expect(send(adapter, agent('starting'), h.toolEnd).status, name).toBe('starting')
    }
  })

  it('the session ends: stopped, every lock released and the tasks forgotten', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working', { tasks: 2 }), h.end)
      expect(a.status, name).toBe('stopped')
      expect(a.actions, name).toEqual(['releaseAllLocks', 'clearTasks'])
    }
  })

  it('compaction Hive asked for: under way, then ready', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = agent('working', { statusMessage: 'Compacting…', compacting: 'requested' })
      send(adapter, a, h.compactStart)
      expect([a.status, a.compacting, a.actions], name).toEqual(['working', 'started', ['compactBegan']])
      send(adapter, a, h.compactEnd)
      expect([a.status, a.compacting], name).toEqual(['ready', null])
    }
  })

  it('compaction the CLI does by itself: said, and an idle agent is ready again after it', async () => {
    for (const [name, adapter, h] of await providers()) {
      // Mid-turn: it keeps working, with a heads-up.
      const busy = send(adapter, agent('working'), h.compactStart)
      expect([busy.status, busy.statusMessage, busy.actions], name).toEqual(['working', undefined, ['autoCompact']])
      expect(send(adapter, busy, h.compactEnd).status, name).toBe('working')
      // /compact typed while idle: working while it compacts, and ready (not stuck working) once done.
      const idle = send(adapter, agent('ready'), h.compactStart)
      expect([idle.status, idle.statusMessage], name).toEqual(['working', 'Compacting the conversation…'])
      send(adapter, idle, h.compactEnd)
      expect([idle.status, idle.statusMessage], name).toEqual(['ready', undefined])
    }
  })

  it('duplicates: the same question or a second Stop notifies once', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working'), h.ask, h.ask)
      expect(a.actions.filter((x) => x === 'notifyWaiting').length, name).toBe(1)
      send(adapter, a, h.stop, h.stop)
      expect(a.actions.filter((x) => x === 'notifyFinished').length, name).toBe(1)
      expect(a.status, name).toBe('finished')
    }
  })

  it('out of order: a late tool end after Stop revives the agent; a Stop then settles it again', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working'), h.stop, h.toolEnd)
      expect(a.status, name).toBe('working')
      expect(send(adapter, a, h.stop).status, name).toBe('finished')
    }
  })

  it('unknown hooks and tool starts change nothing', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('waiting', { statusMessage: 'Allow?' }), { hook_event_name: 'SubagentStop' }, h.toolStart)
      expect([a.status, a.statusMessage, a.actions], name).toEqual(['waiting', 'Allow?', []])
    }
  })
})

describe('background tasks at a turn end', () => {
  it('Claude Code (told when they end): background while any run, without a finished notification', async () => {
    const [[, claude, h]] = await providers()
    const a = send(claude, agent('working', { tasks: 1 }), h.stop)
    expect(a.status).toBe('background')
    expect(a.actions).not.toContain('notifyFinished')
    // An interrupted turn with tasks still running is background too.
    expect(hookStep({ kind: 'interrupt' }, { status: 'working', askedAtStart: false, compacting: null, backgroundWakes: true, tasks: 2 }).next).toBe('background')
  })

  it("Codex (not told): finished, since it won't carry on by itself", async () => {
    const [, [, codexAdapter, h]] = await providers()
    const a = send(codexAdapter, agent('working', { tasks: 1 }), h.stop)
    expect(a.status).toBe('finished')
    expect(a.actions).toContain('notifyFinished')
    expect(send(codexAdapter, agent('working', { tasks: 1 }), { hook_event_name: 'Interrupt' }).status).toBe('ready')
  })
})

describe('background tasks: their time limit', () => {
  it('drops tasks past their own expiry quietly, and those past the limit by name', async () => {
    const { expireTasks } = await import('../src/main/hookStatus')
    const now = Date.parse('2026-10-02T12:00:00Z')
    const min = 60_000
    const tasks = new Map([
      ['tests', { at: now - 5 * min }],
      ['server', { at: now - 61 * min }],
      ['monitor', { at: now - 2 * min, expiresAt: now - 1 }],
      ['watch', { at: now - 2 * min, expiresAt: now + 10 * min }]
    ])
    expect(expireTasks(tasks, now, 60)).toEqual(['server'])
    expect([...tasks.keys()]).toEqual(['tests', 'watch'])
    expect(expireTasks(tasks, now, 60)).toEqual([])
    // At exactly the limit it stops counting.
    expect(expireTasks(new Map([['a', { at: now - 10 * min }]]), now, 10)).toEqual(['a'])
  })
})
