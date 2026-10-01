/**
 * The hive tools the Hive Assistant gets, by how far it may act (Settings → Assistant → Control). The hive MCP
 * server offers these and Claude Code runs them without asking (they're Hive's own, already limited by the
 * control level and checked again by the Agent API). No imports: hive-mcp.js runs outside the app bundle.
 */

export type AssistantControlLevel = 'look' | 'agents' | 'projects'

/** Tools that only read: every Assistant (and, for the first ones, every agent) has them. */
export const ASSISTANT_READ_TOOLS = [
  'hive_list_projects',
  'hive_project_status',
  'hive_session_usage',
  'hive_list_shared_notes',
  'hive_read_shared_note',
  'hive_read_latest_handover',
  'hive_list_skills',
  'hive_agent_activity',
  'hive_wait_for_agents',
  'hive_list_providers'
]

/** Running agents: add, change, start, stop, prompt; and turning projects on and off. */
export const ASSISTANT_AGENT_TOOLS = ['hive_activate_project', 'hive_add_agent', 'hive_update_agent', 'hive_start_agent', 'hive_stop_agent', 'hive_prompt_agent', 'hive_hand_over']

/** Creating projects. */
export const ASSISTANT_PROJECT_TOOLS = ['hive_create_project']

/** Tools only the Assistant has (project agents don't get them). */
export const ASSISTANT_ONLY_TOOLS = ['hive_agent_activity', 'hive_wait_for_agents', 'hive_list_providers', ...ASSISTANT_AGENT_TOOLS, ...ASSISTANT_PROJECT_TOOLS]

const RANK: Record<AssistantControlLevel, number> = { look: 0, agents: 1, projects: 2 }

/** Whether a control level allows what needs `need`. */
export function controlAllows(level: AssistantControlLevel | string | undefined, need: AssistantControlLevel): boolean {
  return (RANK[level as AssistantControlLevel] ?? RANK.projects) >= RANK[need]
}

/** The tools an Assistant with this control level may use without asking. */
export function assistantTools(level: AssistantControlLevel | string | undefined): string[] {
  return [...ASSISTANT_READ_TOOLS, ...(controlAllows(level, 'agents') ? ASSISTANT_AGENT_TOOLS : []), ...(controlAllows(level, 'projects') ? ASSISTANT_PROJECT_TOOLS : [])]
}
