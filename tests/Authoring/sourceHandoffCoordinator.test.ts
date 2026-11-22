import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptEditorSourceHandoff,
  offerCanvasEditorHandoff,
  offerHistoricalSearchEditorHandoff,
  offerPropertySearchEditorHandoff,
  offerSearchEditorHandoff,
} from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import {
  createSourceHandoffCoordinator,
  type SourceHandoffCoordinatorOptions,
  type SourceHandoffLiveState,
} from '../../src/Web/src/authoring/sourceHandoffCoordinator.ts'

const digest = Uint8Array.from({ length: 32 }, (_, index) => index)

function coordinatorForToken(initialToken: string, clocks: Pick<SourceHandoffCoordinatorOptions, 'now' | 'nowMs'> = {}) {
  return createSourceHandoffCoordinator({ initialToken, initialArticleId: 42, accept: acceptEditorSourceHandoff, ...clocks })
}

function activationContext() {
  return {
    sessionId: 10,
    witnessedRevision: 7n,
    recoveryItemsCount: 0,
    recoveryWorking: false,
    revisionComparisonActive: false,
    isRouteCurrent: () => true,
  }
}

function searchRange(start: number, end: number) {
  return { sourceStart: start, sourceEnd: end, sourceByteStart: start, sourceByteEnd: end, sourceDigest: digest }
}

function makeLiveState(overrides: Partial<SourceHandoffLiveState> = {}): SourceHandoffLiveState {
  return {
    activeSessionId: 10,
    activeRisk: 'clean',
    recoveryBlocked: false,
    canSwitch: true,
    editable: true,
    pending: false,
    revisionComparisonActive: false,
    activeEditSequence: 0,
    originalId: 42,
    originalRevision: 7n,
    inspectorOpen: true,
    sessionExpiresAt: 100_000,
    ...overrides,
  }
}

test('arrival handoff waits for verified session, resolves once, and handles activation failures distinctly', () => {
  const token = offerSearchEditorHandoff({
    articleId: 42,
    revision: 7n,
    field: 'body',
    ...searchRange(2, 6),
    match: 'word',
  }, 3, 'session-a')

  const coordinator = coordinatorForToken(token)
  assert.equal(coordinator.hasArrival(), true)
  assert.equal(coordinator.snapshot().sourceInspectorPending, true)
  // Unverified session cannot consume the token yet.
  assert.deepEqual(coordinator.resolveArrival(42, 3, 'session-a'), { kind: 'expired' })
  assert.equal(coordinator.snapshot().sourceInspectorPending, false)

  // Once verified with matching credential and handle, the one-use handoff resolves cleanly.
  coordinator.markSessionVerified()
  const resolved = coordinator.resolveArrival(42, 3, 'session-a')
  assert.equal(resolved.kind, 'ready')
  if (resolved.kind === 'ready') {
    assert.equal(resolved.requiredRevision, 7n)
    assert.equal(resolved.source.kind, 'search')
    assert.equal(
      coordinator.handleActivationFailure(resolved.source, { kind: 'blocked', reason: 'stale-reference' }),
      'search-unavailable',
    )
    assert.equal(
      coordinator.handleActivationFailure(resolved.source, { kind: 'blocked', reason: 'forbidden' }),
      'activation',
    )
  }
  assert.deepEqual(coordinator.resolveArrival(42, 3, 'session-a'), { kind: 'expired' })
})

test('search summary handoff opens inspector, enforces 6s window and edit guard, and cancels on inspector close', () => {
  let perfNow = 1_000
  let wallNow = 10_000
  const token = offerSearchEditorHandoff({
    articleId: 42,
    revision: 7n,
    field: 'summary',
    ...searchRange(0, 4),
    match: 'note',
    precision: 'rebased',
  }, 5, 'handle-1')

  const coordinator = coordinatorForToken(token, { now: () => perfNow, nowMs: () => wallNow })
  coordinator.markSessionVerified()
  const resolved = coordinator.resolveArrival(42, 5, 'handle-1')
  assert.equal(resolved.kind, 'ready')
  if (resolved.kind !== 'ready') return

  let live = makeLiveState({ activeEditSequence: 3, inspectorOpen: false })
  const inspectorStates: boolean[] = []
  const activated = coordinator.activateTarget({
    source: resolved.source,
    ...activationContext(),
    handle: 'handle-1',
    persistentWorkspace: true,
    activeEditSequence: 3,
    readLiveState: () => live,
    setInspectorOpen: open => {
      inspectorStates.push(open)
      live = { ...live, inspectorOpen: open }
    },
  })
  assert.deepEqual(activated, { kind: 'activated' })
  assert.deepEqual(inspectorStates, [true])
  const seek = coordinator.snapshot().summarySeek
  assert.ok(seek)
  assert.equal(seek.current(), true)

  // Editing invalidates seek.current(); restoring sequence re-checks expiry and 6s window.
  live = { ...live, activeEditSequence: 4 }
  assert.equal(seek.current(), false)
  live = { ...live, activeEditSequence: 3 }
  perfNow += 6_000
  assert.equal(seek.current(), false)
  perfNow = 5_000
  wallNow = 100_000
  assert.equal(seek.current(), false)
  wallNow = 10_000
  assert.equal(seek.current(), true)

  // Closing the inspector aborts summarySeek with unavailable notice.
  assert.deepEqual(coordinator.onInspectorClosed(), {
    noticeKey: 'author.write.theSearchPositionIsNoLongerAvailableReturn',
  })
  assert.equal(coordinator.snapshot().summarySeek, undefined)
  assert.equal(coordinator.snapshot().sourceSeek, undefined)

  // Re-activating a fresh search seek verifies rebased success notice and recent-open record.
  const token2 = offerSearchEditorHandoff({
    articleId: 42,
    revision: 7n,
    field: 'body',
    ...searchRange(0, 4),
    match: 'note',
    precision: 'rebased',
  }, 5, 'handle-1')
  const second = coordinatorForToken(token2, { now: () => perfNow, nowMs: () => wallNow })
  second.markSessionVerified()
  const resolved2 = second.resolveArrival(42, 5, 'handle-1')
  assert.equal(resolved2.kind, 'ready')
  if (resolved2.kind !== 'ready') return
  const secondInspector: boolean[] = []
  second.activateTarget({
    source: resolved2.source,
    ...activationContext(),
    handle: 'handle-1',
    persistentWorkspace: true,
    activeEditSequence: 3,
    readLiveState: () => live,
    setInspectorOpen: open => secondInspector.push(open),
  })
  // Non-summary search explicitly closes inspector before focusing source caret.
  assert.deepEqual(secondInspector, [false])
  const bodySeek = second.snapshot().sourceSeek!
  assert.deepEqual(second.finishSourceSeek(bodySeek, true), {
    handled: true,
    recordRecent: { articleId: 42, revision: 7n },
    noticeKey: 'author.write.openedTheSearchResultAtItsVerifiedPosition',
  })
  assert.deepEqual(second.finishSourceSeek(bodySeek, true), { handled: false })
})

test('historical and property seeks stay isolated across activity changes, credential rotation, and close', () => {
  let perfNow = 100
  const historyToken = offerHistoricalSearchEditorHandoff({
    articleId: 42,
    revision: 4n,
    field: 'body',
    ...searchRange(0, 4),
    match: 'hist',
  }, 7n, 2, 'handle-h')
  const historyCoord = coordinatorForToken(historyToken, { now: () => perfNow, nowMs: () => 1_000 })
  historyCoord.markSessionVerified()
  const historyResolved = historyCoord.resolveArrival(42, 2, 'handle-h')
  assert.equal(historyResolved.kind, 'ready')
  if (historyResolved.kind !== 'ready') return
  assert.equal(historyResolved.requiredRevision, 7n)

  const live = makeLiveState({ originalRevision: 7n })
  historyCoord.activateTarget({
    source: historyResolved.source,
    ...activationContext(),
    handle: 'handle-h',
    persistentWorkspace: true,
    activeEditSequence: 0,
    readLiveState: () => live,
    setInspectorOpen: () => {},
  })
  const historical = historyCoord.snapshot().historicalSeek!
  // Historical seek is not bounded by the 6s reveal timer and stays open while comparing revisions.
  perfNow += 30_000
  assert.equal(historical.current(), true)
  assert.deepEqual(historyCoord.onActivityChange({ busy: false, comparing: true }), {})
  assert.equal(historyCoord.snapshot().historicalSeek, historical)
  assert.deepEqual(historyCoord.finishHistoricalSeek(historical, true), {
    handled: true,
    recordRecent: { articleId: 42, revision: 7n },
    noticeKey: 'author.write.openedTheSearchResultInItsEarlierSaved',
  })
  assert.equal(historyCoord.snapshot().historicalSeek, historical)
  assert.equal(historyCoord.closeHistoricalSeek(historical), true)
  assert.equal(historyCoord.snapshot().historicalSeek, undefined)

  // Property seek requires persistentWorkspace, opens inspector, and cancels on comparing or credential change.
  const propToken = offerPropertySearchEditorHandoff({
    articleId: 42,
    revision: 7n,
    schemaRevision: 3n,
    definitionId: '238012e6-67e1-46cd-a9fe-71b23ed59641',
    definitionRevision: 2n,
    valueRevision: 1n,
    ...searchRange(0, 3),
    match: 'val',
  }, 2, 'handle-p')
  const propCoord = coordinatorForToken(propToken, { now: () => perfNow, nowMs: () => 1_000 })
  propCoord.markSessionVerified()
  const propResolved = propCoord.resolveArrival(42, 2, 'handle-p')
  assert.equal(propResolved.kind, 'ready')
  if (propResolved.kind !== 'ready') return
  propCoord.activateTarget({
    source: propResolved.source,
    ...activationContext(),
    handle: 'handle-p',
    persistentWorkspace: true,
    activeEditSequence: 0,
    readLiveState: () => live,
    setInspectorOpen: () => {},
  })
  assert.ok(propCoord.snapshot().propertySeek)
  assert.deepEqual(propCoord.onActivityChange({ busy: false, comparing: true }), {
    noticeKey: 'author.write.theSearchPositionIsNoLongerAvailableReturn',
  })
  assert.equal(propCoord.snapshot().propertySeek, undefined)
})

test('canvas handoff reports canvas failure notice and clears on article id or credential change', () => {
  const token = offerCanvasEditorHandoff({ articleId: 42, revision: 7n, sourceOffset: 15 }, 4)
  const coord = coordinatorForToken(token)
  coord.markSessionVerified()
  const resolved = coord.resolveArrival(42, 4, 'h1')
  assert.equal(resolved.kind, 'ready')
  if (resolved.kind !== 'ready') return
  coord.activateTarget({
    source: resolved.source,
    ...activationContext(),
    handle: 'h1',
    persistentWorkspace: false,
    activeEditSequence: 0,
    readLiveState: () => makeLiveState(),
    setInspectorOpen: () => {},
  })
  const canvasSeek = coord.snapshot().sourceSeek!
  assert.equal(canvasSeek.kind, 'canvas')
  assert.deepEqual(coord.finishSourceSeek(canvasSeek, false), {
    handled: true,
    noticeKey: 'author.write.theCanvasSourcePositionCouldNotBeOpened',
  })
  coord.onCredentialEpochChange()
  coord.onArticleIdChange()
  assert.equal(coord.hasArrival(), false)
})
