import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  acceptCanvasEditorHandoff,
  cancelCanvasEditorHandoff,
  offerCanvasEditorHandoff,
} from '../../src/Web/src/authoring/canvasEditorHandoff.ts'

const target = { articleId: 43, revision: 7n, sourceOffset: 21 }

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
