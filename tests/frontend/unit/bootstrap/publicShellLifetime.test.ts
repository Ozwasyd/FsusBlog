import { describe, expect, it } from 'vitest'
import {
  abortPublicShellLifetime,
  getPublicShellLifetimeAbortCount,
  resetPublicShellLifetime
} from '@/bootstrap/publicShellLifetime'

describe('public shell lifetime', () => {
  it('aborts public shell lifetime listeners exactly once', () => {
    const signal = resetPublicShellLifetime()
    let abortEvents = 0
    signal.addEventListener('abort', () => {
      abortEvents += 1
    })

    abortPublicShellLifetime('commit')
    abortPublicShellLifetime('commit-again')

    expect(abortEvents).toBe(1)
    expect(getPublicShellLifetimeAbortCount()).toBe(1)
  })
})
