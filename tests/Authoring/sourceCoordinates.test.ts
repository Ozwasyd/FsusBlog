import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { hasUniformCrlf, normalizeCrlf, restoreCrlf, textareaSourceRange, verifySourceMatch } from '../../src/Web/src/authoring/sourceCoordinates.ts'

const raw = '导言 🧭\r\nCafe\u0301\r\n# Heading ^harbor\r\n'
const expectedEditor = '导言 🧭\nCafe\u0301\n# Heading ^harbor\n'

test('only uniform CRLF sources use a reversible LF editor projection', () => {
  assert.equal(hasUniformCrlf(raw), true)
  for (const unsupported of ['', expectedEditor, 'A\rB', 'A\r\nB\nC', 'A\r\nB\rC']) {
    assert.equal(hasUniformCrlf(unsupported), false, JSON.stringify(unsupported))
  }
  assert.equal(normalizeCrlf(raw), expectedEditor)
  assert.equal(restoreCrlf(expectedEditor), raw)
  assert.equal(restoreCrlf('A\r\nB\nC\rD'), 'A\r\nB\r\nC\r\nD')
})

test('raw span boundaries map to exact UTF-16 positions across CRLF without changing Unicode', () => {
  const start = raw.indexOf('🧭')
  const end = raw.indexOf('^')
  const expectedEnd = expectedEditor.indexOf('^')
  assert.deepEqual(textareaSourceRange(raw, expectedEditor, { start, end }), { start, end: expectedEnd })
  assert.deepEqual(textareaSourceRange(raw, expectedEditor, { start: end, end }), { start: expectedEnd, end: expectedEnd })
  assert.deepEqual(textareaSourceRange(raw, expectedEditor, { start: 0, end: raw.length }), { start: 0, end: expectedEditor.length })
  assert.deepEqual(textareaSourceRange(expectedEditor, expectedEditor, { start, end: expectedEnd }), { start, end: expectedEnd })
})

test('the entire textarea must match and neither boundary can split a CRLF pair or a surrogate', () => {
  const marker = raw.indexOf('^')
  for (const offset of [-1, raw.indexOf('\r\n') + 1, raw.indexOf('🧭') + 1, marker + 0.5, raw.length + 1]) {
    assert.equal(textareaSourceRange(raw, expectedEditor, { start: offset, end: offset }), undefined)
  }
  assert.equal(textareaSourceRange(raw, expectedEditor, { start: 0, end: raw.indexOf('\r\n') + 1 }), undefined)
  assert.equal(textareaSourceRange(raw, expectedEditor, { start: marker, end: marker - 1 }), undefined)
  assert.equal(textareaSourceRange(raw, expectedEditor + 'changed suffix', { start: marker, end: marker }), undefined)
  assert.equal(textareaSourceRange(raw, expectedEditor.normalize(), { start: marker, end: marker }), undefined)
  assert.equal(textareaSourceRange('A\r\nB\n', 'A\nB\n', { start: 3, end: 3 }), undefined)
  assert.equal(textareaSourceRange('A\rB', 'A\nB', { start: 2, end: 2 }), undefined)
})

test('the summary textarea can normalize mixed native newlines without weakening source checks', () => {
  const mixed = '前言 🧭\r\nLine two\r\nCafe\u0301\nLine four\rHit'
  const displayed = '前言 🧭\nLine two\nCafe\u0301\nLine four\nHit'
  const start = mixed.indexOf('Cafe')
  const end = mixed.length
  assert.deepEqual(textareaSourceRange(mixed, displayed, { start, end }, 'native'), {
    start: displayed.indexOf('Cafe'), end: displayed.length,
  })
  assert.equal(textareaSourceRange(mixed, displayed, { start, end }), undefined)
  assert.equal(textareaSourceRange(mixed, displayed.normalize(), { start, end }, 'native'), undefined)
  assert.equal(textareaSourceRange(mixed, displayed, { start: mixed.indexOf('\n'), end }, 'native'), undefined)
})

test('a search match must have the exact raw coordinates, text, and whole-source digest', async () => {
  const match = 'Cafe\u0301'
  const sourceStart = raw.indexOf(match)
  const sourceByteStart = Buffer.byteLength('导言 🧭\r\n')
  const target = {
    sourceStart, sourceEnd: sourceStart + match.length,
    sourceByteStart, sourceByteEnd: sourceByteStart + Buffer.byteLength(match),
    sourceDigest: createHash('sha256').update(raw).digest(), match,
  }
  assert.equal(await verifySourceMatch(raw, target), true)
  assert.equal(await verifySourceMatch(raw, { ...target, match: 'Café' }), false)
  assert.equal(await verifySourceMatch(raw, { ...target, sourceByteStart: sourceStart }), false)
  assert.equal(await verifySourceMatch(raw, { ...target, sourceByteEnd: target.sourceByteEnd + 1 }), false)
  assert.equal(await verifySourceMatch(raw.replace('harbor', 'anchor'), target), false)
})
