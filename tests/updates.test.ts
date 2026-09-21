import { describe, expect, it } from 'vitest'
import { OVERDUE_MS, SETTLE_MS, shouldInstallNow, type InstallContext } from '../src/shared/updates'

const base: InstallContext = {
  enabled: true,
  downloaded: true,
  now: 10_000_000,
  startedAt: 0,
  downloadedAt: 9_940_000,
  windowVisible: true,
  windowFocused: true,
  idleSeconds: 0,
  locked: false,
  syncBusy: false,
  editorBusy: false
}

describe('shouldInstallNow', () => {
  it('never installs without a download, when disabled, right after start, or mid-work', () => {
    expect(shouldInstallNow({ ...base, downloaded: false }).install).toBe(false)
    expect(shouldInstallNow({ ...base, enabled: false }).install).toBe(false)
    expect(shouldInstallNow({ ...base, startedAt: base.now - SETTLE_MS + 1, locked: true }).install).toBe(false)
    expect(shouldInstallNow({ ...base, syncBusy: true, locked: true }).install).toBe(false)
    expect(shouldInstallNow({ ...base, editorBusy: true, locked: true }).install).toBe(false)
    expect(shouldInstallNow(base)).toEqual({ install: false, reason: 'in use' })
  })

  it('installs at quiet moments', () => {
    expect(shouldInstallNow({ ...base, locked: true }).reason).toBe('screen locked')
    expect(shouldInstallNow({ ...base, windowVisible: false, idleSeconds: 130 }).reason).toBe('window hidden and input idle')
    expect(shouldInstallNow({ ...base, windowVisible: false, idleSeconds: 5, downloadedAt: base.now - 16 * 60_000 }).reason).toBe('window hidden for a while')
    expect(shouldInstallNow({ ...base, windowVisible: false, idleSeconds: 5 }).install).toBe(false)
    expect(shouldInstallNow({ ...base, windowFocused: false, idleSeconds: 601 }).reason).toBe('window unfocused and idle')
    expect(shouldInstallNow({ ...base, idleSeconds: 901 }).reason).toBe('input idle 15 min')
  })

  it('eventually installs an overdue update at the first pause in typing', () => {
    const overdue = { ...base, downloadedAt: base.now - OVERDUE_MS }
    expect(shouldInstallNow({ ...overdue, idleSeconds: 10 }).install).toBe(false)
    expect(shouldInstallNow({ ...overdue, idleSeconds: 61 }).reason).toBe('update overdue')
  })
})
