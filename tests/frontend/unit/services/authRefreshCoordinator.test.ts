import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRefreshCoordinator } from '@/services/authRefreshCoordinator'

class TestChannel {
  static readonly instances = new Set<TestChannel>()
  static readonly messages: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent) => void>()
  readonly name: string

  constructor(name: string) {
    this.name = name
    TestChannel.instances.add(this)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  postMessage(message: unknown): void {
    TestChannel.messages.push(message)
    for (const channel of TestChannel.instances) {
      if (channel === this || channel.name !== this.name) continue
      for (const listener of channel.listeners) listener(new MessageEvent('message', { data: message }))
    }
  }

  close(): void {
    TestChannel.instances.delete(this)
    this.listeners.clear()
  }

  static reset(): void {
    TestChannel.instances.clear()
    TestChannel.messages.length = 0
  }
}

describe('AuthRefreshCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:00:00Z'))
    TestChannel.reset()
  })

  afterEach(() => {
    TestChannel.reset()
    vi.useRealTimers()
  })

  it('elects one BroadcastChannel leader and makes the follower revalidate', async () => {
    const first = coordinator('a')
    const second = coordinator('b')
    const refresh = vi.fn().mockResolvedValue(undefined)
    const firstRevalidate = vi.fn().mockResolvedValue(undefined)
    const secondRevalidate = vi.fn().mockResolvedValue(undefined)

    const firstRun = first.coordinate({
      isRefreshDue: () => true,
      refreshAndRevalidate: async () => { await refresh(); await firstRevalidate() },
      revalidate: firstRevalidate
    })
    const secondRun = second.coordinate({
      isRefreshDue: () => true,
      refreshAndRevalidate: async () => { await refresh(); await secondRevalidate() },
      revalidate: secondRevalidate
    })

    await vi.runAllTimersAsync()
    await Promise.all([firstRun, secondRun])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(firstRevalidate).toHaveBeenCalledTimes(1)
    expect(secondRevalidate).toHaveBeenCalledTimes(1)
    expect(TestChannel.messages.every((message) => {
      const keys = Object.keys(message as Record<string, unknown>)
      return !keys.some((key) => /token|session|account/i.test(key))
    })).toBe(true)

    first.dispose()
    second.dispose()
  })

  it('does not replay refresh when a leader reports a failed attempt', async () => {
    const first = coordinator('a')
    const second = coordinator('b')
    const failedLeader = vi.fn().mockRejectedValue(new Error('tab_closed'))
    const successor = vi.fn().mockResolvedValue(undefined)

    const firstRun = first.coordinate({
      isRefreshDue: () => true,
      refreshAndRevalidate: failedLeader,
      revalidate: vi.fn().mockResolvedValue(undefined)
    })
    const firstResult = firstRun.catch((error: unknown) => error)
    const secondRun = second.coordinate({
      isRefreshDue: () => true,
      refreshAndRevalidate: successor,
      revalidate: vi.fn().mockResolvedValue(undefined)
    })
    const secondResult = secondRun.catch((error: unknown) => error)

    await vi.runAllTimersAsync()
    await expect(firstResult).resolves.toMatchObject({ message: 'tab_closed' })
    await expect(secondResult).resolves.toMatchObject({ message: 'auth_refresh_leader_failed' })
    expect(failedLeader).toHaveBeenCalledTimes(1)
    expect(successor).not.toHaveBeenCalled()

    first.dispose()
    second.dispose()
  })

  it('takes the next election round when an elected leader exits without settling', async () => {
    const follower = coordinator('b')
    const deadLeaderChannel = new TestChannel('fsus-auth-refresh')
    const successor = vi.fn().mockResolvedValue(undefined)
    const round = Math.floor(Date.now() / 40)

    const followerRun = follower.coordinate({
      isRefreshDue: () => true,
      refreshAndRevalidate: successor,
      revalidate: vi.fn().mockResolvedValue(undefined)
    })
    deadLeaderChannel.postMessage({ v: 1, type: 'intent', round, contender: 'a', at: Date.now() })
    deadLeaderChannel.close()

    await vi.runAllTimersAsync()
    await expect(followerRun).resolves.toBeUndefined()
    expect(successor).toHaveBeenCalledTimes(1)

    follower.dispose()
  })

  it('joins an adjacent boundary round so simultaneous tabs still elect one leader', async () => {
    let now = 39
    const refresh = vi.fn().mockResolvedValue(undefined)
    const first = new AuthRefreshCoordinator({
      tabId: 'a',
      now: () => now,
      createChannel: (name) => new TestChannel(name),
      electionWindowMs: 40,
      followerTimeoutMs: 200
    })
    const firstRun = first.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: vi.fn() })
    now = 41
    const second = new AuthRefreshCoordinator({
      tabId: 'b',
      now: () => now,
      createChannel: (name) => new TestChannel(name),
      electionWindowMs: 40,
      followerTimeoutMs: 200
    })
    const secondRun = second.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: vi.fn() })

    await vi.runAllTimersAsync()
    await Promise.all([firstRun, secondRun])
    expect(refresh).toHaveBeenCalledTimes(1)

    first.dispose()
    second.dispose()
  })

  it('serializes callers through Web Locks and skips a refresh after leader settlement', async () => {
    let tail = Promise.resolve()
    const locks = {
      request: async <T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>) => {
        const previous = tail
        let release!: () => void
        tail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try { return await callback() } finally { release() }
      }
    }
    vi.spyOn(locks, 'request')
    const first = new AuthRefreshCoordinator({ tabId: 'a', locks, createChannel: (name) => new TestChannel(name) })
    const second = new AuthRefreshCoordinator({ tabId: 'b', locks, createChannel: (name) => new TestChannel(name) })
    const refresh = vi.fn().mockResolvedValue(undefined)
    const followerRevalidate = vi.fn().mockResolvedValue(undefined)

    await Promise.all([
      first.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: vi.fn() }),
      second.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: followerRevalidate })
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(followerRevalidate).toHaveBeenCalledTimes(1)
    first.dispose()
    second.dispose()
  })

  it('uses a timestamp-only completion hint when Web Locks exist without BroadcastChannel', async () => {
    let tail = Promise.resolve()
    let lastSuccessAt = 0
    const locks = {
      request: async <T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>) => {
        const previous = tail
        let release!: () => void
        tail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try { return await callback() } finally { release() }
      }
    }
    const options = (tabId: string) => ({
      tabId,
      locks,
      createChannel: null,
      readLastSuccessAt: () => lastSuccessAt,
      writeLastSuccessAt: (at: number) => { lastSuccessAt = at }
    })
    const first = new AuthRefreshCoordinator(options('a'))
    const second = new AuthRefreshCoordinator(options('b'))
    const refresh = vi.fn().mockResolvedValue(undefined)
    const followerRevalidate = vi.fn().mockResolvedValue(undefined)

    await Promise.all([
      first.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: vi.fn() }),
      second.coordinate({ isRefreshDue: () => true, refreshAndRevalidate: refresh, revalidate: followerRevalidate })
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(followerRevalidate).toHaveBeenCalledTimes(1)
    first.dispose()
    second.dispose()
  })
})

function coordinator(tabId: string): AuthRefreshCoordinator {
  return new AuthRefreshCoordinator({
    tabId,
    createChannel: (name) => new TestChannel(name),
    electionWindowMs: 40,
    followerTimeoutMs: 200
  })
}
