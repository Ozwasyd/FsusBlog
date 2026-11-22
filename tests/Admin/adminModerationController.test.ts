import { strict as assert } from 'node:assert'
import test from 'node:test'
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
import { FakeClock } from './fakeClock.ts'
import { bindTestSession } from './controllerSession.ts'

function makeQueue(count = 3, batchEnabled = true, next: AdminCommentCursor | null = null): AdminCommentQueue {
  return {
    batchEnabled,
    next,
    comments: Array.from({ length: count }, (_, index) => ({
      articleId: 10 + index,
      commentId: BigInt(100 + index),
      createdAt: 1_700_000_000_000 + index * 1000,
      displayName: `Reader ${index + 1}`,
      body: `Pending comment ${index + 1}`,
    })),
  }
}

function makeClaim(target: AdminCommentCursor, expiresAt: number, overrides: Partial<AdminModerationClaim> = {}): AdminModerationClaim {
  return {
    articleId: target.articleId,
    commentId: target.commentId,
    commentVersion: 1n,
    claimToken: 'a'.repeat(43),
    claimGeneration: 1n,
    claimVersion: 1n,
    expiresAt: BigInt(expiresAt),
    ...overrides,
  }
}

function createController(
  options: Omit<AdminModerationControllerOptions, 'transport'>,
  overrides: Partial<AdminModerationTransport> = {},
): AdminModerationController {
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
  return new AdminModerationController({ ...options, transport })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('single claim lifecycle: claim, renew preserves reason and replaces expiry timer, expire clears state, and release cancels timer', async () => {
  const clock = new FakeClock(1_000_000)
  const target: AdminCommentCursor = { articleId: 10, commentId: 100n }
  const firstClaim = makeClaim(target, clock.now() + 30_000, { claimToken: 'A'.repeat(43), claimVersion: 1n })
  const renewedClaim = makeClaim(target, clock.now() + 90_000, { claimToken: 'A'.repeat(43), claimVersion: 2n })
  let secondClaim!: AdminModerationClaim
  let claimCalls = 0
  let releaseCalls = 0

  const controller = createController({ clock }, {
    claimComment: async () => {
      claimCalls++
      if (claimCalls === 1) return firstClaim
      secondClaim = makeClaim(target, clock.now() + 20_000, { claimToken: 'B'.repeat(43), claimGeneration: 2n })
      return secondClaim
    },
    renewCommentClaim: async () => renewedClaim,
    releaseCommentClaim: async () => { releaseCalls++ },
  })
  bindTestSession(controller)
  await flushMicrotasks()
  assert.equal(controller.state.queue?.comments.length, 3)

  // Claim succeeds and arms timer.
  await controller.claimForReview(target)
  assert.deepEqual(controller.state.claim, firstClaim)
  assert.equal(controller.isClaimed(target), true)
  assert.equal(clock.activeTimerCount, 1)

  // Reason entered before renew must be preserved after renew.
  controller.setReason('Verified factual context.')
  assert.equal(controller.reasonValid, true)
  await controller.renew()
  assert.deepEqual(controller.state.claim, renewedClaim)
  assert.equal(controller.state.reason, 'Verified factual context.')
  assert.equal(clock.activeTimerCount, 1)

  // Passing the old expiry (30s) must NOT expire the renewed lease; even forcing the stale callback must be a no-op.
  clock.advance(40_000)
  clock.allCallbacks[0]!()
  assert.deepEqual(controller.state.claim, renewedClaim)
  assert.equal(controller.state.failure, '')

  // Reaching the renewed expiry (90s total) expires the claim and clears reason.
  clock.advance(50_000)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.reason, '')
  assert.equal(controller.state.failure, 'admin.moderation.m10')
  assert.equal(clock.activeTimerCount, 0)

  // Re-claim and release cancels timer and reports release notice.
  await controller.claimForReview(target)
  assert.deepEqual(controller.state.claim, secondClaim)
  assert.equal(clock.activeTimerCount, 1)
  await controller.release()
  assert.equal(releaseCalls, 1)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.notice, 'admin.moderation.m20')
  assert.equal(clock.activeTimerCount, 0)

  // Advancing past released claim expiry produces no expiry failure.
  clock.advance(60_000)
  assert.equal(controller.state.failure, '')
  controller.dispose()
})

test('long lease expiry > MAX_TIMEOUT_MS reschedules accurately without premature expiry', async () => {
  const clock = new FakeClock(1_000_000)
  const target: AdminCommentCursor = { articleId: 10, commentId: 100n }
  const longLease = makeClaim(target, clock.now() + MAX_TIMEOUT_MS + 5_000)
  const controller = createController({ clock }, { claimComment: async () => longLease })
  bindTestSession(controller)
  await flushMicrotasks()

  await controller.claimForReview(target)
  clock.advance(MAX_TIMEOUT_MS)
  assert.deepEqual(controller.state.claim, longLease)
  assert.equal(controller.state.failure, '')
  assert.equal(clock.activeTimerCount, 1)

  clock.advance(5_000)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.failure, 'admin.moderation.m10')
  controller.dispose()
})

test('single decision preserves Passkey/428 failure without auto-retry, aborts submit if claim expires during step-up, and handles reload failure', async () => {
  const clock = new FakeClock(1_000_000)
  const target: AdminCommentCursor = { articleId: 10, commentId: 100n }
  const lease = makeClaim(target, clock.now() + 15_000)
  let proveCalls = 0
  let decideCalls = 0
  let queueLoads = 0
  const stepUpGate = Promise.withResolvers<string>()

  const controller = createController({ clock }, {
    readAdminCommentQueue: async () => {
      queueLoads++
      if (queueLoads === 2) throw new ApiError('queue reload failed', 503)
      return makeQueue()
    },
    claimComment: async () => lease,
    proveAdminModerationDecision: async () => {
      proveCalls++
      if (proveCalls === 1) throw new ApiError('MFA_PROOF_REQUIRED', 428)
      if (proveCalls === 2) return 'P'.repeat(43)
      return stepUpGate.promise
    },
    decideComment: async () => { decideCalls++ },
  })
  bindTestSession(controller)
  await flushMicrotasks()

  // 1) 428 keeps claim and reason intact, sets m26, and never auto-retries.
  await controller.claimForReview(target)
  controller.setReason('Approve after verification')
  await controller.decide(1)
  assert.equal(proveCalls, 1)
  assert.equal(decideCalls, 0)
  assert.deepEqual(controller.state.claim, lease)
  assert.equal(controller.state.reason, 'Approve after verification')
  assert.equal(controller.state.failure, 'admin.moderation.m26')

  // 2) Successful decision followed by queue reload failure preserves notice m23 and reports m25.
  await controller.decide(1)
  assert.equal(proveCalls, 2)
  assert.equal(decideCalls, 1)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.notice, 'admin.moderation.m23')
  assert.equal(controller.state.failure, 'admin.moderation.m25')

  // 3) Claim expiring while awaiting Passkey proof prevents decideComment from executing.
  await controller.claimForReview(target)
  controller.setReason('Reject pending check')
  const inFlight = controller.decide(2)
  assert.ok(inFlight)
  clock.advance(15_000)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.failure, 'admin.moderation.m10')
  stepUpGate.resolve('Q'.repeat(43))
  await inFlight
  assert.equal(decideCalls, 1)
  assert.equal(controller.state.busy, false)
  assert.equal(controller.state.failure, 'admin.moderation.m10')
  controller.dispose()
})

test('single conflicts (404/409) and 401/403 enforce exact moderation semantics', async () => {
  const clock = new FakeClock(1_000_000)
  const target: AdminCommentCursor = { articleId: 10, commentId: 100n }
  const lease = makeClaim(target, clock.now() + 60_000)
  const lostErrors: ApiError[] = []
  let mode: 'claim409' | 'renew409' | 'release403' | 'load401' = 'claim409'

  const controller = createController({
    clock,
    hooks: { onSessionLost: err => lostErrors.push(err) },
  }, {
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
  })
  bindTestSession(controller)
  await flushMicrotasks()

  // Claim 409 -> m17
  await controller.claimForReview(target)
  assert.equal(controller.state.failure, 'admin.moderation.m17')
  assert.equal(controller.state.claim, null)

  // Renew 409 -> clears claim and sets m22
  mode = 'renew409'
  await controller.claimForReview(target)
  await controller.renew()
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.failure, 'admin.moderation.m22')

  // Release 403 -> clears queue & claim, sets m11, does NOT emit sessionLost
  mode = 'release403'
  await controller.claimForReview(target)
  await controller.release()
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.queue, null)
  assert.equal(controller.state.failure, 'admin.moderation.m11')
  assert.equal(lostErrors.length, 0)

  // Load 401 -> clears review and emits sessionLost
  mode = 'load401'
  await controller.load()
  assert.equal(lostErrors.length, 1)
  assert.equal(lostErrors[0]!.status, 401)
  assert.equal(controller.state.queue, null)
  assert.equal(controller.state.failure, '')
  controller.dispose()
})

test('batch lifecycle: selection bounds, earliest expiry, partial release failures, batch conflicts (m63 & m64), and batch decision', async () => {
  const clock = new FakeClock(1_000_000)
  const queue = makeQueue(4, true)
  const focusChecks: boolean[] = []
  const releasedIds: bigint[] = []
  let batchClaimMode: 'ok' | 'conflict' = 'conflict'
  let releaseFailId: bigint | null = null
  let releaseConflictId: bigint | null = null
  let decideBatchMode: 'ok' | 'conflict' | 'stepup428' = 'conflict'

  const controller = createController({
    clock,
    hooks: { onBatchClaimed: isActive => { focusChecks.push(isActive()) } },
  }, {
    readAdminCommentQueue: async () => queue,
    claimModerationBatch: async targets => {
      if (batchClaimMode === 'conflict') {
        // Bitmask 0x00002 -> second selected item conflicted
        throw new ApiError('conflict', 409, 'moderation_batch_conflicts:00002')
      }
      return targets.map((target, index) => makeClaim(target, clock.now() + (index === 0 ? 40_000 : 15_000)))
    },
    releaseCommentClaim: async claim => {
      releasedIds.push(claim.commentId)
      if (releaseConflictId === claim.commentId) throw new ApiError('already expired', 404)
      if (releaseFailId === claim.commentId) throw new ApiError('temporary error', 500)
    },
    proveAndDecideModerationBatch: async cmd => {
      if (decideBatchMode === 'stepup428') throw new ApiError('MFA_PROOF_REQUIRED', 428)
      if (decideBatchMode === 'conflict') {
        // Bitmask 0x00003 -> both items conflicted
        throw new ApiError('conflict', 409, 'moderation_batch_conflicts:00003')
      }
      return { batchId: 99n, count: cmd.rows.length }
    },
  })
  bindTestSession(controller)
  await flushMicrotasks()

  // Selection below minimum cannot start batch.
  controller.select(queue.comments[0]!, true)
  assert.equal(controller.state.selected.size, 1)
  assert.equal(controller.startBatch(), undefined)

  // Batch claim conflict preserves exact conflicting row coordinate in m63.
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  assert.deepEqual(controller.state.failure, {
    key: 'admin.moderation.m63',
    conflicts: [queue.comments[1]!],
  })
  assert.equal(controller.state.batchClaims, null)

  // Successful batch claim uses earliest expiresAt (15s) and invokes focus hook.
  batchClaimMode = 'ok'
  await controller.startBatch()
  assert.equal(controller.state.batchClaims?.length, 2)
  assert.equal(controller.batchExpiry, clock.now() + 15_000)
  assert.deepEqual(focusChecks, [true])
  assert.equal(clock.activeTimerCount, 1)

  // Expiry at earliest lease timestamp clears batch and reports m27.
  clock.advance(15_000)
  assert.equal(controller.state.batchClaims, null)
  assert.equal(controller.state.selected.size, 0)
  assert.equal(controller.state.failure, 'admin.moderation.m27')

  // Cancel batch with 404 on first claim still succeeds (m29); 500 on one claim reports partial failure (m30) while releasing others.
  controller.select(queue.comments[0]!, true)
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  releaseConflictId = queue.comments[0]!.commentId
  releaseFailId = null
  releasedIds.length = 0
  await controller.cancelBatch()
  assert.deepEqual(releasedIds, [queue.comments[0]!.commentId, queue.comments[1]!.commentId])
  assert.equal(controller.state.notice, 'admin.moderation.m29')
  assert.equal(controller.state.failure, '')

  controller.select(queue.comments[0]!, true)
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  releaseConflictId = null
  releaseFailId = queue.comments[0]!.commentId
  releasedIds.length = 0
  await controller.cancelBatch()
  assert.deepEqual(releasedIds, [queue.comments[0]!.commentId, queue.comments[1]!.commentId])
  assert.equal(controller.state.notice, '')
  assert.equal(controller.state.failure, 'admin.moderation.m30')

  // Batch decide 428 keeps claims and reason, reports m31, no auto-retry.
  controller.select(queue.comments[0]!, true)
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  controller.setBatchReason('Batch policy decision')
  decideBatchMode = 'stepup428'
  await controller.decideBatch(1)
  assert.equal(controller.state.batchClaims?.length, 2)
  assert.equal(controller.state.batchReason, 'Batch policy decision')
  assert.equal(controller.state.failure, 'admin.moderation.m31')

  // Batch decide 409 conflict with partial release failure upgrades message to m64 while preserving conflicts.
  decideBatchMode = 'conflict'
  releaseFailId = queue.comments[1]!.commentId
  releasedIds.length = 0
  await controller.decideBatch(1)
  assert.equal(controller.state.batchClaims, null)
  assert.deepEqual(releasedIds, [queue.comments[0]!.commentId, queue.comments[1]!.commentId])
  assert.equal(typeof controller.state.failure, 'object')
  assert.equal((controller.state.failure as { key: string }).key, 'admin.moderation.m64')
  assert.equal((controller.state.failure as { conflicts: readonly AdminCommentCursor[] }).conflicts.length, 2)

  // Batch decide success clears batch and formats m66 (reject).
  releaseFailId = null
  decideBatchMode = 'ok'
  controller.select(queue.comments[2]!, true)
  controller.select(queue.comments[3]!, true)
  await controller.startBatch()
  controller.setBatchReason('Reject spam batch')
  await controller.decideBatch(2)
  assert.equal(controller.state.batchClaims, null)
  assert.deepEqual(controller.state.notice, { key: 'admin.moderation.m66', params: { count: 2 } })
  assert.equal(controller.state.failure, '')
  controller.dispose()
})

test('stale requests, stale timers, cancellation, and cross-session responses never mutate new state or release new claims', async () => {
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
  const sessionLostErrors: ApiError[] = []
  let activeSession = 'A'

  const controller = createController({
    clock,
    hooks: { onSessionLost: err => sessionLostErrors.push(err) },
  }, {
    readAdminCommentQueue: async () => (activeSession === 'A' ? queueA : queueB),
    claimComment: async target => {
      if (activeSession === 'A') return staleClaimGate.promise
      return makeClaim(target, clock.now() + 50_000, { claimToken: 'N'.repeat(43) })
    },
    claimModerationBatch: async targets => targets.map((t, i) =>
      makeClaim(t, clock.now() + 30_000, { claimToken: `S${i}`.padEnd(43, 'X') })),
    releaseCommentClaim: async claim => {
      releasedTokens.push(claim.claimToken)
      if (claim.claimToken.startsWith('S0')) return staleReleaseGate.promise
    },
  })

  const sessionA = bindTestSession(controller)
  await flushMicrotasks()

  // Session A starts claiming comment 100 (ignores abort and resolves late).
  const staleClaimRun = controller.claimForReview(queueA.comments[0]!)

  // Switch to Session B before Session A's claim returns.
  activeSession = 'B'
  bindTestSession(controller)
  await flushMicrotasks()
  assert.equal(controller.state.queue?.comments[0]?.articleId, 90)

  // Session B acquires a fresh claim on comment 901.
  await controller.claimForReview(queueB.comments[0]!)
  const sessionBClaim = controller.state.claim
  assert.ok(sessionBClaim)
  assert.equal(sessionBClaim.commentId, 901n)

  // Late response from Session A resolves and old sessionA aborts: must NOT touch Session B's claim!
  staleClaimGate.resolve(makeClaim(queueA.comments[0]!, clock.now() + 5_000, { claimToken: 'O'.repeat(43) }))
  sessionA.abort()
  await staleClaimRun
  assert.deepEqual(controller.state.claim, sessionBClaim)
  assert.equal(sessionLostErrors.length, 0)

  // Now verify cancelling mid-batch release stops remaining releases and never touches new claims.
  activeSession = 'A'
  bindTestSession(controller)
  await flushMicrotasks()
  controller.select(queueA.comments[0]!, true)
  controller.select(queueA.comments[1]!, true)
  await controller.startBatch()
  releasedTokens.length = 0

  const cancelBatchRun = controller.cancelBatch()
  await flushMicrotasks()
  assert.equal(releasedTokens.length, 1) // Only first release started

  // Switch to Session D mid-release and claim new item.
  activeSession = 'B'
  bindTestSession(controller)
  await flushMicrotasks()
  await controller.claimForReview(queueB.comments[1]!)
  const sessionDClaim = controller.state.claim!

  // Finish the first stale release from Session C: loop must stop and NOT issue second release!
  staleReleaseGate.resolve()
  await cancelBatchRun
  assert.equal(releasedTokens.length, 1)
  assert.deepEqual(controller.state.claim, sessionDClaim)
  assert.equal(controller.state.notice, '')
  assert.equal(controller.state.failure, '')

  // Idempotent dispose clears timers, stops background work, and triggers no repeat actions.
  const notificationsAfterDispose: number[] = []
  controller.dispose()
  controller.subscribe(() => notificationsAfterDispose.push(1))
  controller.dispose()
  controller.dispose()
  assert.equal(clock.activeTimerCount, 0)
  clock.advance(120_000)
  assert.deepEqual(notificationsAfterDispose, [])
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.queue, null)
})

test('history channel runs independently, cancels stale coordinate responses, and handles 404/401 accurately', async () => {
  const clock = new FakeClock(1_000_000)
  const timelineGate = Promise.withResolvers<ModerationTimeline>()
  const revisionGate = Promise.withResolvers<CommentRevisionPage>()
  const lostErrors: ApiError[] = []
  let timelineCalls = 0

  const controller = createController({
    clock,
    hooks: { onSessionLost: err => lostErrors.push(err) },
  }, {
    readModerationTimeline: async (_article, comment) => {
      timelineCalls++
      if (comment === '100') return timelineGate.promise
      if (comment === '404') throw new ApiError('missing', 404)
      throw new ApiError('expired', 401)
    },
    readCommentRevisions: async (_article, comment) => {
      if (comment === '100') return revisionGate.promise
      if (comment === '404') throw new ApiError('missing', 404)
      throw new ApiError('expired', 401)
    },
  })
  bindTestSession(controller)
  await flushMicrotasks()

  // Open history for comment 100 (in flight).
  const firstHistory = controller.openCommentHistory({ articleId: 10, commentId: 100n })
  assert.equal(controller.state.historyDialogOpen, true)
  assert.equal(controller.state.historyLoading, true)

  // Change coordinate to 404 before 100 resolves: clears history, cancels old run, allows immediate new load.
  controller.setHistoryComment('404')
  assert.equal(controller.state.historyLoading, false)
  assert.equal(controller.state.history, null)
  await controller.loadHistoryAndRevisions()
  assert.equal(controller.state.historyError, 'admin.moderation.m13')

  // Late resolution from comment 100 must NOT overwrite comment 404's error state.
  timelineGate.resolve({ currentStatus: 1, deleted: false, consistent: true, events: [] })
  revisionGate.resolve({ rows: [], next: null })
  await firstHistory
  assert.equal(controller.state.history, null)
  assert.equal(controller.state.historyError, 'admin.moderation.m13')

  // 401 on history closes dialog, clears review, and emits sessionLost.
  controller.setHistoryComment('401')
  await controller.loadHistoryAndRevisions()
  assert.equal(timelineCalls, 3)
  assert.equal(controller.state.historyDialogOpen, false)
  assert.equal(controller.state.queue, null)
  assert.equal(lostErrors.length, 1)
  assert.equal(lostErrors[0]!.status, 401)
  controller.dispose()
})

test('selection enforces WireLimits.AdminModerationBatchCount upper cap', async () => {
  const count = WireLimits.AdminModerationBatchCount + 2
  const queue = makeQueue(count, true)
  const controller = createController({}, { readAdminCommentQueue: async () => queue })
  bindTestSession(controller)
  await flushMicrotasks()

  for (const row of queue.comments) controller.select(row, true)
  assert.equal(controller.state.selected.size, WireLimits.AdminModerationBatchCount)
  assert.equal(controller.state.selected.has(moderationCoordinate(queue.comments[count - 1]!)), false)

  controller.select(queue.comments[0]!, false)
  assert.equal(controller.state.selected.size, WireLimits.AdminModerationBatchCount - 1)
  controller.dispose()
})

test('already-expired claim expires immediately, explicit cancel frees channel, and 401/403 during batch release stops remaining releases', async () => {
  const clock = new FakeClock(2_000_000)
  const queue = makeQueue(3, true)
  const releasedIds: bigint[] = []
  const lostErrors: ApiError[] = []
  const slowClaim = Promise.withResolvers<AdminModerationClaim>()
  let claimCall = 0
  let batchReleaseErrorStatus: 401 | 403 = 403

  const controller = createController({
    clock,
    hooks: { onSessionLost: err => lostErrors.push(err) },
  }, {
    readAdminCommentQueue: async () => queue,
    claimComment: async target => {
      claimCall++
      if (claimCall === 1) return makeClaim(target, clock.now() - 1)
      if (claimCall === 2) return slowClaim.promise
      return makeClaim(target, clock.now() + 30_000, { claimToken: 'F'.repeat(43) })
    },
    claimModerationBatch: async targets => targets.map(t => makeClaim(t, clock.now() + 30_000)),
    releaseCommentClaim: async claim => {
      releasedIds.push(claim.commentId)
      if (releasedIds.length === 1) throw new ApiError('denied', batchReleaseErrorStatus)
    },
  })
  bindTestSession(controller)
  await flushMicrotasks()

  // Already expired receipt expires synchronously with zero dangling timers.
  await controller.claimForReview(queue.comments[0]!)
  assert.equal(controller.state.claim, null)
  assert.equal(controller.state.failure, 'admin.moderation.m10')
  assert.equal(clock.activeTimerCount, 0)

  // Explicit cancel aborts in-flight claim and allows a fresh claim; late old response is ignored.
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

  // 403 on first batch release stops loop immediately and clears review with m11.
  bindTestSession(controller)
  await flushMicrotasks()
  controller.select(queue.comments[0]!, true)
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  releasedIds.length = 0
  batchReleaseErrorStatus = 403
  await controller.cancelBatch()
  assert.equal(releasedIds.length, 1)
  assert.equal(controller.state.queue, null)
  assert.equal(controller.state.failure, 'admin.moderation.m11')
  assert.equal(lostErrors.length, 0)

  // 401 on first batch release stops loop immediately and emits sessionLost.
  bindTestSession(controller)
  await flushMicrotasks()
  controller.select(queue.comments[0]!, true)
  controller.select(queue.comments[1]!, true)
  await controller.startBatch()
  releasedIds.length = 0
  batchReleaseErrorStatus = 401
  await controller.cancelBatch()
  assert.equal(releasedIds.length, 1)
  assert.equal(lostErrors.length, 1)
  assert.equal(lostErrors[0]!.status, 401)
  controller.dispose()
})
