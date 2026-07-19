// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOTSTRAP_IMPORT_RETRY_KEY,
  BOOTSTRAP_IMPORT_RETRY_TTL_MS,
  createBootstrapImportRecovery,
  runBootstrapImport
} from '@/bootstrap/bootstrapImportRecovery'

const importFailure = () => new TypeError('Failed to fetch dynamically imported module')

describe('bootstrap import recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T03:00:00Z'))
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never persists a private path, query, or hash in its key or value', () => {
    window.history.replaceState(null, '', '/admin/users/42?session=private-token&filter=blocked#detail')
    const reload = vi.fn()
    const recovery = createBootstrapImportRecovery({
      storage: sessionStorage,
      reload,
      buildId: 'build-20260719',
      now: Date.now
    })

    expect(recovery.retryOnce(importFailure())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.length).toBe(1)
    expect(sessionStorage.key(0)).toBe(BOOTSTRAP_IMPORT_RETRY_KEY)

    const persisted = `${sessionStorage.key(0)}:${sessionStorage.getItem(BOOTSTRAP_IMPORT_RETRY_KEY)}`
    expect(persisted).not.toContain('/admin')
    expect(persisted).not.toContain('private-token')
    expect(persisted).not.toContain('blocked')
    expect(persisted).not.toContain('#detail')
  })

  it('allows only one controlled reload for repeated import failures', async () => {
    const reload = vi.fn()
    const recovery = createBootstrapImportRecovery({
      storage: sessionStorage,
      reload,
      buildId: 'build-20260719',
      now: Date.now
    })
    const load = vi.fn().mockRejectedValue(importFailure())

    await expect(runBootstrapImport(load, vi.fn(), recovery)).resolves.toBeUndefined()
    await expect(runBootstrapImport(load, vi.fn(), recovery)).rejects.toThrow(importFailure().message)
    expect(load).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears retry state after a successful dynamic import and bootstrap', async () => {
    sessionStorage.setItem(BOOTSTRAP_IMPORT_RETRY_KEY, JSON.stringify({
      buildId: 'build-20260719',
      attemptedAtMs: Date.now()
    }))
    const recovery = createBootstrapImportRecovery({
      storage: sessionStorage,
      reload: vi.fn(),
      buildId: 'build-20260719',
      now: Date.now
    })
    const bootstrap = vi.fn().mockResolvedValue(undefined)

    await runBootstrapImport(vi.fn().mockResolvedValue({ surface: 'public-aot' }), bootstrap, recovery)

    expect(bootstrap).toHaveBeenCalledWith({ surface: 'public-aot' })
    expect(sessionStorage.getItem(BOOTSTRAP_IMPORT_RETRY_KEY)).toBeNull()
  })

  it('removes markers from an older build before the next import attempt', () => {
    sessionStorage.setItem(BOOTSTRAP_IMPORT_RETRY_KEY, JSON.stringify({
      buildId: 'build-old',
      attemptedAtMs: Date.now()
    }))

    createBootstrapImportRecovery({
      storage: sessionStorage,
      reload: vi.fn(),
      buildId: 'build-new',
      now: Date.now
    })

    expect(sessionStorage.getItem(BOOTSTRAP_IMPORT_RETRY_KEY)).toBeNull()
  })

  it('expires an abandoned marker after the bounded retry window', () => {
    sessionStorage.setItem(BOOTSTRAP_IMPORT_RETRY_KEY, JSON.stringify({
      buildId: 'build-20260719',
      attemptedAtMs: Date.now()
    }))
    vi.advanceTimersByTime(BOOTSTRAP_IMPORT_RETRY_TTL_MS + 1)
    const reload = vi.fn()
    const recovery = createBootstrapImportRecovery({
      storage: sessionStorage,
      reload,
      buildId: 'build-20260719',
      now: Date.now
    })

    expect(sessionStorage.getItem(BOOTSTRAP_IMPORT_RETRY_KEY)).toBeNull()
    expect(recovery.retryOnce(importFailure())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload for bootstrap errors outside the import failure allowlist', async () => {
    const reload = vi.fn()
    const recovery = createBootstrapImportRecovery({
      storage: sessionStorage,
      reload,
      buildId: 'build-20260719',
      now: Date.now
    })

    await expect(runBootstrapImport(
      vi.fn().mockRejectedValue(new Error('application bootstrap failed')),
      vi.fn(),
      recovery
    )).rejects.toThrow('application bootstrap failed')
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(0)
  })
})
