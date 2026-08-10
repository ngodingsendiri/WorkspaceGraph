import { describe, it, expect, vi, afterEach } from 'vitest'
import { installProcessSafetyNet } from './processSafety'

describe('processSafety (AD-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handles unhandledRejection by logging instead of crashing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installProcessSafetyNet()
    process.emit('unhandledRejection', new Error('boom-rejection'))
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('unhandledRejection'))).toBe(true)
  })

  it('handles uncaughtException by logging instead of crashing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installProcessSafetyNet()
    process.emit('uncaughtException', new Error('boom-exception'))
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('uncaughtException'))).toBe(true)
  })

  it('is idempotent — second install does not duplicate listeners', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installProcessSafetyNet()
    installProcessSafetyNet()
    process.emit('unhandledRejection', 'just-a-string')
    const rejectionLogs = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes('unhandledRejection')
    )
    expect(rejectionLogs).toHaveLength(1)
  })
})
