import { strict as assert } from 'node:assert'
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

const target = { articleId: 43, revision: 7n, sourceOffset: 21 }

function searchHit(sourceDigest: Uint8Array) {
  return {
    articleId: 43, revision: 7n, sourceStart: 10, sourceEnd: 11,
    sourceByteStart: 12, sourceByteEnd: 15, sourceDigest, match: '中',
  }
}

test('the opaque handoff needs the exact credential epoch and article and is consumed once', () => {
  const token = offerCanvasEditorHandoff(target, 12)
  assert.match(token, /^[a-f0-9-]{36}$/)
  assert.equal(acceptCanvasEditorHandoff('obsolete', 43, 12), undefined)
  assert.deepEqual(acceptCanvasEditorHandoff(token, 43, 12), target)
  assert.equal(acceptCanvasEditorHandoff(token, 43, 12), undefined)
  const otherEpoch = offerCanvasEditorHandoff(target, 12)
  assert.equal(acceptCanvasEditorHandoff(otherEpoch, 43, 13), undefined)
  assert.equal(acceptCanvasEditorHandoff(otherEpoch, 43, 12), undefined)
  const otherArticle = offerCanvasEditorHandoff(target, 12)
  assert.equal(acceptCanvasEditorHandoff(otherArticle, 44, 12), undefined)
  assert.equal(acceptCanvasEditorHandoff(otherArticle, 43, 12), undefined)
})

test('the current handoff can be superseded or canceled without affecting a newer offer', () => {
  const old = offerCanvasEditorHandoff(target, 12)
  const current = offerCanvasEditorHandoff({ ...target, sourceOffset: null }, 12)
  cancelCanvasEditorHandoff(old)
  assert.equal(acceptCanvasEditorHandoff(old, 43, 12), undefined)
  assert.equal(acceptCanvasEditorHandoff(current, 43, 12)?.sourceOffset, null)
  const canceled = offerCanvasEditorHandoff(target, 12)
  cancelCanvasEditorHandoff(canceled)
  assert.equal(acceptCanvasEditorHandoff(canceled, 43, 12), undefined)
})

test('an elapsed handoff stays consumed if a timer is reset', t => {
  let tick = 100
  t.mock.method(performance, 'now', () => tick)
  const token = offerCanvasEditorHandoff(target, 12)
  tick += 20_000
  assert.equal(acceptCanvasEditorHandoff(token, 43, 12), undefined)
  tick = 100
  assert.equal(acceptCanvasEditorHandoff(token, 43, 12), undefined)
})


test('the search target shares the opaque one-use slot and belongs to the exact credential handle', () => {
  const sourceDigest = Uint8Array.from({ length: 32 }, () => 3)
  const match = { ...searchHit(sourceDigest), field: 'body' as const }
  const canvas = offerCanvasEditorHandoff(target, 12)
  const token = offerSearchEditorHandoff(match, 12, 'first-handle')
  assert.equal(acceptCanvasEditorHandoff(canvas, 43, 12), undefined)
  sourceDigest[0] = 8
  const current = acceptEditorSourceHandoff(token, 43, 12, 'first-handle')
  assert.equal(current?.kind, 'search')
  if (current?.kind === 'search') assert.equal(current.target.sourceDigest[0], 3)
  assert.equal(acceptEditorSourceHandoff(token, 43, 12, 'first-handle'), undefined)

  const replaced = offerSearchEditorHandoff(match, 12, 'first-handle')
  assert.equal(acceptEditorSourceHandoff(replaced, 43, 12, 'rotated-handle'), undefined)
  assert.equal(acceptEditorSourceHandoff(replaced, 43, 12, 'first-handle'), undefined)
  const canceled = offerSearchEditorHandoff(match, 12, 'first-handle')
  cancelEditorSourceHandoff(canceled)
  assert.equal(acceptEditorSourceHandoff(canceled, 43, 12, 'first-handle'), undefined)
})

test('a historical search handoff separates the current head from its exact one-use saved match', () => {
  const sourceDigest = Uint8Array.from({ length: 32 }, () => 3)
  const hit = { ...searchHit(sourceDigest), field: 'summary' as const }
  assert.throws(() => offerHistoricalSearchEditorHandoff(hit, 7n, 12, 'selected-session'), RangeError)
  const token = offerHistoricalSearchEditorHandoff(hit, 9n, 12, 'selected-session')
  sourceDigest[0] = 8
  assert.deepEqual(acceptEditorSourceHandoff(token, 43, 12, 'selected-session'), {
    kind: 'search-history', currentRevision: 9n,
    target: { ...hit, sourceDigest: Uint8Array.from({ length: 32 }, () => 3) },
  })
  assert.equal(acceptEditorSourceHandoff(token, 43, 12, 'selected-session'), undefined)

  const mismatched = offerHistoricalSearchEditorHandoff(hit, 9n, 12, 'selected-session')
  assert.equal(acceptEditorSourceHandoff(mismatched, 43, 12, 'rotated-session'), undefined)
  assert.equal(acceptEditorSourceHandoff(mismatched, 43, 12, 'selected-session'), undefined)
})

test('property text handoff preserves the pinned snapshot in the exact session and consumes it once', () => {
  const sourceDigest = Uint8Array.from({ length: 32 }, () => 3)
  const hit = {
    ...searchHit(sourceDigest), schemaRevision: 11n, definitionId: '238012e6-67e1-46cd-a9fe-71b23ed59641',
    definitionRevision: 9n, valueRevision: 4n,
  }
  assert.throws(() => offerPropertySearchEditorHandoff({ ...hit, valueRevision: 0n }, 12, 'selected-session'), RangeError)
  const token = offerPropertySearchEditorHandoff(hit, 12, 'selected-session')
  sourceDigest[0] = 8
  assert.deepEqual(acceptEditorSourceHandoff(token, 43, 12, 'selected-session'), {
    kind: 'property-search', target: { ...hit, sourceDigest: Uint8Array.from({ length: 32 }, () => 3) },
  })
  assert.equal(acceptEditorSourceHandoff(token, 43, 12, 'selected-session'), undefined)

  const otherSession = offerPropertySearchEditorHandoff(hit, 12, 'selected-session')
  assert.equal(acceptEditorSourceHandoff(otherSession, 43, 12, 'rotated-session'), undefined)
  assert.equal(acceptEditorSourceHandoff(otherSession, 43, 12, 'selected-session'), undefined)

  const obsolete = offerPropertySearchEditorHandoff(hit, 12, 'selected-session')
  const current = offerCanvasEditorHandoff(target, 12)
  assert.equal(acceptEditorSourceHandoff(obsolete, 43, 12, 'selected-session'), undefined)
  assert.deepEqual(acceptCanvasEditorHandoff(current, 43, 12), target)
})
