import { describe, expect, it, vi } from 'vitest'
import { requestChallengeCapabilityReload } from '@/security/challenge-capability-reload'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
}

describe('challenge capability full reload', () => {
  it('persists the per-build guard before requesting a normal full reload', () => {
    const storage = memoryStorage()
    const reload = vi.fn()

    expect(requestChallengeCapabilityReload('2026.07.21.1', { storage, reload })).toBe('reload_requested')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(requestChallengeCapabilityReload('2026.07.21.1', { storage, reload })).toBe('already_requested')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('fails closed without reloading when the loop guard cannot be persisted', () => {
    const reload = vi.fn()
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') })
    }

    expect(requestChallengeCapabilityReload('2026.07.21.1', { storage, reload })).toBe('guard_unavailable')
    expect(reload).not.toHaveBeenCalled()
  })
})
