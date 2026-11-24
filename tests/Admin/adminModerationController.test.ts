import { strict as assert } from 'node:assert'
import test, { type TestContext } from 'node:test'
import { ApiError } from '../../src/Contracts/aeds.ts'
import type { AdminCommentCursor, AdminCommentQueue } from '../../src/Contracts/admin-identity.ts'
import type { AdminModerationClaim } from '../../src/Contracts/admin-moderation.ts'
import type { CommentRevisionPage, ModerationTimeline } from '../../src/Contracts/comment-moderation-timeline.ts'
import { WireLimits } from '../../src/Contracts/wire.generated.ts'
import {
  AdminModerationController,
  moderationCoordinate,
  type AdminModerationControllerOptions,
  type AdminModerationTransport,
} from '../../src/Web/src/admin/adminModerationController.ts'
import { MAX_TIMEOUT_MS } from '../../src/Web/src/admin/adminOperationCoordinator.ts'
import { bindAndFlush, expectFields, FakeClock, flushMicrotasks } from './controllerSession.ts'

const defaultTarget: AdminCommentCursor = { articleId: 10, commentId: 100n }

const makeQueue = (count = 3, batchEnabled = true, next: AdminCommentCursor | null = null): AdminCommentQueue => ({
  batchEnabled,
  next,
  comments: Array.from({ length: count }, (_, index) => ({
    articleId: 10 + index, commentId: BigInt(100 + index), createdAt: 1_700_000_000_000 + index * 1000,
    displayName: `Reader ${index + 1}`, body: `Pending comment ${index + 1}`,
  })),
})

const makeClaim = (target: AdminCommentCursor, expiresAt: number, overrides: Partial<AdminModerationClaim> = {}): AdminModerationClaim => ({
  articleId: target.articleId, commentId: target.commentId, commentVersion: 1n, claimToken: 'a'.repeat(43),
  claimGeneration: 1n, claimVersion: 1n, expiresAt: BigInt(expiresAt), ...overrides,
})

async function boundModeration(
  t: TestContext,
  overrides: Partial<AdminModerationTransport> = {},
  options: Omit<AdminModerationControllerOptions, 'transport'> = {},
) {
  const clock = (options.clock as FakeClock | undefined) ?? new FakeClock(1_000_000)
  const lostErrors: ApiError[] = []
  const transport: AdminModerationTransport = {
    readAdminCommentQueue: async () => makeQueue(),
    claimComment: async target => makeClaim(target, 1_700_000_060_000),
    renewCommentClaim: async claim => ({ ...claim, claimVersion: claim.claimVersion + 1n, expiresAt: claim.expiresAt + 60_000n }),
    releaseCommentClaim: async () => {},
    proveAdminModerationDecision: async () => 'p'.repeat(43),
    decideComment: async () => {},
    claimModerationBatch: async targets => targets.map(target => makeClaim(target, 1_700_000_060_000)),
    proveAndDecideModerationBatch: async cmd => ({ batchId: 42n, count: cmd.rows.length }),
    readModerationTimeline: async () => ({ currentStatus: 0, deleted: false, consistent: true, events: [] }),
    readCommentRevisions: async () => ({ rows: [], next: null }),
    ...overrides,
  }
  const hooks = { onSessionLost: (err: ApiError) => { lostErrors.push(err) }, ...options.hooks }
  const controller = new AdminModerationController({ ...options, clock, hooks, transport })
  t.after(() => controller.dispose())
  const session = await bindAndFlush(controller)
  const expectState = (expected: Partial<typeof controller.state>) => expectFields(controller.state, expected)
  return { controller, clock, lostErrors, session, expectState }
}

function selectAndStartBatch(controller: AdminModerationController, rows: readonly AdminCommentCursor[]) {
  for (const row of rows) controller.select(row, true)
  return controller.startBatch()
}

test('single claim lifecycle: claim, renew preserves reason and replaces expiry timer, expire clears state, and release cancels timer', async t => {
  const clock = new FakeClock(1_000_000)
  const firstClaim = makeClaim(defaultTarget, clock.now() + 30_000, { claimToken: 'A'.repeat(43), claimVersion: 1n })
  const renewedClaim = makeClaim(defaultTarget, clock.now() + 90_000, { claimToken: 'A'.repeat(43), claimVersion: 2n })
  let secondClaim!: AdminModerationClaim
  let claimCalls = 0
  let releaseCalls = 0

  const { controller, expectState } = await boundModeration(t, {
    claimComment: async () => ++claimCalls === 1
      ? firstClaim
      : (secondClaim = makeClaim(defaultTarget, clock.now() + 20_000, { claimToken: 'B'.repeat(43), claimGeneration: 2n })),
    renewCommentClaim: async () => renewedClaim,
    releaseCommentClaim: async () => { releaseCalls++ },
  }, { clock })
  assert.equal(controller.state.queue?.comments.length, 3)

  await controller.claimForReview(defaultTarget)
  assert.equal(controller.state.claim, firstClaim)
  assert.equal(controller.isClaimed(defaultTarget), true)
  assert.equal(clock.activeTimerCount, 1)

  controller.setReason('Verified factual context.')
  assert.equal(controller.reasonValid, true)
  await controller.renew()
  expectState({ claim: renewedClaim, reason: 'Verified factual context.' })
  assert.equal(clock.activeTimerCount, 1)

  clock.advance(40_000)
  clock.allCallbacks[0]!()
  expectState({ claim: renewedClaim, failure: '' })

  clock.advance(50_000)
  expectState({ claim: null, reason: '', failure: 'admin.moderation.m10' })
  assert.equal(clock.activeTimerCount, 0)

  await controller.claimForReview(defaultTarget)
  assert.deepEqual([controller.state.claim, clock.activeTimerCount], [secondClaim, 1])
  await controller.release()
  assert.deepEqual([releaseCalls, clock.activeTimerCount], [1, 0])
  expectState({ claim: null, notice: 'admin.moderation.m20' })

  clock.advance(60_000)
  assert.equal(controller.state.failure, '')
})

test('long lease expiry > MAX_TIMEOUT_MS reschedules accurately without premature expiry', async t => {
  const clock = new FakeClock(1_000_000)
  const longLease = makeClaim(defaultTarget, clock.now() + MAX_TIMEOUT_MS + 5_000)
  const { controller, expectState } = await boundModeration(t, { claimComment: async () => longLease }, { clock })

  await controller.claimForReview(defaultTarget)
  clock.advance(MAX_TIMEOUT_MS)
  expectState({ claim: longLease, failure: '' })
  assert.equal(clock.activeTimerCount, 1)

  clock.advance(5_000)
  expectState({ claim: null, failure: 'admin.moderation.m10' })
})

test('single decision preserves Passkey/428 failure without auto-retry, aborts submit if claim expires during step-up, and handles reload failure', async t => {
  const clock = new FakeClock(1_000_000)
  const lease = makeClaim(defaultTarget, clock.now() + 15_000)
  let proveCalls = 0
  let decideCalls = 0
  let queueLoads = 0
  const stepUpGate = Promise.withResolvers<string>()

  const { controller, expectState } = await boundModeration(t, {
    readAdminCommentQueue: async () => {
      if (++queueLoads === 2) throw new ApiError('queue reload failed', 503)
      return makeQueue()
    },
    claimComment: async () => lease,
    proveAdminModerationDecision: async () => {
      proveCalls++
      if (proveCalls === 1) throw new ApiError('MFA_PROOF_REQUIRED', 428)
      return proveCalls === 2 ? 'P'.repeat(43) : stepUpGate.promise
    },
    decideComment: async () => { decideCalls++ },
  }, { clock })

  await controller.claimForReview(defaultTarget)
  controller.setReason('Approve after verification')
  await controller.decide(1)
  assert.deepEqual([proveCalls, decideCalls], [1, 0])
  expectState({ claim: lease, reason: 'Approve after verification', failure: 'admin.moderation.m26' })

  await controller.decide(1)
  assert.deepEqual([proveCalls, decideCalls], [2, 1])
  expectState({ claim: null, notice: 'admin.moderation.m23', failure: 'admin.moderation.m25' })

  await controller.claimForReview(defaultTarget)
  controller.setReason('Reject pending check')
  const inFlight = controller.decide(2)
  assert.ok(inFlight)
  clock.advance(15_000)
  expectState({ claim: null, failure: 'admin.moderation.m10' })
  stepUpGate.resolve('Q'.repeat(43))
  await inFlight
  assert.equal(decideCalls, 1)
  expectState({ busy: false, failure: 'admin.moderation.m10' })
})

test('single conflicts (404/409) and 401/403 enforce exact moderation semantics', async t => {
  const clock = new FakeClock(1_000_000)
  const lease = makeClaim(defaultTarget, clock.now() + 60_000)
  let mode: 'claim409' | 'renew409' | 'release403' | 'load401' = 'claim409'

  const { controller, lostErrors, expectState } = await boundModeration(t, {
    readAdminCommentQueue: async () => {
      if (mode === 'load401') throw new ApiError('unauthorized', 401)
      return makeQueue()
    },
    claimComment: async () => {
      if (mode === 'claim409') throw new ApiError('already claimed', 409)
      return lease
    },
    renewCommentClaim: async () => { throw new ApiError('stale claim', 409) },
    releaseCommentClaim: async () => { throw new ApiError('forbidden', 403) },
  }, { clock })

  await controller.claimForReview(defaultTarget)
  expectState({ failure: 'admin.moderation.m17', claim: null })

  mode = 'renew409'
  await controller.claimForReview(defaultTarget)
  await controller.renew()
  expectState({ claim: null, failure: 'admin.moderation.m22' })

  mode = 'release403'
  await controller.claimForReview(defaultTarget)
  await controller.release()
  expectState({ claim: null, queue: null, failure: 'admin.moderation.m11' })
  assert.equal(lostErrors.length, 0)

  mode = 'load401'
  await controller.load()
  assert.deepEqual([lostErrors.length, lostErrors[0]!.status], [1, 401])
  expectState({ queue: null, failure: '' })
})

test('batch lifecycle: selection bounds, earliest expiry, partial release failures, batch conflicts (m63 & m64), and batch decision', async t => {
  const clock = new FakeClock(1_000_000)
  const queue = makeQueue(4, true)
  const focusChecks: boolean[] = []
  const releasedIds: bigint[] = []
  let batchClaimMode: 'ok' | 'conflict' = 'conflict'
  let releaseFailId: bigint | null = null
  let releaseConflictId: bigint | null = null
  let decideBatchMode: 'ok' | 'conflict' | 'stepup428' = 'conflict'

  const { controller, expectState } = await boundModeration(t, {
    readAdminCommentQueue: async () => queue,
    claimModerationBatch: async targets => {
      if (batchClaimMode === 'conflict') throw new ApiError('conflict', 409, 'moderation_batch_conflicts:00002')
      return targets.map((target, index) => makeClaim(target, clock.now() + (index === 0 ? 40_000 : 15_000)))
    },
    releaseCommentClaim: async claim => {
      releasedIds.push(claim.commentId)
      if (releaseConflictId === claim.commentId) throw new ApiError('already expired', 404)
      if (releaseFailId === claim.commentId) throw new ApiError('temporary error', 500)
    },
    proveAndDecideModerationBatch: async cmd => {
      if (decideBatchMode === 'stepup428') throw new ApiError('MFA_PROOF_REQUIRED', 428)
      if (decideBatchMode === 'conflict') throw new ApiError('conflict', 409, 'moderation_batch_conflicts:00003')
      return { batchId: 99n, count: cmd.rows.length }
    },
  }, { clock, hooks: { onBatchClaimed: isActive => { focusChecks.push(isActive()) } } })
  const firstTwo = queue.comments.slice(0, 2)
  const firstTwoIds = firstTwo.map(c => c.commentId)

  controller.select(queue.comments[0]!, true)
  assert.deepEqual([controller.state.selected.size, controller.startBatch()], [1, undefined])

  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  expectState({ batchClaims: null, failure: { key: 'admin.moderation.m63', conflicts: [queue.comments[1]!] } })

  batchClaimMode = 'ok'
  await controller.startBatch()
  assert.equal(controller.state.batchClaims?.length, 2)
  assert.equal(controller.batchExpiry, clock.now() + 15_000)
  assert.deepEqual(focusChecks, [true])
  assert.equal(clock.activeTimerCount, 1)

  clock.advance(15_000)
  expectState({ batchClaims: null, failure: 'admin.moderation.m27' })
  assert.equal(controller.state.selected.size, 0)

  for (const [conflictId, failId, notice, failure] of [
    [firstTwoIds[0]!, null, 'admin.moderation.m29', ''],
    [null, firstTwoIds[0]!, '', 'admin.moderation.m30'],
  ] as const) {
    await selectAndStartBatch(controller, firstTwo)
    releaseConflictId = conflictId
    releaseFailId = failId
    releasedIds.length = 0
    await controller.cancelBatch()
    assert.deepEqual(releasedIds, firstTwoIds)
    expectState({ notice, failure })
  }

  await selectAndStartBatch(controller, firstTwo)
  controller.setBatchReason('Batch policy decision')
  decideBatchMode = 'stepup428'
  await controller.decideBatch(1)
  assert.equal(controller.state.batchClaims?.length, 2)
  expectState({ batchReason: 'Batch policy decision', failure: 'admin.moderation.m31' })

  decideBatchMode = 'conflict'
  releaseFailId = firstTwoIds[1]!
  releasedIds.length = 0
  await controller.decideBatch(1)
  assert.deepEqual([controller.state.batchClaims, releasedIds], [null, firstTwoIds])
  const conflictFailure = controller.state.failure as { key: string; conflicts: readonly AdminCommentCursor[] }
  assert.equal(typeof conflictFailure, 'object')
  assert.equal(conflictFailure.key, 'admin.moderation.m64')
  assert.equal(conflictFailure.conflicts.length, 2)

  releaseFailId = null
  decideBatchMode = 'ok'
  await selectAndStartBatch(controller, queue.comments.slice(2, 4))
  controller.setBatchReason('Reject spam batch')
  await controller.decideBatch(2)
  expectState({ batchClaims: null, notice: { key: 'admin.moderation.m66', params: { count: 2 } }, failure: '' })
})

test('stale requests, stale timers, cancellation, and cross-session responses never mutate new state or release new claims', async t => {
  const clock = new FakeClock(1_000_000)
  const queueA = makeQueue(2, true)
  const queueB: AdminCommentQueue = {
    batchEnabled: true,
    next: null,
    comments: [
      { articleId: 90, commentId: 901n, createdAt: 1_700_000_000_000, displayName: 'B1', body: 'Session B one' },
      { articleId: 91, commentId: 902n, createdAt: 1_700_000_001_000, displayName: 'B2', body: 'Session B two' },
    ],
  }
  const staleClaimGate = Promise.withResolvers<AdminModerationClaim>()
  const staleReleaseGate = Promise.withResolvers<void>()
  const releasedTokens: string[] = []
  let activeSession = 'A'

  const { controller, lostErrors, session: sessionA, expectState } = await boundModeration(t, {
    readAdminCommentQueue: async () => (activeSession === 'A' ? queueA : queueB),
    claimComment: async target => activeSession === 'A'
      ? staleClaimGate.promise
      : makeClaim(target, clock.now() + 50_000, { claimToken: 'N'.repeat(43) }),
    claimModerationBatch: async targets => targets.map((item, i) =>
      makeClaim(item, clock.now() + 30_000, { claimToken: `S${i}`.padEnd(43, 'X') })),
    releaseCommentClaim: async claim => {
      releasedTokens.push(claim.claimToken)
      if (claim.claimToken.startsWith('S0')) return staleReleaseGate.promise
    },
  }, { clock })
  const staleClaimRun = controller.claimForReview(queueA.comments[0]!)

  activeSession = 'B'
  await bindAndFlush(controller)
  assert.equal(controller.state.queue?.comments[0]?.articleId, 90)
  await controller.claimForReview(queueB.comments[0]!)
  const sessionBClaim = controller.state.claim!
  assert.equal(sessionBClaim.commentId, 901n)

  staleClaimGate.resolve(makeClaim(queueA.comments[0]!, clock.now() + 5_000, { claimToken: 'O'.repeat(43) }))
  sessionA.abort()
  await staleClaimRun
  assert.deepEqual([controller.state.claim, lostErrors.length], [sessionBClaim, 0])

  activeSession = 'A'
  await bindAndFlush(controller)
  await selectAndStartBatch(controller, queueA.comments)
  releasedTokens.length = 0

  const cancelBatchRun = controller.cancelBatch()
  await flushMicrotasks()
  assert.equal(releasedTokens.length, 1)

  activeSession = 'B'
  await bindAndFlush(controller)
  await controller.claimForReview(queueB.comments[1]!)
  const sessionDClaim = controller.state.claim!

  staleReleaseGate.resolve()
  await cancelBatchRun
  assert.equal(releasedTokens.length, 1)
  expectState({ claim: sessionDClaim, notice: '', failure: '' })

  const notificationsAfterDispose: number[] = []
  controller.dispose()
  controller.subscribe(() => notificationsAfterDispose.push(1))
  controller.dispose()
  controller.dispose()
  clock.advance(120_000)
  assert.deepEqual([clock.activeTimerCount, notificationsAfterDispose], [0, []])
  expectState({ claim: null, queue: null })
})

test('history channel runs independently, cancels stale coordinate responses, and handles 404/401 accurately', async t => {
  const timelineGate = Promise.withResolvers<ModerationTimeline>()
  const revisionGate = Promise.withResolvers<CommentRevisionPage>()
  let timelineCalls = 0
  const historyResponse = <T>(comment: string, pending: Promise<T>): Promise<T> => {
    if (comment === '100') return pending
    throw new ApiError(comment === '404' ? 'missing' : 'expired', comment === '404' ? 404 : 401)
  }

  const { controller, lostErrors, expectState } = await boundModeration(t, {
    readModerationTimeline: async (_article, comment) => { timelineCalls++; return historyResponse(comment, timelineGate.promise) },
    readCommentRevisions: async (_article, comment) => historyResponse(comment, revisionGate.promise),
  })

  const firstHistory = controller.openCommentHistory(defaultTarget)
  expectState({ historyDialogOpen: true, historyLoading: true })

  controller.setHistoryComment('404')
  expectState({ historyLoading: false, history: null })
  await controller.loadHistoryAndRevisions()
  assert.equal(controller.state.historyError, 'admin.moderation.m13')

  timelineGate.resolve({ currentStatus: 1, deleted: false, consistent: true, events: [] })
  revisionGate.resolve({ rows: [], next: null })
  await firstHistory
  expectState({ history: null, historyError: 'admin.moderation.m13' })

  controller.setHistoryComment('401')
  await controller.loadHistoryAndRevisions()
  assert.deepEqual([timelineCalls, lostErrors.length, lostErrors[0]!.status], [3, 1, 401])
  expectState({ historyDialogOpen: false, queue: null })
})

test('selection enforces WireLimits.AdminModerationBatchCount upper cap', async t => {
  const count = WireLimits.AdminModerationBatchCount + 2
  const queue = makeQueue(count, true)
  const { controller } = await boundModeration(t, { readAdminCommentQueue: async () => queue })

  for (const row of queue.comments) controller.select(row, true)
  assert.equal(controller.state.selected.size, WireLimits.AdminModerationBatchCount)
  assert.equal(controller.state.selected.has(moderationCoordinate(queue.comments[count - 1]!)), false)

  controller.select(queue.comments[0]!, false)
  assert.equal(controller.state.selected.size, WireLimits.AdminModerationBatchCount - 1)
})

test('already-expired claim expires immediately, explicit cancel frees channel, and 401/403 during batch release stops remaining releases', async t => {
  const clock = new FakeClock(2_000_000)
  const queue = makeQueue(3, true)
  const releasedIds: bigint[] = []
  const slowClaim = Promise.withResolvers<AdminModerationClaim>()
  let claimCall = 0
  let batchReleaseErrorStatus: 401 | 403 = 403

  const { controller, lostErrors, expectState } = await boundModeration(t, {
    readAdminCommentQueue: async () => queue,
    claimComment: async target => {
      claimCall++
      if (claimCall === 1) return makeClaim(target, clock.now() - 1)
      return claimCall === 2 ? slowClaim.promise : makeClaim(target, clock.now() + 30_000, { claimToken: 'F'.repeat(43) })
    },
    claimModerationBatch: async targets => targets.map(item => makeClaim(item, clock.now() + 30_000)),
    releaseCommentClaim: async claim => {
      releasedIds.push(claim.commentId)
      if (releasedIds.length === 1) throw new ApiError('denied', batchReleaseErrorStatus)
    },
  }, { clock })

  await controller.claimForReview(queue.comments[0]!)
  expectState({ claim: null, failure: 'admin.moderation.m10' })
  assert.equal(clock.activeTimerCount, 0)

  const cancelledRun = controller.claimForReview(queue.comments[0]!)
  assert.equal(controller.state.busy, true)
  controller.cancel()
  assert.equal(controller.state.busy, false)

  await controller.claimForReview(queue.comments[1]!)
  const activeClaim = controller.state.claim!
  assert.equal(activeClaim.commentId, queue.comments[1]!.commentId)
  slowClaim.resolve(makeClaim(queue.comments[0]!, clock.now() + 10_000, { claimToken: 'S'.repeat(43) }))
  await cancelledRun
  assert.deepEqual(controller.state.claim, activeClaim)

  for (const status of [403, 401] as const) {
    await bindAndFlush(controller)
    await selectAndStartBatch(controller, queue.comments.slice(0, 2))
    releasedIds.length = 0
    batchReleaseErrorStatus = status
    await controller.cancelBatch()
    assert.equal(releasedIds.length, 1)
    if (status === 403) {
      expectState({ queue: null, failure: 'admin.moderation.m11' })
      assert.equal(lostErrors.length, 0)
    } else {
      assert.deepEqual([lostErrors.length, lostErrors[0]!.status], [1, 401])
    }
  }
})
