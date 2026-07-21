import { AppErrorCode, createAppError } from '@/utils/appError'
export type AuthRefreshTask = {
  isRefreshDue: () => boolean
  refreshAndRevalidate: () => Promise<void>
  revalidate: () => Promise<void>
}

type RefreshEvent =
  | { v: 1; type: 'intent'; round: number; contender: string; at: number }
  | { v: 1; type: 'settled'; round: number; contender: string; at: number; outcome: 'success' | 'failed' }

type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>
  ): Promise<T>
}

type ChannelLike = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
  close(): void
}

export type AuthRefreshCoordinatorOptions = {
  tabId?: string
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
  locks?: LockManagerLike | null
  createChannel?: ((name: string) => ChannelLike) | null
  electionWindowMs?: number
  followerTimeoutMs?: number
  readLastSuccessAt?: () => number
  writeLastSuccessAt?: (at: number) => void
}

const CHANNEL_NAME = 'fsus-auth-refresh'
const LOCK_NAME = 'fsus-auth-refresh-leader'
const DEFAULT_ELECTION_WINDOW_MS = 40
const DEFAULT_FOLLOWER_TIMEOUT_MS = 10_000
const LAST_SUCCESS_STORAGE_KEY = 'fsus:auth:refresh:last-success'

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function parseEvent(value: unknown): RefreshEvent | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RefreshEvent>
  if (candidate.v !== 1
    || (candidate.type !== 'intent' && candidate.type !== 'settled')
    || !Number.isSafeInteger(candidate.round)
    || typeof candidate.contender !== 'string'
    || candidate.contender.length < 1
    || candidate.contender.length > 128
    || typeof candidate.at !== 'number'
    || !Number.isFinite(candidate.at)) {
    return null
  }
  if (candidate.type === 'settled'
    && candidate.outcome !== 'success'
    && candidate.outcome !== 'failed') {
    return null
  }
  return candidate as RefreshEvent
}

export class AuthRefreshCoordinator {
  private readonly tabId: string
  private readonly now: () => number
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly locks: LockManagerLike | null
  private readonly electionWindowMs: number
  private readonly followerTimeoutMs: number
  private readonly readLastSuccessAt: () => number
  private readonly writeLastSuccessAt: (at: number) => void
  private readonly contenders = new Map<number, Set<string>>()
  private readonly settlements = new Map<number, RefreshEvent & { type: 'settled' }>()
  private readonly settlementWaiters = new Map<number, Set<() => void>>()
  private channel: ChannelLike | null
  private localInflight: Promise<void> | null = null
  private lastSuccessfulSettlementAt = 0
  private lastFailedSettlementAt = 0
  private lastSettlement: (RefreshEvent & { type: 'settled' }) | null = null

  constructor(options: AuthRefreshCoordinatorOptions = {}) {
    this.tabId = options.tabId ?? createTabId()
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)))
    this.locks = options.locks ?? null
    this.electionWindowMs = options.electionWindowMs ?? DEFAULT_ELECTION_WINDOW_MS
    this.followerTimeoutMs = options.followerTimeoutMs ?? DEFAULT_FOLLOWER_TIMEOUT_MS
    this.readLastSuccessAt = options.readLastSuccessAt ?? (() => 0)
    this.writeLastSuccessAt = options.writeLastSuccessAt ?? (() => undefined)
    this.channel = options.createChannel?.(CHANNEL_NAME) ?? null
    this.channel?.addEventListener('message', this.handleMessage)
  }

  dispose(): void {
    this.channel?.removeEventListener('message', this.handleMessage)
    this.channel?.close()
    this.channel = null
    this.contenders.clear()
    this.settlements.clear()
    for (const waiters of this.settlementWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
    this.settlementWaiters.clear()
    this.localInflight = null
  }

  coordinate(task: AuthRefreshTask): Promise<void> {
    if (this.localInflight) return this.localInflight
    this.localInflight = this.coordinateOnce(task).finally(() => {
      this.localInflight = null
    })
    return this.localInflight
  }

  private async coordinateOnce(task: AuthRefreshTask): Promise<void> {
    const requestedAt = this.now()
    if (this.locks) {
      await this.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
        const observedSuccessAt = Math.max(this.lastSuccessfulSettlementAt, this.readLastSuccessAt())
        if (observedSuccessAt >= requestedAt) {
          this.lastSuccessfulSettlementAt = observedSuccessAt
          await task.revalidate()
          return
        }
        if (this.lastFailedSettlementAt >= requestedAt) {
          throw createAppError(AppErrorCode.Validation, 'auth_refresh_leader_failed')
        }
        if (!task.isRefreshDue()) return
        await this.runLeader(Math.floor(requestedAt / this.electionWindowMs), task)
      })
      return
    }

    if (!this.channel) {
      if (task.isRefreshDue()) await task.refreshAndRevalidate()
      return
    }

    await this.coordinateByChannel(task, requestedAt, 0)
  }

  private async coordinateByChannel(task: AuthRefreshTask, requestedAt: number, retry: number): Promise<void> {
    const round = Math.floor(this.now() / this.electionWindowMs) + retry
    this.addContender(round, this.tabId)
    this.publish({ v: 1, type: 'intent', round, contender: this.tabId, at: this.now() })
    await this.delay(this.electionWindowMs)

    const leader = [...(this.contenders.get(round) ?? [this.tabId])].sort()[0]
    if (leader === this.tabId) {
      if (this.lastSuccessfulSettlementAt >= requestedAt) {
        await task.revalidate()
        return
      }
      if (task.isRefreshDue()) await this.runLeader(round, task)
      return
    }

    const settled = await this.waitForSettlement(round, requestedAt)
    if (settled?.outcome === 'success' || this.lastSuccessfulSettlementAt >= requestedAt) {
      await task.revalidate()
      return
    }
    if (settled?.outcome === 'failed' || this.lastFailedSettlementAt >= requestedAt) {
      throw createAppError(AppErrorCode.Validation, 'auth_refresh_leader_failed')
    }
    if (retry === 0) {
      await this.coordinateByChannel(task, requestedAt, 1)
      return
    }
    throw createAppError(AppErrorCode.Validation, 'auth_refresh_leader_unavailable')
  }

  private async runLeader(round: number, task: AuthRefreshTask): Promise<void> {
    try {
      await task.refreshAndRevalidate()
      const at = this.now()
      this.lastSuccessfulSettlementAt = at
      this.writeLastSuccessAt(at)
      const event: RefreshEvent = { v: 1, type: 'settled', round, contender: this.tabId, at, outcome: 'success' }
      this.receive(event)
      this.publish(event)
    } catch (error) {
      const event: RefreshEvent = { v: 1, type: 'settled', round, contender: this.tabId, at: this.now(), outcome: 'failed' }
      this.receive(event)
      this.publish(event)
      throw error
    }
  }

  private waitForSettlement(round: number, requestedAt: number): Promise<(RefreshEvent & { type: 'settled' }) | null> {
    const existing = this.settlements.get(round)
    if (existing) return Promise.resolve(existing)
    if (this.lastSettlement && this.lastSettlement.at >= requestedAt) {
      return Promise.resolve(this.lastSettlement)
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        const waiters = this.settlementWaiters.get(round)
        waiters?.delete(finish)
        if (waiters?.size === 0) this.settlementWaiters.delete(round)
        const observed = this.lastSettlement
        const latest = observed && observed.at >= requestedAt ? observed : null
        resolve(this.settlements.get(round) ?? latest)
      }
      const timeout = globalThis.setTimeout(finish, this.followerTimeoutMs)
      const waiters = this.settlementWaiters.get(round) ?? new Set<() => void>()
      waiters.add(finish)
      this.settlementWaiters.set(round, waiters)
    })
  }

  private publish(event: RefreshEvent): void {
    this.channel?.postMessage(event)
  }

  private addContender(round: number, contender: string): void {
    const contenders = this.contenders.get(round) ?? new Set<string>()
    contenders.add(contender)
    this.contenders.set(round, contenders)
    this.pruneRounds()
  }

  private receive(event: RefreshEvent): void {
    if (event.type === 'intent') {
      const shouldJoinRound = this.localInflight !== null
        && !(this.contenders.get(event.round)?.has(this.tabId) ?? false)
      this.addContender(event.round, event.contender)
      if (shouldJoinRound) {
        this.addContender(event.round, this.tabId)
        this.publish({ v: 1, type: 'intent', round: event.round, contender: this.tabId, at: this.now() })
      }
      return
    }
    this.settlements.set(event.round, event)
    this.lastSettlement = event
    this.pruneRounds()
    if (event.outcome === 'success') {
      this.lastSuccessfulSettlementAt = Math.max(this.lastSuccessfulSettlementAt, event.at)
    } else {
      this.lastFailedSettlementAt = Math.max(this.lastFailedSettlementAt, event.at)
    }
    for (const waiters of this.settlementWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
  }

  private handleMessage = (message: MessageEvent): void => {
    const event = parseEvent(message.data)
    if (event) this.receive(event)
  }

  private pruneRounds(): void {
    while (this.contenders.size > 32) {
      const oldest = this.contenders.keys().next().value as number | undefined
      if (oldest === undefined) break
      this.contenders.delete(oldest)
    }
    while (this.settlements.size > 32) {
      const oldest = this.settlements.keys().next().value as number | undefined
      if (oldest === undefined) break
      this.settlements.delete(oldest)
    }
  }
}

export function createBrowserAuthRefreshCoordinator(): AuthRefreshCoordinator {
  const browserWindow = window as Window & { BroadcastChannel?: new (name: string) => BroadcastChannel }
  const lockManager = (navigator as Navigator & { locks?: LockManagerLike }).locks ?? null
  return new AuthRefreshCoordinator({
    locks: lockManager,
    readLastSuccessAt: readBrowserLastSuccessAt,
    writeLastSuccessAt: writeBrowserLastSuccessAt,
    createChannel: typeof browserWindow.BroadcastChannel === 'function'
      ? (name) => new browserWindow.BroadcastChannel!(name)
      : null
  })
}

function readBrowserLastSuccessAt(): number {
  try {
    const value = Number.parseInt(window.localStorage.getItem(LAST_SUCCESS_STORAGE_KEY) ?? '', 10)
    return Number.isFinite(value) && value > 0 && value <= Date.now() + 1_000 ? value : 0
  } catch {
    return 0
  }
}

function writeBrowserLastSuccessAt(at: number): void {
  try {
    window.localStorage.setItem(LAST_SUCCESS_STORAGE_KEY, Math.trunc(at).toString())
  } catch {
    // Restricted storage does not weaken lock exclusivity; it only removes the
    // no-BroadcastChannel completion hint for the next lock holder.
  }
}
