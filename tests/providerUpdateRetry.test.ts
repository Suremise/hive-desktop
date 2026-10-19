import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstallInfo, ProviderId } from '../src/shared/types'

vi.mock('../src/main/ptyHost', () => ({
  spawnPty: vi.fn(), hasPty: vi.fn(() => false), childEnv: () => ({}),
  killPty: vi.fn(), startSize: () => ({ cols: 80, rows: 24 }), writePty: vi.fn()
}))

const { providerService } = await import('../src/main/providerService')
const { spawnPty, hasPty } = await import('../src/main/ptyHost')
const { setLanguage } = await import('../src/shared/i18n')
const svc = providerService as unknown as { set: (id: ProviderId, info: AgentInstallInfo) => void }
const base: AgentInstallInfo = {
  provider: 'copilot', found: true, path: 'C:/Users/me/AppData/Local/Microsoft/WinGet/Links/copilot.exe',
  version: '1.0.95', source: 'PATH', latestVersion: '1.0.98', updateAvailable: true, loggedIn: true, authMethod: null
}
const exit = (code: number): void => vi.mocked(spawnPty).mock.calls.at(-1)![1].onExit!(code, '')
const fail = (): void => {
  providerService.runProviderTask('copilot', 'update')
  exit(-1978335145)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasPty).mockReturnValue(false)
  vi.spyOn(providerService, 'refresh').mockResolvedValue([])
  providerService.setLiveSessionCounter(() => 0)
  // A different path clears a retry left by a previous case.
  svc.set('copilot', { ...base, path: null })
  svc.set('copilot', { ...base })
})

afterEach(() => {
  vi.restoreAllMocks()
  setLanguage('en', {})
})

describe('provider update retries (#1101)', () => {
  it('never forces automatically; offers a retry after failure and consumes it on explicit success', () => {
    expect(() => providerService.runProviderTask('copilot', 'update', true)).toThrow(/no longer available/)
    expect(spawnPty).not.toHaveBeenCalled()
    fail()
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawnPty).mock.calls[0][1].args).not.toContain('--force')
    expect(providerService.info('copilot').updateRetry?.label).toBe('Update anyway')
    providerService.runProviderTask('copilot', 'update', true)
    expect(vi.mocked(spawnPty).mock.calls[1][1].args).toEqual([...vi.mocked(spawnPty).mock.calls[0][1].args, '--force'])
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
    exit(0)
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
  })

  it('keeps the retry through a refresh, translates it, and refuses it while agents run', () => {
    fail()
    svc.set('copilot', { ...base, checking: true })
    svc.set('copilot', { ...base, checking: false })
    setLanguage('de', { 'providers.copilot.updateAnyway': 'Trotzdem aktualisieren', 'providers.copilot.updateModified': 'Die Dateien wurden möglicherweise geändert.' })
    expect(providerService.shown().copilot.updateRetry?.label).toBe('Trotzdem aktualisieren')
    expect(providerService.shown().copilot.updateRetry?.message).toBe('Die Dateien wurden möglicherweise geändert.')
    expect(providerService.info('copilot').updateRetry?.label).toBe('Update anyway')
    providerService.setLiveSessionCounter(() => 1)
    expect(() => providerService.runProviderTask('copilot', 'update', true)).toThrow(/Stop all running/)
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(providerService.info('copilot').updateRetry).toBeDefined()
  })

  it.each([{ path: 'D:/tools/copilot.exe' }, { version: '1.0.98' }])('expires a retry when discovery changes %o', (change) => {
    fail()
    svc.set('copilot', { ...base, ...change })
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
    expect(() => providerService.runProviderTask('copilot', 'update', true)).toThrow(/no longer available/)
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('does not attach an old failure to a newly selected executable, or force a normal second update', () => {
    providerService.runProviderTask('copilot', 'update')
    svc.set('copilot', { ...base, path: 'D:/tools/copilot.exe' })
    exit(-1978335145)
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
    svc.set('copilot', { ...base })
    fail()
    providerService.runProviderTask('copilot', 'update')
    expect(vi.mocked(spawnPty).mock.calls.at(-1)![1].args).not.toContain('--force')
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
    exit(1)
    expect(providerService.info('copilot').updateRetry).toBeUndefined()
  })
})
