import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, EffortLevel } from '../../shared/types'

export interface LaunchSkill {
  name: string
  sourcePath: string
}

export interface LaunchContext {
  projectPath: string
  /** Which of the project's agents is launching ("main" = Agent 1); each gets its own launch folder. */
  agentId: string
  workspacePath: string
  sessionId: string
  resume: boolean
  name: string
  skills: LaunchSkill[]
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  hookUrl: string
  env: Record<string, string>
}

export interface CommandSpec {
  file: string
  args: string[]
  env?: Record<string, string>
}

export interface ExternalSession {
  id: string
  transcriptPath: string
  modified: string
}

/**
 * Everything Hive needs from a CLI coding agent. Only Claude Code is implemented today;
 * new agents implement this interface and register in agents/index.ts.
 */
export interface AgentAdapter {
  readonly id: string
  readonly displayName: string
  locate(): Promise<AgentInstallInfo>
  latestVersion(): Promise<string | null>
  installCommand(): CommandSpec
  updateCommand(executable: string): CommandSpec
  loginCommand(executable: string): CommandSpec
  prepareLaunch(ctx: LaunchContext): Promise<void>
  buildCommand(executable: string, ctx: LaunchContext): CommandSpec
  transcriptPath(projectPath: string, sessionId: string): Promise<string | null>
  transcriptDir(projectPath: string): Promise<string | null>
  listSessions(projectPath: string): Promise<ExternalSession[]>
  memorySources(projectPath: string): Promise<MemorySource[]>
}
