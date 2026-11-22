import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createInboxTimeFormatter,
  inboxBubbleVariant,
  inboxStatusTagType,
} from '../../src/Web/src/inboxPresentation.ts'

test('inboxStatusTagType maps open/pending/closed consistently and falls back safely', () => {
  assert.equal(inboxStatusTagType(0), 'success')
  assert.equal(inboxStatusTagType(1), 'warning')
  assert.equal(inboxStatusTagType(2), 'info')
  assert.equal(inboxStatusTagType(99), 'info')
})

test('inboxBubbleVariant distinguishes reader, admin, system, and internal notes', () => {
  assert.equal(inboxBubbleVariant(0, 'reader'), 'self')
  assert.equal(inboxBubbleVariant(1, 'reader'), 'other')
  assert.equal(inboxBubbleVariant(2, 'reader'), 'system')

  assert.equal(inboxBubbleVariant(0, 'admin'), 'other')
  assert.equal(inboxBubbleVariant(1, 'admin'), 'self')
  assert.equal(inboxBubbleVariant(2, 'admin'), 'system')
  assert.equal(inboxBubbleVariant(1, 'admin', true), 'muted')
  assert.equal(inboxBubbleVariant(2, 'admin', true), 'muted')
})

test('createInboxTimeFormatter formats same-day, same-year, and prior-year timestamps compactly', () => {
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
