/**
 * The hive tools the Hive Assistant gets, by how far it may act (Settings → Assistant → Control). The hive MCP
 * server offers these and Claude Code runs them without asking (they're Hive's own, already limited by the
 * control level and checked again by the Agent API). No imports: hive-mcp.js runs outside the app bundle.
 */

export type AssistantControlLevel = 'look' | 'agents' | 'projects'

/** Tools that only read: every Assistant (and, for the first ones, every agent) has them. */
export const ASSISTANT_READ_TOOLS = [
  'hive_list_settings',
  'hive_read_setting',
  'hive_list_projects',
  'hive_project_status',
  'hive_session_usage',
  'hive_list_shared_notes',
  'hive_read_shared_note',
  'hive_read_latest_handover',
  'hive_list_skills',
  'hive_agent_activity',
  'hive_wait_for_agents',
  'hive_list_providers',
  'hive_list_tasks',
  'hive_read_task',
  'hive_wait_for_tasks'
]

/** Running agents: add, change, start, stop, prompt; and turning projects on and off. Starting a board card runs an agent too. */
export const ASSISTANT_AGENT_TOOLS = ['hive_activate_project', 'hive_add_agent', 'hive_update_agent', 'hive_start_agent', 'hive_stop_agent', 'hive_prompt_agent', 'hive_hand_over', 'hive_start_task']

/** Changing the task board: every agent has these; the Assistant at the control level that runs agents. */
export const TASK_TOOLS = ['hive_create_task', 'hive_update_task', 'hive_update_tasks', 'hive_reorder_tasks']

/** Creating projects. */
export const ASSISTANT_PROJECT_TOOLS = ['hive_create_project']

/** Changing Hive's settings: only with Settings → Assistant → Control → Change settings on, whatever the level. */
export const ASSISTANT_SETTINGS_TOOLS = ['hive_update_setting']

/** Tools only project agents have (the Assistant doesn't get them): the merge slot is held by an agent's own launch. */
export const AGENT_ONLY_TOOLS = ['hive_merge_slot']

/** Tools only the Assistant has (project agents don't get them). */
export const ASSISTANT_ONLY_TOOLS = ['hive_agent_activity', 'hive_wait_for_agents', 'hive_list_providers', 'hive_list_settings', 'hive_read_setting', ...ASSISTANT_AGENT_TOOLS, ...ASSISTANT_PROJECT_TOOLS, ...ASSISTANT_SETTINGS_TOOLS]

const RANK: Record<AssistantControlLevel, number> = { look: 0, agents: 1, projects: 2 }

/** Whether a control level allows what needs `need`. */
export function controlAllows(level: AssistantControlLevel | string | undefined, need: AssistantControlLevel): boolean {
  return (RANK[level as AssistantControlLevel] ?? RANK.projects) >= RANK[need]
}

/** The tools an Assistant with this control level (and Change settings on or off) may use without asking. */
export function assistantTools(level: AssistantControlLevel | string | undefined, changeSettings = false): string[] {
  return [...ASSISTANT_READ_TOOLS, ...(controlAllows(level, 'agents') ? [...ASSISTANT_AGENT_TOOLS, ...TASK_TOOLS] : []), ...(controlAllows(level, 'projects') ? ASSISTANT_PROJECT_TOOLS : []), ...(changeSettings ? ASSISTANT_SETTINGS_TOOLS : [])]
}

/** Every tool the hive MCP server has (a test checks it against hive-mcp.ts): the only tool names metrics record. */
export const HIVE_TOOLS: readonly string[] = [
  'hive_list_projects', 'hive_project_status', 'hive_session_usage', 'hive_list_shared_notes', 'hive_read_shared_note', 'hive_write_shared_note',
  'hive_read_latest_handover', 'hive_create_handover', 'hive_notify', 'hive_list_providers', 'hive_agent_activity', 'hive_wait_for_agents',
  'hive_create_project', 'hive_activate_project', 'hive_add_agent', 'hive_update_agent', 'hive_start_agent', 'hive_stop_agent', 'hive_prompt_agent',
  'hive_hand_over', 'hive_list_tasks', 'hive_read_task', 'hive_create_task', 'hive_update_task', 'hive_update_tasks', 'hive_reorder_tasks', 'hive_start_task', 'hive_list_skills', 'hive_wait_for_tasks',
  'hive_list_settings', 'hive_read_setting', 'hive_update_setting', 'hive_merge_slot'
]
