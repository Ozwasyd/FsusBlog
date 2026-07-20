import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PostAuthCommitCoordinator,
  type PostAuthCommitContext
} from '@/composables/usePostAuthCommit'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createContext = (): PostAuthCommitContext => ({
  userStore: {
    isLoggedIn: false,
    invalidateGuestCache: vi.fn(),
    cancelUserInfoRequest: vi.fn()
  },
  ensureAccountSession: vi.fn().mockResolvedValue(undefined),
  markSessionActive: vi.fn()
})

describe('PostAuthCommitCoordinator', () => {
  it.each([
    'usePasskeyLogin.ts',
    'useAuthLogin.ts',
    'useAnonymousOnboarding.ts'
  ])('%s delegates authentication state ownership to the shared commit', (fileName) => {
    const source = readFileSync(resolve(process.cwd(), 'src/composables', fileName), 'utf8')

    expect(source).toContain("import { usePostAuthCommit } from '@/composables/usePostAuthCommit'")
    expect(source).toContain('if (!await commitPostAuthSession())')
    expect(source).toContain('await authBroadcastRuntime.broadcastLogin()')
    expect(source.indexOf('if (!await commitPostAuthSession())'))
      .toBeLessThan(source.indexOf('authBroadcastRuntime.broadcastLogin()'))
    expect(source).not.toContain('ensureBootstrap(true)')
  })

  it('invalidates a fresh guest result and accepts only a forced server Session snapshot', async () => {
    const coordinator = new PostAuthCommitCoordinator()
    const context = createContext()
    vi.mocked(context.ensureAccountSession).mockImplementationOnce(async () => {
      expect(context.userStore.invalidateGuestCache).toHaveBeenCalledOnce()
      Object.defineProperty(context.userStore, 'isLoggedIn', { value: true })
    })

    await expect(coordinator.commit(Symbol('passkey'), context)).resolves.toBe(true)

    expect(context.ensureAccountSession).toHaveBeenCalledWith({ force: true, reason: 'runtime' })
    expect(context.markSessionActive).toHaveBeenCalledOnce()
  })

  it('rejects the commit when auth me does not produce an authenticated snapshot', async () => {
    const coordinator = new PostAuthCommitCoordinator()
    const context = createContext()

    await expect(coordinator.commit(Symbol('mfa'), context)).resolves.toBe(false)

    expect(context.markSessionActive).not.toHaveBeenCalled()
  })

  it('lets a newer commit supersede an older response', async () => {
    const coordinator = new PostAuthCommitCoordinator()
    const context = createContext()
    const first = deferred()
    const second = deferred()
    vi.mocked(context.ensureAccountSession)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const stale = coordinator.commit(Symbol('stale'), context)
    const current = coordinator.commit(Symbol('current'), context)
    first.resolve()
    await expect(stale).resolves.toBe(false)

    Object.defineProperty(context.userStore, 'isLoggedIn', { value: true })
    second.resolve()
    await expect(current).resolves.toBe(true)
    expect(context.markSessionActive).toHaveBeenCalledOnce()
  })

  it('cancels the owned Session read when its component is disposed', async () => {
    const coordinator = new PostAuthCommitCoordinator()
    const context = createContext()
    const request = deferred()
    vi.mocked(context.ensureAccountSession).mockReturnValueOnce(request.promise)
    const owner = Symbol('anonymous-bootstrap')

    const pending = coordinator.commit(owner, context)
    coordinator.cancel(owner, context)
    request.resolve()

    await expect(pending).resolves.toBe(false)
    expect(context.userStore.cancelUserInfoRequest).toHaveBeenCalledOnce()
    expect(context.markSessionActive).not.toHaveBeenCalled()
  })
})
