import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ApiError } from '../../src/Contracts/aeds.ts'
import type {
  AdminInboxFilter,
  AdminInboxLiveStatus,
  AdminInboxOrder,
  AdminInboxPage,
  AdminInboxRow,
  AdminInboxThread,
} from '../../src/Contracts/admin-inbox.ts'
import {
  AdminInboxController,
  type AdminInboxTransport,
} from '../../src/Web/src/admin/adminInboxController.ts'
import type { AdminClock } from '../../src/Web/src/admin/adminOperationCoordinator.ts'

class FakeClock implements AdminClock {
  currentTime: number
  private nextId = 1
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>()
  readonly scheduledDelays: number[] = []

  constructor(startMs = 1_700_000_000_000) {
    this.currentTime = startMs
  }

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.scheduledDelays.push(delayMs)
    this.timers.set(id, { dueAt: this.currentTime + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get activeTimerCount(): number {
    return this.timers.size
  }

  advance(deltaMs: number): void {
    const target = this.currentTime + deltaMs
    while (true) {
      let earliestId: number | undefined
      let earliestDue = Infinity
      for (const [id, entry] of this.timers) {
        if (entry.dueAt <= target && entry.dueAt < earliestDue) {
          earliestDue = entry.dueAt
          earliestId = id
        }
      }
      if (earliestId === undefined) break
      const entry = this.timers.get(earliestId)!
      this.timers.delete(earliestId)
      this.currentTime = Math.max(this.currentTime, entry.dueAt)
      entry.callback()
    }
    this.currentTime = target
  }
}

interface FakeWakeSubscription {
  readonly scope: bigint | AdminInboxLiveStatus
  readonly signal: AbortSignal
  readonly wake: () => void
  readonly onRevoked: () => void
}

function deferred<T = void>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

const sampleAccount = '11111111-2222-3333-4444-555555555555'

function makeRow(id: bigint, overrides: Partial<AdminInboxRow> = {}): AdminInboxRow {
  return {
    id,
    account: sampleAccount,
    subject: `Ticket #${id}`,
    status: 0,
    system: false,
    updated: 1_700_000_000_000,
    unread: 2,
    ...overrides,
  }
}

function makePage(rows: AdminInboxRow[], overrides: Partial<AdminInboxPage> = {}): AdminInboxPage {
  return {
    rows,
    next: null,
    noticesEnabled: true,
    sharedAvailable: true,
    activityAvailable: true,
    liveEnabled: true,
    ...overrides,
  }
}

function makeThread(id: bigint, overrides: Partial<AdminInboxThread> = {}): AdminInboxThread {
  return {
    conversation: makeRow(id),
    messages: [
      { id: 10n, sender: 0, internal: false, at: 1_700_000_000_000, body: 'Initial account message' },
      { id: 11n, sender: 1, internal: true, at: 1_700_000_001_000, body: 'Internal note' },
    ],
    previous: null,
    repliesEnabled: true,
    liveEnabled: true,
    version: '1',
    readSnapshot: { token: 'r'.repeat(64), through: 10n },
    ...overrides,
  }
}

function createTransport(
  overrides: Partial<AdminInboxTransport> = {},
  wakes: FakeWakeSubscription[] = [],
): AdminInboxTransport {
  return {
    adminInbox: async () => makePage([makeRow(1n), makeRow(2n)]),
    adminInboxThread: async id => makeThread(id),
    acknowledgeAdminInboxRead: async () => 0,
    adminReply: async (id, body) => ({ id: 20n, conversationId: id, sender: 1, createdAt: 1_700_000_005_000, body }),
    adminChangeStatus: async (_id, _version, target) => ({ previous: 0, current: target, changed: target !== 0 }),
    adminSendNotice: async () => ({}),
    watchAdminInboxWake: (scope, signal, wake, onRevoked) => {
      wakes.push({ scope, signal, wake, onRevoked })
    },
    ...overrides,
  }
}

test('queue auto-upgrades to shared read, disables live on pagination, and preserves capabilities across filter/order switches', async () => {
  const queueCalls: Array<{ filter: AdminInboxFilter; cursor: string | null; shared: boolean | undefined; order: AdminInboxOrder | undefined }> = []
  const wakes: FakeWakeSubscription[] = []
  const controller = new AdminInboxController({
    transport: createTransport({
      adminInbox: async (filter, cursor, _signal, shared, order) => {
        queueCalls.push({ filter, cursor, shared, order })
        if (cursor === 'next-cursor') {
          return makePage([makeRow(3n)], { next: null, liveEnabled: true })
        }
        return makePage([makeRow(1n, { unread: shared ? 2 : null })], { next: 'next-cursor', sharedAvailable: true, activityAvailable: true, liveEnabled: true })
      },
    }, wakes),
  })

  const session = new AbortController()
  controller.bindSession(session.signal)
  await flushMicrotasks()

  // Initial load detects sharedAvailable=true and performs a second shared=true fetch.
  assert.equal(queueCalls.length, 2)
  assert.equal(queueCalls[0]!.shared, false)
  assert.equal(queueCalls[1]!.shared, true)
  assert.equal(controller.state.sharedRead, true)
  assert.equal(controller.state.activityAvailable, true)
  assert.equal(controller.state.queueLive, true)
  assert.equal(controller.liveScope(), '')
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0]!.scope, '')

  // Appending next page disables queue live subscription and aborts wake signal.
  await controller.loadQueue('next-cursor')
  assert.equal(controller.state.rows.length, 2)
  assert.equal(controller.state.queueLive, false)
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes[0]!.signal.aborted, true)

  // Switching filter to 'unread' keeps sharedRead & activityAvailable, uses shared=true directly, and does not open live wake.
  controller.setFilter('unread')
  await flushMicrotasks()
  assert.equal(queueCalls.at(-1)!.filter, 'unread')
  assert.equal(queueCalls.at(-1)!.shared, true)
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes.length, 1)

  // Switching order to 'activity' keeps live disabled.
  controller.setFilter('open')
  await flushMicrotasks()
  assert.equal(controller.liveScope(), 'open')
  assert.equal(wakes.length, 2)
  assert.equal(wakes[1]!.scope, 'open')

  controller.setOrder('activity')
  await flushMicrotasks()
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes[1]!.signal.aborted, true)

  controller.dispose()
})

test('thread open, earlier messages prepend, read acknowledgement failure + retry, and unread filter removal preserve exact semantics', async () => {
  let ackAttempts = 0
  const ackSnapshots: string[] = []
  const sessionLostErrors: unknown[] = []
  const wakes: FakeWakeSubscription[] = []
  let openedHooks = 0
  let closedHooks = 0
  const snapshotToken = 's'.repeat(64)

  const controller = new AdminInboxController({
    hooks: {
      onSessionLost: err => sessionLostErrors.push(err),
      onThreadOpened: () => { openedHooks++ },
      onThreadClosed: () => { closedHooks++ },
    },
    transport: createTransport({
      adminInbox: async filter => makePage([makeRow(5n, { unread: 1 }), makeRow(6n, { unread: 3 })], {
        liveEnabled: filter !== 'unread',
      }),
      adminInboxThread: async (id, before) => {
        if (before === 'prev-page') {
          return makeThread(id, {
            previous: null,
            messages: [{ id: 8n, sender: 0, internal: false, at: 1_699_999_999_000, body: 'Earlier message' }],
            readSnapshot: null,
          })
        }
        return makeThread(id, {
          previous: 'prev-page',
          readSnapshot: { token: snapshotToken, through: 10n },
        })
      },
      acknowledgeAdminInboxRead: async (_id, snapshot) => {
        ackAttempts++
        ackSnapshots.push(snapshot.token)
        if (ackAttempts === 1) throw new ApiError('temporary ack error', 503)
        return 0
      },
    }, wakes),
  })

  const session = new AbortController()
  controller.bindSession(session.signal)
  await flushMicrotasks()
  controller.setFilter('unread')
  await flushMicrotasks()

  // Opening thread runs focus hook and attempts read acknowledgement; failure retains snapshot and sets unreadAckFailed.
  await controller.openThread(5n)
  assert.equal(openedHooks, 1)
  assert.equal(ackAttempts, 1)
  assert.equal(controller.state.unreadAckFailed, true)
  assert.equal(controller.state.failed, '')
  assert.equal(controller.state.thread?.readSnapshot?.token, snapshotToken)
  assert.equal(sessionLostErrors.length, 1)
  assert.equal(controller.liveScope(), 5n)
  const threadWake = wakes.at(-1)!
  assert.equal(threadWake.scope, 5n)

  // Loading earlier messages prepends history, preserves existing readSnapshot, and keeps the same live wake socket.
  await controller.openThread(5n, 'prev-page')
  assert.deepEqual(controller.state.thread?.messages.map(m => m.id), [8n, 10n, 11n])
  assert.equal(controller.state.thread?.readSnapshot?.token, snapshotToken)
  assert.equal(wakes.length, 2)
  assert.equal(threadWake.signal.aborted, false)

  // Retry marking as read reuses exact readSnapshot, clears unreadAckFailed, and removes row under 'unread' filter.
  await controller.retryRead()
  assert.deepEqual(ackSnapshots, [snapshotToken, snapshotToken])
  assert.equal(controller.state.unreadAckFailed, false)
  assert.equal(controller.state.thread?.readSnapshot, null)
  assert.equal(controller.state.thread?.conversation.unread, 0)
  assert.deepEqual(controller.state.rows.map(r => r.id), [6n])

  // Closing thread stops thread wake and runs focus restoration hook.
  controller.closeThread()
  assert.equal(closedHooks, 1)
  assert.equal(threadWake.signal.aborted, true)
  controller.dispose()
})

test('reply, status change, and system notice preserve idempotency keys, PoW error isolation, and status transition rules', async () => {
  let uuidCounter = 0
  let eventCounter = 100n
  const replyKeys: string[] = []
  const noticeEvents: bigint[] = []
  const sessionLostErrors: unknown[] = []
  let failReplyWithPow = true
  let failNotice = true
  let statusChanged = true

  const controller = new AdminInboxController({
    idGenerator: {
      randomUuid: () => `uuid-${++uuidCounter}`,
      newNoticeEventId: () => ++eventCounter,
    },
    hooks: { onSessionLost: err => sessionLostErrors.push(err) },
    transport: createTransport({
      adminInbox: async () => makePage([makeRow(10n, { status: 0 })]),
      adminInboxThread: async id => makeThread(id, {
        conversation: makeRow(id, { status: statusChanged ? 1 : 0 }),
        version: '2',
        readSnapshot: null,
      }),
      adminReply: async (id, body, key) => {
        replyKeys.push(key)
        if (failReplyWithPow) throw new ApiError('PoW rejected', 428, 'pow_expired')
        return { id: 25n, conversationId: id, sender: 1, createdAt: 1_700_000_010_000, body }
      },
      adminChangeStatus: async (_id, _version, target) => ({ previous: 0, current: target, changed: statusChanged }),
      adminSendNotice: async (_account, _subject, _body, sourceEvent) => {
        noticeEvents.push(sourceEvent)
        if (failNotice) throw new ApiError('PoW needed', 409, 'pow_invalid')
      },
    }),
  })

  const session = new AbortController()
  controller.bindSession(session.signal)
  await flushMicrotasks()

  // System notice: pow_* failure must NOT emit sessionLost, and retrying the same form reuses the exact eventId.
  controller.setComposeNotice(true)
  controller.setRecipient(`  ${sampleAccount.toUpperCase()}  `)
  controller.setNoticeSubject('Notice title')
  controller.setNoticeBody('Important update')
  await controller.sendNotice()
  assert.equal(controller.state.failed, 'admin.inbox.m41')
  assert.equal(sessionLostErrors.length, 0)
  assert.deepEqual(noticeEvents, [101n])

  failNotice = false
  await controller.sendNotice()
  assert.deepEqual(noticeEvents, [101n, 101n])
  assert.equal(controller.state.notice, 'admin.inbox.m40')
  assert.equal(controller.state.composeNotice, false)

  // Open thread (initially status 0 -> set statusChanged=false first so thread opens as open).
  statusChanged = false
  await controller.openThread(10n)

  // Reply: pow_* failure does NOT emit sessionLost; retrying same conversation+body reuses exact idempotency key.
  controller.setReply('First support reply')
  await controller.sendReply()
  assert.equal(controller.state.failed, 'admin.inbox.m43')
  assert.equal(sessionLostErrors.length, 0)
  assert.deepEqual(replyKeys, ['uuid-1'])

  failReplyWithPow = false
  await controller.sendReply()
  assert.deepEqual(replyKeys, ['uuid-1', 'uuid-1'])
  assert.equal(controller.state.notice, 'admin.inbox.m42')
  assert.equal(controller.state.reply, '')
  assert.equal(controller.state.needsRefresh, false)

  // Status update with changed=true removes row when filtered by 'open' and reports m44.
  controller.setFilter('open')
  await flushMicrotasks()
  await controller.openThread(10n)
  statusChanged = true
  controller.setDestination(1)
  controller.setReason('Awaiting user receipt.')
  await controller.saveStatus()
  assert.equal(controller.state.notice, 'admin.inbox.m44')
  assert.equal(controller.state.thread?.conversation.status, 1)
  assert.equal(controller.state.rows.length, 0)

  // Non-pow 403/409 error invokes onSessionLost hook and preserves specific error key without auto-retry.
  controller.setDestination(2)
  controller.setReason('Close after timeout')
  const prevLen = sessionLostErrors.length
  const badTransportController = new AdminInboxController({
    hooks: { onSessionLost: err => sessionLostErrors.push(err) },
    transport: createTransport({
      adminInbox: async () => makePage([makeRow(10n)]),
      adminInboxThread: async id => makeThread(id, { readSnapshot: null }),
      adminChangeStatus: async () => { throw new ApiError('stale version', 409) },
    }),
  })
  badTransportController.bindSession(session.signal)
  await flushMicrotasks()
  await badTransportController.openThread(10n)
  badTransportController.setDestination(1)
  badTransportController.setReason('Reason')
  await badTransportController.saveStatus()
  assert.equal(badTransportController.state.failed, 'admin.inbox.m46')
  assert.equal(sessionLostErrors.length, prevLen + 1)
  assert.equal((sessionLostErrors.at(-1) as ApiError).status, 409)

  controller.dispose()
  badTransportController.dispose()
})

test('live refresh coordinates pending deferral, overlap merge, keepReadSnapshot on unreadAckFailed, exponential backoff, and non-retried 4xx', async () => {
  const clock = new FakeClock(1_000_000)
  const wakes: FakeWakeSubscription[] = []
  const sessionLostErrors: unknown[] = []
  const replyGate = deferred<{ id: bigint; conversationId: bigint; sender: 1; createdAt: number; body: string }>()
  let liveThreadMode: 'merge' | 'fail500' | 'fail403' | 'fail401' = 'merge'
  let threadFetchCount = 0
  const retainedSnapshot = { token: 'k'.repeat(64), through: 10n }

  const controller = new AdminInboxController({
    clock,
    hooks: { onSessionLost: err => sessionLostErrors.push(err) },
    transport: createTransport({
      adminInbox: async () => makePage([makeRow(7n)]),
      adminInboxThread: async (id, before) => {
        threadFetchCount++
        if (before === 'earlier-1') {
          return makeThread(id, {
            previous: null,
            messages: [{ id: 5n, sender: 0, internal: false, at: 1_699_999_000_000, body: 'Old history msg' }],
            readSnapshot: null,
          })
        }
        if (threadFetchCount === 1) {
          return makeThread(id, {
            previous: 'earlier-1',
            version: '1',
            readSnapshot: retainedSnapshot,
          })
        }
        if (liveThreadMode === 'fail500') throw new ApiError('server busy', 503)
        if (liveThreadMode === 'fail403') throw new ApiError('forbidden', 403)
        if (liveThreadMode === 'fail401') throw new ApiError('expired', 401)
        return makeThread(id, {
          previous: 'should-be-replaced-by-current-previous',
          messages: [
            { id: 10n, sender: 0, internal: false, at: 1_700_000_000_000, body: 'Initial account message' },
            { id: 11n, sender: 1, internal: true, at: 1_700_000_001_000, body: 'Internal note' },
            { id: 12n, sender: 0, internal: false, at: 1_700_000_009_000, body: 'Live incoming message' },
          ],
          readSnapshot: { token: 'z'.repeat(64), through: 12n },
        })
      },
      acknowledgeAdminInboxRead: async () => { throw new ApiError('ack failed', 500) },
      adminReply: async () => replyGate.promise,
    }, wakes),
  })

  const session = new AbortController()
  controller.bindSession(session.signal)
  await flushMicrotasks()

  // Open thread (ack fails -> unreadAckFailed=true) and load earlier history page.
  await controller.openThread(7n)
  assert.equal(controller.state.unreadAckFailed, true)
  await controller.openThread(7n, 'earlier-1')
  assert.deepEqual(controller.state.thread?.messages.map(m => m.id), [5n, 10n, 11n])
  const live = wakes.at(-1)!
  assert.equal(live.scope, 7n)

  // Trigger wake while a reply is pending: live refresh must wait until pending clears.
  const fetchesBeforePending = threadFetchCount
  controller.setReply('In-flight admin reply')
  const replyPromise = controller.sendReply()
  assert.equal(controller.state.pending, true)
  live.wake()
  await flushMicrotasks()
  assert.equal(threadFetchCount, fetchesBeforePending)

  // Complete reply (also refreshes thread), then trigger another wake to verify merge + keepReadSnapshot.
  replyGate.resolve({ id: 13n, conversationId: 7n, sender: 1, createdAt: 1_700_000_010_000, body: 'In-flight admin reply' })
  await replyPromise
  await flushMicrotasks()
  // Live wake while unreadAckFailed=true merges overlapping earlier messages AND preserves retainedSnapshot!
  assert.equal(controller.state.unreadAckFailed, true)
  const snapshotBeforeWake = controller.state.thread?.readSnapshot
  live.wake()
  await flushMicrotasks()
  assert.deepEqual(controller.state.thread?.messages.map(m => m.id), [5n, 10n, 11n, 12n])
  assert.equal(controller.state.thread?.previous, null)
  assert.deepEqual(controller.state.thread?.readSnapshot, snapshotBeforeWake)

  // 503 triggers exponential backoff: 1s -> 2s -> 4s.
  liveThreadMode = 'fail500'
  live.wake()
  await flushMicrotasks()
  assert.deepEqual(clock.scheduledDelays, [1_000])
  clock.advance(1_000)
  await flushMicrotasks()
  assert.deepEqual(clock.scheduledDelays, [1_000, 2_000])
  clock.advance(2_000)
  await flushMicrotasks()
  assert.deepEqual(clock.scheduledDelays, [1_000, 2_000, 4_000])

  // Recovery resets backoff to 1s.
  liveThreadMode = 'merge'
  clock.advance(4_000)
  await flushMicrotasks()
  assert.equal(clock.activeTimerCount, 0)

  // 403 does NOT schedule retries.
  liveThreadMode = 'fail403'
  const delaysBefore403 = clock.scheduledDelays.length
  live.wake()
  await flushMicrotasks()
  assert.equal(clock.scheduledDelays.length, delaysBefore403)
  assert.equal(clock.activeTimerCount, 0)

  // 401 invokes onSessionLost and does NOT retry.
  liveThreadMode = 'fail401'
  const lostBefore401 = sessionLostErrors.length
  live.wake()
  await flushMicrotasks()
  assert.equal(sessionLostErrors.length, lostBefore401 + 1)
  assert.equal((sessionLostErrors.at(-1) as ApiError).status, 401)
  assert.equal(clock.activeTimerCount, 0)

  controller.dispose()
})

test('cross-session isolation, explicit cancel, and idempotent dispose block stale wake, timers, and late responses', async () => {
  const clock = new FakeClock(1_000_000)
  const wakes: FakeWakeSubscription[] = []
  const sessionLostErrors: unknown[] = []
  const staleQueueGate = deferred<AdminInboxPage>()
  let activeSession = 'A'

  const controller = new AdminInboxController({
    clock,
    hooks: { onSessionLost: err => sessionLostErrors.push(err) },
    transport: createTransport({
      adminInbox: async (_filter, _cursor, _signal, shared) => {
        if (activeSession === 'A') {
          if (shared) return makePage([makeRow(1n, { subject: 'Session A ticket' })])
          return makePage([makeRow(1n, { subject: 'Session A ticket' })])
        }
        if (activeSession === 'A-late') return staleQueueGate.promise
        return makePage([makeRow(99n, { subject: 'Session B ticket' })], { sharedAvailable: false })
      },
    }, wakes),
  })

  const sessionA = new AbortController()
  controller.bindSession(sessionA.signal)
  await flushMicrotasks()
  assert.equal(wakes.length, 1)
  const wakeA = wakes[0]!

  // Start a slow refresh in session A, then switch to session B.
  activeSession = 'A-late'
  const staleLoad = controller.loadQueue()

  activeSession = 'B'
  const sessionB = new AbortController()
  controller.bindSession(sessionB.signal)
  await flushMicrotasks()
  assert.equal(wakeA.signal.aborted, true)
  assert.deepEqual(controller.state.rows.map(r => r.id), [99n])

  // Old session A wake, onRevoked, abort, and late queue resolution must NOT touch session B!
  wakeA.wake()
  wakeA.onRevoked()
  sessionA.abort()
  staleQueueGate.resolve(makePage([makeRow(1n, { subject: 'Stale A' })]))
  await staleLoad
  await flushMicrotasks()
  assert.deepEqual(controller.state.rows.map(r => r.id), [99n])
  assert.equal(sessionLostErrors.length, 0)

  // Explicit cancel stops active live subscription without destroying controller.
  const wakeB = wakes.at(-1)!
  assert.equal(wakeB.signal.aborted, false)
  controller.cancel()
  assert.equal(wakeB.signal.aborted, true)
  assert.equal(controller.state.pending, false)

  // Reloading resumes live; then dispose() is idempotent and clears all timers/subscriptions.
  await controller.loadQueue()
  const wakeB2 = wakes.at(-1)!
  assert.equal(wakeB2.signal.aborted, false)
  controller.dispose()
  controller.dispose()
  controller.dispose()
  assert.equal(wakeB2.signal.aborted, true)
  assert.equal(clock.activeTimerCount, 0)
  assert.equal(controller.state.rows.length, 0)

  // Stale wake/revoked callbacks after dispose do nothing.
  wakeB2.wake()
  wakeB2.onRevoked()
  clock.advance(60_000)
  assert.equal(sessionLostErrors.length, 0)
})

test('toggle collapse/expand, queue live 429 retry + focus hook, unchanged status m45, and invalid destination pruning', async () => {
  const clock = new FakeClock(2_000_000)
  const wakes: FakeWakeSubscription[] = []
  let queueMode: 'ok' | 'rate429' | 'conflict409' = 'ok'
  let queueFocusBefore = 0
  let queueFocusAfter = 0
  let threadFocusAfter = 0
  let threadStatus: 0 | 2 = 0

  const controller = new AdminInboxController({
    clock,
    hooks: {
      onBeforeApplyLiveQueuePage: () => {
        queueFocusBefore++
        return () => { queueFocusAfter++ }
      },
      onBeforeApplyLatestThread: () => () => { threadFocusAfter++ },
    },
    transport: createTransport({
      adminInbox: async () => {
        if (queueMode === 'rate429') throw new ApiError('slow down', 429)
        if (queueMode === 'conflict409') throw new ApiError('conflict', 409)
        return makePage([makeRow(20n, { subject: 'Live queue item' })], { sharedAvailable: false })
      },
      adminInboxThread: async id => makeThread(id, {
        conversation: makeRow(id, { status: threadStatus }),
        readSnapshot: null,
      }),
      adminChangeStatus: async (_id, _version, target) => ({ previous: target, current: target, changed: false }),
    }, wakes),
  })

  const session = new AbortController()
  controller.bindSession(session.signal)
  await flushMicrotasks()
  const queueWake = wakes[0]!
  assert.equal(queueWake.scope, '')

  // 429 retries after 1s; once recovered, invokes queue focus hook.
  queueMode = 'rate429'
  queueWake.wake()
  await flushMicrotasks()
  assert.deepEqual(clock.scheduledDelays, [1_000])
  queueMode = 'ok'
  clock.advance(1_000)
  await flushMicrotasks()
  assert.equal(queueFocusBefore, 1)
  assert.equal(queueFocusAfter, 1)

  // 409 does NOT schedule retry.
  queueMode = 'conflict409'
  queueWake.wake()
  await flushMicrotasks()
  assert.equal(clock.activeTimerCount, 0)

  // Toggle collapse stops live wake and clears rows; toggle expand reloads with reset filter/order.
  queueMode = 'ok'
  controller.toggle()
  assert.equal(controller.state.expanded, false)
  assert.equal(controller.state.rows.length, 0)
  assert.equal(queueWake.signal.aborted, true)
  controller.toggle()
  await flushMicrotasks()
  assert.equal(controller.state.expanded, true)
  assert.equal(controller.state.rows.length, 1)

  // Unchanged status reports m45; live update closing conversation prunes invalid destination=1.
  await controller.openThread(20n)
  controller.setDestination(1)
  controller.setReason('Confirming current state')
  await controller.saveStatus()
  assert.equal(controller.state.notice, 'admin.inbox.m45')

  controller.setDestination(1)
  threadStatus = 2
  const threadWake = wakes.at(-1)!
  threadWake.wake()
  await flushMicrotasks()
  assert.equal(controller.state.thread?.conversation.status, 2)
  assert.equal(controller.state.destination, undefined)
  assert(threadFocusAfter >= 1)

  controller.dispose()
})
