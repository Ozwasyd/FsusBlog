import { strict as assert } from 'node:assert'
import test, { type TestContext } from 'node:test'
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
  type AdminInboxControllerOptions,
  type AdminInboxTransport,
} from '../../src/Web/src/admin/adminInboxController.ts'
import { createInboxTimeFormatter, inboxBubbleVariant, inboxStatusTagType } from '../../src/Web/src/inboxPresentation.ts'
import { bindAndFlush, expectFields, FakeClock, flushMicrotasks } from './controllerSession.ts'

interface FakeWakeSubscription {
  readonly scope: bigint | AdminInboxLiveStatus
  readonly signal: AbortSignal
  readonly wake: () => void
  readonly onRevoked: () => void
}

const sampleAccount = '11111111-2222-3333-4444-555555555555'

const makeRow = (id: bigint, overrides: Partial<AdminInboxRow> = {}): AdminInboxRow => ({
  id, account: sampleAccount, subject: `Ticket #${id}`, status: 0, system: false,
  updated: 1_700_000_000_000, unread: 2, ...overrides,
})

const makePage = (rows: AdminInboxRow[], overrides: Partial<AdminInboxPage> = {}): AdminInboxPage => ({
  rows, next: null, noticesEnabled: true, sharedAvailable: true, activityAvailable: true, liveEnabled: true, ...overrides,
})

const makeThread = (id: bigint, overrides: Partial<AdminInboxThread> = {}): AdminInboxThread => ({
  conversation: makeRow(id),
  messages: [
    { id: 10n, sender: 0, internal: false, at: 1_700_000_000_000, body: 'Initial account message' },
    { id: 11n, sender: 1, internal: true, at: 1_700_000_001_000, body: 'Internal note' },
  ],
  previous: null, repliesEnabled: true, liveEnabled: true, version: '1',
  readSnapshot: { token: 'r'.repeat(64), through: 10n }, ...overrides,
})

function setupInbox(
  t: TestContext,
  options: Omit<AdminInboxControllerOptions, 'transport'> = {},
  overrides: Partial<AdminInboxTransport> = {},
) {
  const wakes: FakeWakeSubscription[] = []
  const sessionLost: unknown[] = []
  const transport: AdminInboxTransport = {
    adminInbox: async () => makePage([makeRow(1n), makeRow(2n)]),
    adminInboxThread: async id => makeThread(id),
    acknowledgeAdminInboxRead: async () => 0,
    adminReply: async (id, body) => ({ id: 20n, conversationId: id, sender: 1, createdAt: 1_700_000_005_000, body }),
    adminChangeStatus: async (_id, _version, target) => ({ previous: 0, current: target, changed: target !== 0 }),
    adminSendNotice: async () => ({}),
    watchAdminInboxWake: (scope, signal, wake, onRevoked) => { wakes.push({ scope, signal, wake, onRevoked }) },
    ...overrides,
  }
  const hooks = { onSessionLost: (err: unknown) => { sessionLost.push(err) }, ...options.hooks }
  const controller = new AdminInboxController({ ...options, hooks, transport })
  t.after(() => controller.dispose())
  return { controller, wakes, sessionLost }
}

const triggerWake = async (sub: FakeWakeSubscription) => { sub.wake(); await flushMicrotasks() }
const advanceAndFlush = async (clock: FakeClock, ms: number) => { clock.advance(ms); await flushMicrotasks() }
const rowIds = (controller: AdminInboxController) => controller.state.rows.map(r => r.id)
const messageIds = (controller: AdminInboxController) => controller.state.thread?.messages.map(m => m.id)
const setFilter = async (controller: AdminInboxController, filter: AdminInboxFilter) => {
  controller.setFilter(filter)
  await flushMicrotasks()
}
const saveStatus = (controller: AdminInboxController, destination: 0 | 1 | 2, reason: string) => {
  controller.setDestination(destination)
  controller.setReason(reason)
  return controller.saveStatus()
}

test('queue auto-upgrades to shared read, disables live on pagination, and preserves capabilities across filter/order switches', async t => {
  const queueCalls: Array<{ filter: AdminInboxFilter; cursor: string | null; shared: boolean | undefined; order: AdminInboxOrder | undefined }> = []
  const { controller, wakes } = setupInbox(t, {}, {
    adminInbox: async (filter, cursor, _signal, shared, order) => {
      queueCalls.push({ filter, cursor, shared, order })
      if (cursor === 'next-cursor') return makePage([makeRow(3n)], { next: null, liveEnabled: true })
      return makePage([makeRow(1n, { unread: shared ? 2 : null })], { next: 'next-cursor' })
    },
  })

  await bindAndFlush(controller)
  assert.deepEqual(queueCalls.map(c => c.shared), [false, true])
  expectFields(controller.state, { sharedRead: true, activityAvailable: true, queueLive: true })
  assert.equal(controller.liveScope(), '')
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0]!.scope, '')

  await controller.loadQueue('next-cursor')
  assert.equal(controller.state.rows.length, 2)
  assert.equal(controller.state.queueLive, false)
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes[0]!.signal.aborted, true)

  await setFilter(controller, 'unread')
  expectFields(queueCalls.at(-1)!, { filter: 'unread', shared: true })
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes.length, 1)

  await setFilter(controller, 'open')
  assert.equal(controller.liveScope(), 'open')
  assert.equal(wakes.length, 2)
  assert.equal(wakes[1]!.scope, 'open')

  controller.setOrder('activity')
  await flushMicrotasks()
  assert.equal(controller.liveScope(), undefined)
  assert.equal(wakes[1]!.signal.aborted, true)
})

test('thread open, earlier messages prepend, read acknowledgement failure + retry, and unread filter removal preserve exact semantics', async t => {
  let ackAttempts = 0
  const ackSnapshots: string[] = []
  let openedHooks = 0
  let closedHooks = 0
  const snapshotToken = 's'.repeat(64)

  const { controller, wakes, sessionLost } = setupInbox(t, {
    hooks: {
      onSessionLost: err => sessionLost.push(err),
      onThreadOpened: () => { openedHooks++ },
      onThreadClosed: () => { closedHooks++ },
    },
  }, {
    adminInbox: async filter => makePage([makeRow(5n, { unread: 1 }), makeRow(6n, { unread: 3 })], { liveEnabled: filter !== 'unread' }),
    adminInboxThread: async (id, before) => before === 'prev-page'
      ? makeThread(id, {
        previous: null, readSnapshot: null,
        messages: [{ id: 8n, sender: 0, internal: false, at: 1_699_999_999_000, body: 'Earlier message' }],
      })
      : makeThread(id, { previous: 'prev-page', readSnapshot: { token: snapshotToken, through: 10n } }),
    acknowledgeAdminInboxRead: async (_id, snapshot) => {
      ackAttempts++
      ackSnapshots.push(snapshot.token)
      if (ackAttempts === 1) throw new ApiError('temporary ack error', 503)
      return 0
    },
  })

  await bindAndFlush(controller)
  await setFilter(controller, 'unread')

  await controller.openThread(5n)
  assert.deepEqual([openedHooks, ackAttempts, sessionLost.length], [1, 1, 1])
  assert.equal(controller.liveScope(), 5n)
  expectFields(controller.state, { unreadAckFailed: true, failed: '' })
  assert.equal(controller.state.thread?.readSnapshot?.token, snapshotToken)
  const threadWake = wakes.at(-1)!
  assert.equal(threadWake.scope, 5n)

  await controller.openThread(5n, 'prev-page')
  assert.deepEqual(messageIds(controller), [8n, 10n, 11n])
  assert.equal(controller.state.thread?.readSnapshot?.token, snapshotToken)
  assert.equal(wakes.length, 2)
  assert.equal(threadWake.signal.aborted, false)

  await controller.retryRead()
  assert.deepEqual(ackSnapshots, [snapshotToken, snapshotToken])
  assert.equal(controller.state.unreadAckFailed, false)
  assert.equal(controller.state.thread?.readSnapshot, null)
  assert.equal(controller.state.thread?.conversation.unread, 0)
  assert.deepEqual(rowIds(controller), [6n])

  controller.closeThread()
  assert.equal(closedHooks, 1)
  assert.equal(threadWake.signal.aborted, true)
})

test('reply, status change, and system notice preserve idempotency keys, PoW error isolation, and status transition rules', async t => {
  let uuidCounter = 0
  let eventCounter = 100n
  const replyKeys: string[] = []
  const noticeEvents: bigint[] = []
  let failReplyWithPow = true
  let failNotice = true
  let statusChanged = true

  const { controller, sessionLost } = setupInbox(t, {
    idGenerator: { randomUuid: () => `uuid-${++uuidCounter}`, newNoticeEventId: () => ++eventCounter },
  }, {
    adminInbox: async () => makePage([makeRow(10n, { status: 0 })]),
    adminInboxThread: async id => makeThread(id, { conversation: makeRow(id, { status: statusChanged ? 1 : 0 }), version: '2', readSnapshot: null }),
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
  })

  const session = await bindAndFlush(controller)

  controller.setComposeNotice(true)
  controller.setRecipient(`  ${sampleAccount.toUpperCase()}  `)
  controller.setNoticeSubject('Notice title')
  controller.setNoticeBody('Important update')
  await controller.sendNotice()
  assert.equal(controller.state.failed, 'admin.inbox.m41')
  assert.equal(sessionLost.length, 0)
  assert.deepEqual(noticeEvents, [101n])

  failNotice = false
  await controller.sendNotice()
  assert.deepEqual(noticeEvents, [101n, 101n])
  expectFields(controller.state, { notice: 'admin.inbox.m40', composeNotice: false })

  statusChanged = false
  await controller.openThread(10n)
  controller.setReply('First support reply')
  await controller.sendReply()
  assert.equal(controller.state.failed, 'admin.inbox.m43')
  assert.equal(sessionLost.length, 0)
  assert.deepEqual(replyKeys, ['uuid-1'])

  failReplyWithPow = false
  await controller.sendReply()
  assert.deepEqual(replyKeys, ['uuid-1', 'uuid-1'])
  expectFields(controller.state, { notice: 'admin.inbox.m42', reply: '', needsRefresh: false })

  await setFilter(controller, 'open')
  await controller.openThread(10n)
  statusChanged = true
  await saveStatus(controller, 1, 'Awaiting user receipt.')
  assert.equal(controller.state.notice, 'admin.inbox.m44')
  assert.equal(controller.state.thread?.conversation.status, 1)
  assert.equal(controller.state.rows.length, 0)

  controller.setDestination(2)
  controller.setReason('Close after timeout')
  const { controller: badTransport, sessionLost: badLost } = setupInbox(t, {}, {
    adminInbox: async () => makePage([makeRow(10n)]),
    adminInboxThread: async id => makeThread(id, { readSnapshot: null }),
    adminChangeStatus: async () => { throw new ApiError('stale version', 409) },
  })
  badTransport.bindSession(session.signal)
  await flushMicrotasks()
  await badTransport.openThread(10n)
  await saveStatus(badTransport, 1, 'Reason')
  assert.equal(badTransport.state.failed, 'admin.inbox.m46')
  assert.equal(badLost.length, 1)
  assert.equal((badLost.at(-1) as ApiError).status, 409)
})

test('live refresh coordinates pending deferral, overlap merge, keepReadSnapshot on unreadAckFailed, exponential backoff, and non-retried 4xx', async t => {
  const clock = new FakeClock(1_000_000)
  const replyGate = Promise.withResolvers<{ id: bigint; conversationId: bigint; sender: 1; createdAt: number; body: string }>()
  let liveThreadMode: 'merge' | 'fail500' | 'fail403' | 'fail401' = 'merge'
  let threadFetchCount = 0
  const retainedSnapshot = { token: 'k'.repeat(64), through: 10n }

  const { controller, wakes, sessionLost } = setupInbox(t, { clock }, {
    adminInbox: async () => makePage([makeRow(7n)]),
    adminInboxThread: async (id, before) => {
      threadFetchCount++
      if (before === 'earlier-1') {
        return makeThread(id, {
          previous: null, readSnapshot: null,
          messages: [{ id: 5n, sender: 0, internal: false, at: 1_699_999_000_000, body: 'Old history msg' }],
        })
      }
      if (threadFetchCount === 1) return makeThread(id, { previous: 'earlier-1', version: '1', readSnapshot: retainedSnapshot })
      if (liveThreadMode === 'fail500') throw new ApiError('server busy', 503)
      if (liveThreadMode === 'fail403') throw new ApiError('forbidden', 403)
      if (liveThreadMode === 'fail401') throw new ApiError('expired', 401)
      return makeThread(id, {
        previous: 'should-be-replaced-by-current-previous',
        messages: [
          ...makeThread(id).messages,
          { id: 12n, sender: 0, internal: false, at: 1_700_000_009_000, body: 'Live incoming message' },
        ],
        readSnapshot: { token: 'z'.repeat(64), through: 12n },
      })
    },
    acknowledgeAdminInboxRead: async () => { throw new ApiError('ack failed', 500) },
    adminReply: async () => replyGate.promise,
  })

  await bindAndFlush(controller)
  await controller.openThread(7n)
  assert.equal(controller.state.unreadAckFailed, true)
  await controller.openThread(7n, 'earlier-1')
  assert.deepEqual(messageIds(controller), [5n, 10n, 11n])
  const live = wakes.at(-1)!
  assert.equal(live.scope, 7n)

  const fetchesBeforePending = threadFetchCount
  controller.setReply('In-flight admin reply')
  const replyPromise = controller.sendReply()
  assert.equal(controller.state.pending, true)
  await triggerWake(live)
  assert.equal(threadFetchCount, fetchesBeforePending)

  replyGate.resolve({ id: 13n, conversationId: 7n, sender: 1, createdAt: 1_700_000_010_000, body: 'In-flight admin reply' })
  await replyPromise
  await flushMicrotasks()
  assert.equal(controller.state.unreadAckFailed, true)
  const snapshotBeforeWake = controller.state.thread?.readSnapshot
  await triggerWake(live)
  assert.deepEqual(messageIds(controller), [5n, 10n, 11n, 12n])
  assert.equal(controller.state.thread?.previous, null)
  assert.deepEqual(controller.state.thread?.readSnapshot, snapshotBeforeWake)

  liveThreadMode = 'fail500'
  await triggerWake(live)
  for (const [delay, expected] of [[1_000, [1_000]], [2_000, [1_000, 2_000]]] as const) {
    assert.deepEqual(clock.scheduledDelays, expected)
    await advanceAndFlush(clock, delay)
  }
  assert.deepEqual(clock.scheduledDelays, [1_000, 2_000, 4_000])

  liveThreadMode = 'merge'
  await advanceAndFlush(clock, 4_000)
  assert.equal(clock.activeTimerCount, 0)

  liveThreadMode = 'fail403'
  const delaysBefore403 = clock.scheduledDelays.length
  await triggerWake(live)
  assert.equal(clock.scheduledDelays.length, delaysBefore403)
  assert.equal(clock.activeTimerCount, 0)

  liveThreadMode = 'fail401'
  const lostBefore401 = sessionLost.length
  await triggerWake(live)
  assert.equal(sessionLost.length, lostBefore401 + 1)
  assert.equal((sessionLost.at(-1) as ApiError).status, 401)
  assert.equal(clock.activeTimerCount, 0)
})

test('cross-session isolation, explicit cancel, and idempotent dispose block stale wake, timers, and late responses', async t => {
  const clock = new FakeClock(1_000_000)
  const staleQueueGate = Promise.withResolvers<AdminInboxPage>()
  let activeSession = 'A'

  const { controller, wakes, sessionLost } = setupInbox(t, { clock }, {
    adminInbox: async () => {
      if (activeSession === 'A') return makePage([makeRow(1n, { subject: 'Session A ticket' })])
      if (activeSession === 'A-late') return staleQueueGate.promise
      return makePage([makeRow(99n, { subject: 'Session B ticket' })], { sharedAvailable: false })
    },
  })

  const sessionA = await bindAndFlush(controller)
  assert.equal(wakes.length, 1)
  const wakeA = wakes[0]!

  activeSession = 'A-late'
  const staleLoad = controller.loadQueue()
  activeSession = 'B'
  await bindAndFlush(controller)
  assert.equal(wakeA.signal.aborted, true)
  assert.deepEqual(rowIds(controller), [99n])

  wakeA.wake()
  wakeA.onRevoked()
  sessionA.abort()
  staleQueueGate.resolve(makePage([makeRow(1n, { subject: 'Stale A' })]))
  await staleLoad
  await flushMicrotasks()
  assert.deepEqual(rowIds(controller), [99n])
  assert.equal(sessionLost.length, 0)

  const wakeB = wakes.at(-1)!
  assert.equal(wakeB.signal.aborted, false)
  controller.cancel()
  assert.equal(wakeB.signal.aborted, true)
  assert.equal(controller.state.pending, false)

  await controller.loadQueue()
  const wakeB2 = wakes.at(-1)!
  assert.equal(wakeB2.signal.aborted, false)
  controller.dispose()
  controller.dispose()
  controller.dispose()
  assert.equal(wakeB2.signal.aborted, true)
  assert.equal(clock.activeTimerCount, 0)
  assert.equal(controller.state.rows.length, 0)

  wakeB2.wake()
  wakeB2.onRevoked()
  clock.advance(60_000)
  assert.equal(sessionLost.length, 0)
})

test('toggle collapse/expand, queue live 429 retry + focus hook, unchanged status m45, and invalid destination pruning', async t => {
  const clock = new FakeClock(2_000_000)
  let queueMode: 'ok' | 'rate429' | 'conflict409' = 'ok'
  let queueFocusBefore = 0
  let queueFocusAfter = 0
  let threadFocusAfter = 0
  let threadStatus: 0 | 2 = 0

  const { controller, wakes } = setupInbox(t, {
    clock,
    hooks: {
      onBeforeApplyLiveQueuePage: () => { queueFocusBefore++; return () => { queueFocusAfter++ } },
      onBeforeApplyLatestThread: () => () => { threadFocusAfter++ },
    },
  }, {
    adminInbox: async () => {
      if (queueMode === 'rate429') throw new ApiError('slow down', 429)
      if (queueMode === 'conflict409') throw new ApiError('conflict', 409)
      return makePage([makeRow(20n, { subject: 'Live queue item' })], { sharedAvailable: false })
    },
    adminInboxThread: async id => makeThread(id, { conversation: makeRow(id, { status: threadStatus }), readSnapshot: null }),
    adminChangeStatus: async (_id, _version, target) => ({ previous: target, current: target, changed: false }),
  })

  await bindAndFlush(controller)
  const queueWake = wakes[0]!
  assert.equal(queueWake.scope, '')

  queueMode = 'rate429'
  await triggerWake(queueWake)
  assert.deepEqual(clock.scheduledDelays, [1_000])
  queueMode = 'ok'
  await advanceAndFlush(clock, 1_000)
  assert.deepEqual([queueFocusBefore, queueFocusAfter], [1, 1])

  queueMode = 'conflict409'
  await triggerWake(queueWake)
  assert.equal(clock.activeTimerCount, 0)

  queueMode = 'ok'
  controller.toggle()
  assert.equal(controller.state.expanded, false)
  assert.equal(controller.state.rows.length, 0)
  assert.equal(queueWake.signal.aborted, true)
  controller.toggle()
  await flushMicrotasks()
  assert.equal(controller.state.expanded, true)
  assert.equal(controller.state.rows.length, 1)

  await controller.openThread(20n)
  await saveStatus(controller, 1, 'Confirming current state')
  assert.equal(controller.state.notice, 'admin.inbox.m45')

  controller.setDestination(1)
  threadStatus = 2
  await triggerWake(wakes.at(-1)!)
  assert.equal(controller.state.thread?.conversation.status, 2)
  assert.equal(controller.state.destination, undefined)
  assert(threadFocusAfter >= 1)
})

test('fine-grained channels, latest-wins thread/filter switching, non-blocking read ack, and stable version during mutations', async t => {
  const threadAGate = Promise.withResolvers<AdminInboxThread>()
  const threadBGate = Promise.withResolvers<AdminInboxThread>()
  const ackGate = Promise.withResolvers<number>()
  const filterGate = Promise.withResolvers<AdminInboxPage>()
  const refreshGate = Promise.withResolvers<AdminInboxThread>()
  const threadFetches: bigint[] = []
  let openHookCalls = 0
  let filterCallCount = 0
  let refreshMode: 'normal' | 'hold' = 'normal'

  const { controller } = setupInbox(t, { hooks: { onThreadOpened: () => { openHookCalls++ } } }, {
    adminInbox: async filter => {
      if (filter === 'pending') {
        if (++filterCallCount === 1) return filterGate.promise
        throw new ApiError('queue load failed', 503)
      }
      return makePage([makeRow(1n), makeRow(2n)])
    },
    adminInboxThread: async id => {
      threadFetches.push(id)
      if (refreshMode === 'normal' && threadFetches.filter(x => x === id).length === 1)
        return id === 1n ? threadAGate.promise : threadBGate.promise
      if (refreshMode === 'hold') return refreshGate.promise
      return makeThread(id, { version: '2', readSnapshot: null })
    },
    acknowledgeAdminInboxRead: async () => ackGate.promise,
  })

  await bindAndFlush(controller)

  const open1 = controller.openThread(1n)
  expectFields(controller.state, { threadPending: true, queuePending: false })
  const open2 = controller.openThread(2n)
  threadAGate.resolve(makeThread(1n))
  threadBGate.resolve(makeThread(2n))
  await flushMicrotasks()

  assert.equal(controller.state.thread?.conversation.id, 2n)
  expectFields(controller.state, { threadPending: false, readPending: true, replyPending: false, statusPending: false })
  ackGate.resolve(0)
  await Promise.all([open1, open2])
  assert.equal(controller.state.readPending, false)

  const [fetchesBefore, hooksBefore] = [threadFetches.length, openHookCalls]
  await controller.openThread(2n)
  assert.deepEqual([threadFetches.length, openHookCalls], [fetchesBefore, hooksBefore + 1])

  controller.setFilter('pending')
  assert.equal(controller.state.queuePending, true)
  assert.equal(controller.state.rows.length, 2)
  assert.equal(controller.state.thread?.conversation.id, 2n)
  filterGate.resolve(makePage([makeRow(2n, { status: 1 })]))
  await flushMicrotasks()
  assert.equal(controller.state.queuePending, false)
  assert.deepEqual(rowIds(controller), [2n])
  assert.equal(controller.state.thread?.conversation.id, 2n)

  refreshMode = 'hold'
  controller.setReply('Smooth non-jumping reply')
  const replyPromise = controller.sendReply()!
  await flushMicrotasks()
  expectFields(controller.state, { replyPending: true, statusPending: false, notice: 'admin.inbox.m42' })
  assert.equal(controller.state.thread?.version, '1')
  refreshGate.resolve(makeThread(2n, { version: '2', readSnapshot: null }))
  await replyPromise
  assert.equal(controller.state.replyPending, false)
  assert.equal(controller.state.thread?.version, '2')

  await setFilter(controller, 'open')
  await setFilter(controller, 'pending')
  assert.equal(controller.state.failed, 'admin.inbox.m39')
  assert.equal(controller.state.rows.length, 0)
})

test('inbox presentation maps status tags, bubble variants, and compact/full timestamps consistently', () => {
  for (const [status, expected] of [[0, 'success'], [1, 'warning'], [2, 'info'], [99, 'info']] as const)
    assert.equal(inboxStatusTagType(status), expected)
  for (const [sender, role, internal, expected] of [
    [0, 'reader', false, 'self'], [1, 'reader', false, 'other'], [2, 'reader', false, 'system'],
    [0, 'admin', false, 'other'], [1, 'admin', false, 'self'], [2, 'admin', false, 'system'],
    [1, 'admin', true, 'muted'], [2, 'admin', true, 'muted'],
  ] as const) assert.equal(inboxBubbleVariant(sender, role, internal), expected)

  const formatter = createInboxTimeFormatter('zh-CN')
  const now = new Date(2026, 10, 22, 18, 30, 0)
  const sameDay = new Date(2026, 10, 22, 9, 5, 0).getTime()
  const sameYear = new Date(2026, 4, 3, 14, 20, 0).getTime()
  const priorYear = new Date(2024, 1, 12, 8, 0, 0).getTime()
  assert.match(formatter.compact(sameDay, now), /09:05/)
  assert.doesNotMatch(formatter.compact(sameYear, now), /2026/)
  assert.match(formatter.compact(sameYear, now), /5.*3/)
  assert.match(formatter.compact(priorYear, now), /2024/)
  assert.match(formatter.full(sameDay), /2026/)
})
