import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  acceptCanvasEditorHandoff,
  acceptEditorSourceHandoff,
  cancelCanvasEditorHandoff,
  cancelEditorSourceHandoff,
  offerCanvasEditorHandoff,
  offerHistoricalSearchEditorHandoff,
  offerPropertySearchEditorHandoff,
  offerSearchEditorHandoff,
} from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import { hasUniformCrlf, normalizeCrlf, restoreCrlf, textareaSourceRange, verifySourceMatch } from '../../src/Web/src/authoring/sourceCoordinates.ts'
import {
  createSourceHandoffCoordinator,
  type SourceHandoffCoordinatorOptions,
  type SourceHandoffLiveState,
} from '../../src/Web/src/authoring/sourceHandoffCoordinator.ts'

const digest = Uint8Array.from({ length: 32 }, (_, index) => index)
const coordinatorForToken = (initialToken: string, clocks: Pick<SourceHandoffCoordinatorOptions, 'now' | 'nowMs'> = {}) =>
  createSourceHandoffCoordinator({ initialToken, initialArticleId: 42, accept: acceptEditorSourceHandoff, ...clocks })

const searchRange = (start: number, end: number) =>
  ({ sourceStart: start, sourceEnd: end, sourceByteStart: start, sourceByteEnd: end, sourceDigest: digest })
const searchTarget = (revision: bigint, field: 'body' | 'summary', start: number, end: number, match: string) =>
  ({ articleId: 42, revision, field, ...searchRange(start, end), match })

const makeLiveState = (overrides: Partial<SourceHandoffLiveState> = {}): SourceHandoffLiveState => ({
  activeSessionId: 10, activeRisk: 'clean', recoveryBlocked: false, canSwitch: true,
  editable: true, pending: false, revisionComparisonActive: false, activeEditSequence: 0,
  originalId: 42, originalRevision: 7n, inspectorOpen: true, sessionExpiresAt: 100_000, ...overrides,
})

function resolveVerified(coordinator: ReturnType<typeof coordinatorForToken>, epoch: number, handle: string) {
  coordinator.markSessionVerified()
  const resolved = coordinator.resolveArrival(42, epoch, handle)
  assert.equal(resolved.kind, 'ready')
  return resolved
}

function activateFromToken(
  token: string,
  epoch: number,
  handle: string,
  readLiveState: () => SourceHandoffLiveState,
  options: {
    clocks?: Pick<SourceHandoffCoordinatorOptions, 'now' | 'nowMs'>
    activeEditSequence?: number
    persistentWorkspace?: boolean
    setInspectorOpen?: (open: boolean) => void
  } = {},
) {
  const coordinator = coordinatorForToken(token, options.clocks)
  const resolved = resolveVerified(coordinator, epoch, handle)
  const result = coordinator.activateTarget({
    source: resolved.source, sessionId: 10, witnessedRevision: 7n, recoveryItemsCount: 0,
    recoveryWorking: false, revisionComparisonActive: false, isRouteCurrent: () => true, handle,
    persistentWorkspace: options.persistentWorkspace ?? true,
    activeEditSequence: options.activeEditSequence ?? 0,
    readLiveState,
    setInspectorOpen: options.setInspectorOpen ?? (() => {}),
  })
  return { coordinator, resolved, result }
}

test('arrival handoff waits for verified session, resolves once, and handles activation failures distinctly', () => {
  const coordinator = coordinatorForToken(offerSearchEditorHandoff(searchTarget(7n, 'body', 2, 6, 'word'), 3, 'session-a'))
  assert.equal(coordinator.hasArrival(), true)
  assert.equal(coordinator.snapshot().sourceInspectorPending, true)
  assert.deepEqual(coordinator.resolveArrival(42, 3, 'session-a'), { kind: 'expired' })
  assert.equal(coordinator.snapshot().sourceInspectorPending, false)

  const resolved = resolveVerified(coordinator, 3, 'session-a')
  assert.equal(resolved.requiredRevision, 7n)
  assert.equal(resolved.source.kind, 'search')
  assert.equal(coordinator.handleActivationFailure(resolved.source, { kind: 'blocked', reason: 'stale-reference' }), 'search-unavailable')
  assert.equal(coordinator.handleActivationFailure(resolved.source, { kind: 'blocked', reason: 'forbidden' }), 'activation')
  assert.deepEqual(coordinator.resolveArrival(42, 3, 'session-a'), { kind: 'expired' })
})

test('search summary handoff opens inspector, enforces 6s window and edit guard, and cancels on inspector close', () => {
  let perfNow = 1_000
  let wallNow = 10_000
  const clocks = { now: () => perfNow, nowMs: () => wallNow }
  let live = makeLiveState({ activeEditSequence: 3, inspectorOpen: false })
  const inspectorStates: boolean[] = []
  const { coordinator, result } = activateFromToken(
    offerSearchEditorHandoff({ ...searchTarget(7n, 'summary', 0, 4, 'note'), precision: 'rebased' }, 5, 'handle-1'),
    5, 'handle-1', () => live,
    { clocks, activeEditSequence: 3, setInspectorOpen: open => { inspectorStates.push(open); live = { ...live, inspectorOpen: open } } },
  )
  assert.deepEqual(result, { kind: 'activated' })
  assert.deepEqual(inspectorStates, [true])
  const seek = coordinator.snapshot().summarySeek!
  assert.equal(seek.current(), true)

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

  assert.deepEqual(coordinator.onInspectorClosed(), { noticeKey: 'author.write.theSearchPositionIsNoLongerAvailableReturn' })
  assert.equal(coordinator.snapshot().summarySeek, undefined)
  assert.equal(coordinator.snapshot().sourceSeek, undefined)

  const secondInspector: boolean[] = []
  const { coordinator: second } = activateFromToken(
    offerSearchEditorHandoff({ ...searchTarget(7n, 'body', 0, 4, 'note'), precision: 'rebased' }, 5, 'handle-1'),
    5, 'handle-1', () => live, { clocks, activeEditSequence: 3, setInspectorOpen: open => secondInspector.push(open) },
  )
  assert.deepEqual(secondInspector, [false])
  const bodySeek = second.snapshot().sourceSeek!
  assert.deepEqual(second.finishSourceSeek(bodySeek, true), {
    handled: true, recordRecent: { articleId: 42, revision: 7n },
    noticeKey: 'author.write.openedTheSearchResultAtItsVerifiedPosition',
  })
  assert.deepEqual(second.finishSourceSeek(bodySeek, true), { handled: false })
})

test('historical and property seeks stay isolated across activity changes, credential rotation, and close', () => {
  let perfNow = 100
  const clocks = { now: () => perfNow, nowMs: () => 1_000 }
  const live = makeLiveState({ originalRevision: 7n })
  const { coordinator: historyCoord, resolved: historyResolved } = activateFromToken(
    offerHistoricalSearchEditorHandoff(searchTarget(4n, 'body', 0, 4, 'hist'), 7n, 2, 'handle-h'),
    2, 'handle-h', () => live, { clocks },
  )
  assert.equal(historyResolved.requiredRevision, 7n)
  const historical = historyCoord.snapshot().historicalSeek!
  perfNow += 30_000
  assert.equal(historical.current(), true)
  assert.deepEqual(historyCoord.onActivityChange({ busy: false, comparing: true }), {})
  assert.equal(historyCoord.snapshot().historicalSeek, historical)
  assert.deepEqual(historyCoord.finishHistoricalSeek(historical, true), {
    handled: true, recordRecent: { articleId: 42, revision: 7n },
    noticeKey: 'author.write.openedTheSearchResultInItsEarlierSaved',
  })
  assert.equal(historyCoord.snapshot().historicalSeek, historical)
  assert.equal(historyCoord.closeHistoricalSeek(historical), true)
  assert.equal(historyCoord.snapshot().historicalSeek, undefined)

  const propToken = offerPropertySearchEditorHandoff({
    articleId: 42, revision: 7n, schemaRevision: 3n, definitionId: '238012e6-67e1-46cd-a9fe-71b23ed59641',
    definitionRevision: 2n, valueRevision: 1n, ...searchRange(0, 3), match: 'val',
  }, 2, 'handle-p')
  const { coordinator: propCoord } = activateFromToken(propToken, 2, 'handle-p', () => live, { clocks })
  assert.ok(propCoord.snapshot().propertySeek)
  assert.deepEqual(propCoord.onActivityChange({ busy: false, comparing: true }),
    { noticeKey: 'author.write.theSearchPositionIsNoLongerAvailableReturn' })
  assert.equal(propCoord.snapshot().propertySeek, undefined)
})

test('canvas handoff reports canvas failure notice and clears on article id or credential change', () => {
  const { coordinator: coord } = activateFromToken(
    offerCanvasEditorHandoff({ articleId: 42, revision: 7n, sourceOffset: 15 }, 4),
    4, 'h1', () => makeLiveState(), { persistentWorkspace: false },
  )
  const canvasSeek = coord.snapshot().sourceSeek!
  assert.equal(canvasSeek.kind, 'canvas')
  assert.deepEqual(coord.finishSourceSeek(canvasSeek, false),
    { handled: true, noticeKey: 'author.write.theCanvasSourcePositionCouldNotBeOpened' })
  coord.onCredentialEpochChange()
  coord.onArticleIdChange()
  assert.equal(coord.hasArrival(), false)
})

test('opaque handoff tokens enforce exact epoch, article, credential handle, expiry, and single-use consumption', t => {
  const target = { articleId: 43, revision: 7n, sourceOffset: 21 }
  const acceptCanvas = (token: string, article = 43, epoch = 12) => acceptCanvasEditorHandoff(token, article, epoch)
  const acceptSource = (token: string, handle: string) => acceptEditorSourceHandoff(token, 43, 12, handle)
  const searchHit = (sourceDigest: Uint8Array) =>
    ({ articleId: 43, revision: 7n, sourceStart: 10, sourceEnd: 11, sourceByteStart: 12, sourceByteEnd: 15, sourceDigest, match: '中' })

  const token = offerCanvasEditorHandoff(target, 12)
  assert.match(token, /^[a-f0-9-]{36}$/)
  assert.equal(acceptCanvas('obsolete'), undefined)
  assert.deepEqual(acceptCanvas(token), target)
  assert.equal(acceptCanvas(token), undefined)
  for (const [article, epoch] of [[43, 13], [44, 12]] as const) {
    const t0 = offerCanvasEditorHandoff(target, 12)
    assert.equal(acceptCanvas(t0, article, epoch), undefined)
    assert.equal(acceptCanvas(t0), undefined)
  }

  const old = offerCanvasEditorHandoff(target, 12)
  const current = offerCanvasEditorHandoff({ ...target, sourceOffset: null }, 12)
  cancelCanvasEditorHandoff(old)
  assert.equal(acceptCanvas(old), undefined)
  assert.equal(acceptCanvas(current)?.sourceOffset, null)
  const canceled = offerCanvasEditorHandoff(target, 12)
  cancelCanvasEditorHandoff(canceled)
  assert.equal(acceptCanvas(canceled), undefined)

  let tick = 100
  t.mock.method(performance, 'now', () => tick)
  const elapsed = offerCanvasEditorHandoff(target, 12)
  tick += 20_000
  assert.equal(acceptCanvas(elapsed), undefined)
  tick = 100
  assert.equal(acceptCanvas(elapsed), undefined)

  const checkHandleIsolation = (offer: () => string, handle: string, rotated: string) => {
    const offered = offer()
    assert.equal(acceptSource(offered, rotated), undefined)
    assert.equal(acceptSource(offered, handle), undefined)
  }

  const bodyDigest = Uint8Array.from({ length: 32 }, () => 3)
  const bodyMatch = { ...searchHit(bodyDigest), field: 'body' as const }
  const displaced = offerCanvasEditorHandoff(target, 12)
  const searchToken = offerSearchEditorHandoff(bodyMatch, 12, 'first-handle')
  assert.equal(acceptCanvas(displaced), undefined)
  bodyDigest[0] = 8
  const acceptedSearch = acceptSource(searchToken, 'first-handle')
  assert.equal(acceptedSearch?.kind, 'search')
  if (acceptedSearch?.kind === 'search') assert.equal(acceptedSearch.target.sourceDigest[0], 3)
  assert.equal(acceptSource(searchToken, 'first-handle'), undefined)
  checkHandleIsolation(() => offerSearchEditorHandoff(bodyMatch, 12, 'first-handle'), 'first-handle', 'rotated-handle')
  const canceledSearch = offerSearchEditorHandoff(bodyMatch, 12, 'first-handle')
  cancelEditorSourceHandoff(canceledSearch)
  assert.equal(acceptSource(canceledSearch, 'first-handle'), undefined)

  const histDigest = Uint8Array.from({ length: 32 }, () => 3)
  const histHit = { ...searchHit(histDigest), field: 'summary' as const }
  assert.throws(() => offerHistoricalSearchEditorHandoff(histHit, 7n, 12, 'selected-session'), RangeError)
  const histToken = offerHistoricalSearchEditorHandoff(histHit, 9n, 12, 'selected-session')
  histDigest[0] = 8
  assert.deepEqual(acceptSource(histToken, 'selected-session'),
    { kind: 'search-history', currentRevision: 9n, target: { ...histHit, sourceDigest: Uint8Array.from({ length: 32 }, () => 3) } })
  assert.equal(acceptSource(histToken, 'selected-session'), undefined)
  checkHandleIsolation(() => offerHistoricalSearchEditorHandoff(histHit, 9n, 12, 'selected-session'), 'selected-session', 'rotated-session')

  const propDigest = Uint8Array.from({ length: 32 }, () => 3)
  const propHit = {
    ...searchHit(propDigest), schemaRevision: 11n, definitionId: '238012e6-67e1-46cd-a9fe-71b23ed59641',
    definitionRevision: 9n, valueRevision: 4n,
  }
  assert.throws(() => offerPropertySearchEditorHandoff({ ...propHit, valueRevision: 0n }, 12, 'selected-session'), RangeError)
  const propToken = offerPropertySearchEditorHandoff(propHit, 12, 'selected-session')
  propDigest[0] = 8
  assert.deepEqual(acceptSource(propToken, 'selected-session'),
    { kind: 'property-search', target: { ...propHit, sourceDigest: Uint8Array.from({ length: 32 }, () => 3) } })
  assert.equal(acceptSource(propToken, 'selected-session'), undefined)
  checkHandleIsolation(() => offerPropertySearchEditorHandoff(propHit, 12, 'selected-session'), 'selected-session', 'rotated-session')
  const obsoleteProp = offerPropertySearchEditorHandoff(propHit, 12, 'selected-session')
  const freshCanvas = offerCanvasEditorHandoff(target, 12)
  assert.equal(acceptSource(obsoleteProp, 'selected-session'), undefined)
  assert.deepEqual(acceptCanvas(freshCanvas), target)
})

test('source coordinates project uniform CRLF, reject split surrogates/CRLF, normalize summary, and verify digest', async () => {
  const raw = '导言 🧭\r\nCafe\u0301\r\n# Heading ^harbor\r\n'
  const expectedEditor = '导言 🧭\nCafe\u0301\n# Heading ^harbor\n'
  const rangeOf = (source: string, displayed: string, start: number, end: number, ...mode: [] | ['native']) =>
    textareaSourceRange(source, displayed, { start, end }, ...mode)

  assert.equal(hasUniformCrlf(raw), true)
  for (const unsupported of ['', expectedEditor, 'A\rB', 'A\r\nB\nC', 'A\r\nB\rC'])
    assert.equal(hasUniformCrlf(unsupported), false, JSON.stringify(unsupported))
  assert.equal(normalizeCrlf(raw), expectedEditor)
  assert.equal(restoreCrlf(expectedEditor), raw)
  assert.equal(restoreCrlf('A\r\nB\nC\rD'), 'A\r\nB\r\nC\r\nD')

  const start = raw.indexOf('🧭')
  const end = raw.indexOf('^')
  const expectedEnd = expectedEditor.indexOf('^')
  assert.deepEqual(rangeOf(raw, expectedEditor, start, end), { start, end: expectedEnd })
  assert.deepEqual(rangeOf(raw, expectedEditor, end, end), { start: expectedEnd, end: expectedEnd })
  assert.deepEqual(rangeOf(raw, expectedEditor, 0, raw.length), { start: 0, end: expectedEditor.length })
  assert.deepEqual(rangeOf(expectedEditor, expectedEditor, start, expectedEnd), { start, end: expectedEnd })

  for (const offset of [-1, raw.indexOf('\r\n') + 1, raw.indexOf('🧭') + 1, end + 0.5, raw.length + 1])
    assert.equal(rangeOf(raw, expectedEditor, offset, offset), undefined)
  assert.equal(rangeOf(raw, expectedEditor, 0, raw.indexOf('\r\n') + 1), undefined)
  assert.equal(rangeOf(raw, expectedEditor, end, end - 1), undefined)
  assert.equal(rangeOf(raw, expectedEditor + 'changed suffix', end, end), undefined)
  assert.equal(rangeOf(raw, expectedEditor.normalize(), end, end), undefined)
  assert.equal(rangeOf('A\r\nB\n', 'A\nB\n', 3, 3), undefined)
  assert.equal(rangeOf('A\rB', 'A\nB', 2, 2), undefined)

  const mixed = '前言 🧭\r\nLine two\r\nCafe\u0301\nLine four\rHit'
  const displayed = '前言 🧭\nLine two\nCafe\u0301\nLine four\nHit'
  const mStart = mixed.indexOf('Cafe')
  assert.deepEqual(rangeOf(mixed, displayed, mStart, mixed.length, 'native'), { start: displayed.indexOf('Cafe'), end: displayed.length })
  assert.equal(rangeOf(mixed, displayed, mStart, mixed.length), undefined)
  assert.equal(rangeOf(mixed, displayed.normalize(), mStart, mixed.length, 'native'), undefined)
  assert.equal(rangeOf(mixed, displayed, mixed.indexOf('\n'), mixed.length, 'native'), undefined)

  const match = 'Cafe\u0301'
  const sourceStart = raw.indexOf(match)
  const sourceByteStart = Buffer.byteLength('导言 🧭\r\n')
  const matchTarget = {
    sourceStart, sourceEnd: sourceStart + match.length,
    sourceByteStart, sourceByteEnd: sourceByteStart + Buffer.byteLength(match),
    sourceDigest: createHash('sha256').update(raw).digest(), match,
  }
  assert.equal(await verifySourceMatch(raw, matchTarget), true)
  for (const bad of [{ match: 'Café' }, { sourceByteStart: sourceStart }, { sourceByteEnd: matchTarget.sourceByteEnd + 1 }])
    assert.equal(await verifySourceMatch(raw, { ...matchTarget, ...bad }), false)
  assert.equal(await verifySourceMatch(raw.replace('harbor', 'anchor'), matchTarget), false)
})
