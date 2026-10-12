import { describe, expect, it } from 'vitest'
import {
  applyMarkdownEditorChanges,
  MarkdownEditorTransactionStore,
  normalizeMarkdownEditorSelection,
  validateMarkdownEditorChanges,
} from '../src/markdown-editor-transaction'

import type {
  MarkdownEditorChange,
  MarkdownEditorSelection,
  MarkdownEditorRetainedTransactionSnapshot,
  MarkdownEditorTransaction,
} from '../src/markdown-editor-transaction'

const selection = (
  start: number,
  end = start,
  direction: MarkdownEditorSelection['direction'] = 'none',
): MarkdownEditorSelection => ({ direction, end, start })

const transaction = (
  changes: readonly MarkdownEditorChange[],
  nextSelection: MarkdownEditorSelection,
  overrides: Partial<MarkdownEditorTransaction> = {},
): MarkdownEditorTransaction => ({
  changes,
  history: 'separate',
  origin: 'programmatic',
  selection: nextSelection,
  ...overrides,
})

const codePointBoundaries = (value: string) => {
  const boundaries = [0]
  let offset = 0
  for (const point of value) {
    offset += point.length
    boundaries.push(offset)
  }
  return boundaries
}

const seededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('MarkdownEditor transaction properties', () => {
  it('delivers original synchronous retirement before writer getters and releases only actual registrations', () => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    const ticket = store.captureDocumentAuthority()!
    let retired = false
    let calls = 0
    const handle = store.subscribeDocumentAuthorityRetirement(() => {
      retired = true
      calls += 1
      expect(store.captureDocumentAuthority()).toBeNull()
      expect(store.hasDocumentAuthorityCustody(ticket)).toBe(false)
    })
    expect(handle.hasCustody()).toBe(true)
    store.setSelection({ get start(): number { expect(retired).toBe(true); return 0 }, end: 0 })
    expect(calls).toBe(1)
    expect(handle.unsubscribe()).toBe(true)
    expect(handle.hasCustody()).toBe(false)
    expect(handle.unsubscribe()).toBe(false)
    store.reset('next')
    expect(calls).toBe(2)
    expect(store.captureDocumentAuthority()).not.toBeNull()
  })

  it('attempts every original receiver, preserves first thrown cause/custody and permanently refuses resigning', () => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    const retained = store.retainSnapshot()
    const firstCause = { tag: 'first-original-retirement-cause' }
    const otherCause = { tag: 'other-original-retirement-cause' }
    const calls: string[] = []
    let fail = true
    const other = store.subscribeDocumentAuthorityRetirement(() => { calls.push('other'); if (fail) throw otherCause })
    const first = store.subscribeDocumentAuthorityRetirement(() => { calls.push('first'); if (fail) throw firstCause })
    let caught: unknown
    try { store.reset('must not apply') } catch (cause) { caught = cause }
    expect(caught).toBe(firstCause)
    expect(calls).toEqual(['first', 'other'])
    expect(store.value).toBe('source')
    expect(store.validateRetainedSnapshot(retained)).toBe(true)
    expect(store.captureDocumentAuthority()).toBeNull()
    expect(first.hasCustody()).toBe(true)
    expect(other.hasCustody()).toBe(true)
    expect(first.failureCause()).toBe(firstCause)
    expect(other.failureCause()).toBe(otherCause)
    fail = false
    expect(first.unsubscribe()).toBe(true)
    expect(other.unsubscribe()).toBe(true)
    expect(store.captureDocumentAuthority()).toBeNull()
  })

  it('retains failed unsubscribe even if its receiver catches reentry, then cleans only after genuine retry', () => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    let reenter = true
    let caught: unknown
    const handle = store.subscribeDocumentAuthorityRetirement(() => {
      if (reenter) {
        try { handle.unsubscribe() } catch (cause) { caught = cause }
      }
    })
    let outer: unknown
    try { handle.unsubscribe() } catch (cause) { outer = cause }
    expect(outer).toBe(caught)
    expect(handle.failureCause()).toBe(caught)
    expect(handle.hasCustody()).toBe(true)
    expect(store.captureDocumentAuthority()).toBeNull()
    reenter = false
    expect(handle.unsubscribe()).toBe(true)
    expect(handle.hasCustody()).toBe(false)
    expect(handle.failureCause()).toBeUndefined()
    expect(store.captureDocumentAuthority()).toBeNull()
  })

  it.each([
    ['switchDocument', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.switchDocument({ id: 'document', epoch: 2 }, 'source')],
    ['reset', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.reset('reset')],
    ['setSelection', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.setSelection(selection(0))],
    ['dispatch', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.dispatch(transaction([{ from: 0, to: 0, insert: 'next ' }], selection(0)))],
    ['undo', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.undo()],
    ['redo', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.redo()],
    ['breakMergeGroup', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.breakMergeGroup()],
    ['restoreRetainedSnapshot', (store: MarkdownEditorTransactionStore, snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.restoreRetainedSnapshot(snapshot)],
    ['releaseRetainedSnapshot', (store: MarkdownEditorTransactionStore, _snapshot: MarkdownEditorRetainedTransactionSnapshot) => store.releaseRetainedSnapshot()],
  ] as const)('revokes original document authority at the genuine %s write entry', (_name, write) => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    store.dispatch(transaction([{ from: 0, to: 0, insert: 'seed ' }], selection(0)))
    const snapshot = store.retainSnapshot()
    const ticket = store.captureDocumentAuthority()!
    expect(ticket).toEqual({ scope: 'native-transaction-document', documentKey: 'document', documentEpoch: 1, revision: store.revision })
    expect(store.captureDocumentAuthority()).toBe(ticket)
    expect(store.hasDocumentAuthorityCustody({ ...ticket })).toBe(false)
    expect(new MarkdownEditorTransactionStore('source').hasDocumentAuthorityCustody(ticket)).toBe(false)
    write(store, snapshot)
    expect(store.hasDocumentAuthorityCustody(ticket)).toBe(false)
    const next = store.captureDocumentAuthority()!
    expect(store.hasDocumentAuthorityCustody(next)).toBe(true)
    expect(next).not.toBe(ticket)
  })

  it('revokes before caller getters, refuses capture throughout failed writes, and fences same-coordinate native preparation', () => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    const retained = store.retainSnapshot()
    const prepared = store.prepareRetainedSnapshot()
    const ticket = store.captureDocumentAuthority()!
    let read = false
    expect(() => store.setSelection({
      get start(): number {
        read = true
        expect(store.hasDocumentAuthorityCustody(ticket)).toBe(false)
        expect(store.captureDocumentAuthority()).toBeNull()
        expect(store.validatePreparedRetainedSnapshot(prepared)).toBe(false)
        expect(() => store.prepareRetainedSnapshot()).toThrow('editor-history-document-authority-unavailable')
        throw new Error('original-selection-getter-failed')
      }, end: 0,
    })).toThrow('original-selection-getter-failed')
    expect(read).toBe(true)
    expect(store.value).toBe('source')
    expect(store.revision).toBe(0)
    expect(store.validateRetainedSnapshot(retained)).toBe(true)
    expect(store.validatePreparedRetainedSnapshot(prepared)).toBe(false)
    expect(store.discardPreparedRetainedSnapshot(prepared)).toBe(true)
    expect(store.hasDocumentAuthorityCustody(store.captureDocumentAuthority()!)).toBe(true)
  })

  it('keeps native pure publication on the same document ticket and rejects raw-store epoch ABA and retirement', () => {
    const store = new MarkdownEditorTransactionStore('source', selection(0), { id: 'document', epoch: 1 })
    const ticket = store.captureDocumentAuthority()!
    const prepared = store.prepareRetainedSnapshot()
    expect(store.allocatePreparedRetainedSnapshot(prepared)).toBe(true)
    expect(store.commitPreparedRetainedSnapshot(prepared)).toBe(prepared.snapshot)
    expect(store.hasDocumentAuthorityCustody(ticket)).toBe(true)
    store.switchDocument({ id: 'document', epoch: 2 }, 'source', selection(0))
    store.switchDocument({ id: 'document', epoch: 1 }, 'source', selection(0))
    const current = store.captureDocumentAuthority()!
    expect(current).toEqual(ticket)
    expect(current).not.toBe(ticket)
    expect(store.hasDocumentAuthorityCustody(ticket)).toBe(false)
    store.retireDocumentAuthority()
    expect(store.hasDocumentAuthorityCustody(current)).toBe(false)
    expect(store.captureDocumentAuthority()).toBeNull()
    store.reset('later source')
    expect(store.captureDocumentAuthority()).toBeNull()
  })

  // Unit and property coverage protects the transaction core; native browser
  // and operating-system IME evidence remains a separately-owned acceptance.
  it('round-trips arbitrary sorted non-overlapping UTF-16 changes through inverse changes', () => {
    const random = seededRandom(268)
    const alphabet = ['a', '中', '한', '😀', 'e\u0301', 'אב', '\n']

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const length = Math.floor(random() * 30)
      const value = Array.from(
        { length },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('')
      const boundaries = codePointBoundaries(value)
      const changes: MarkdownEditorChange[] = []
      let minimumBoundary = 0
      const changeCount = Math.floor(random() * 6)

      for (let index = 0; index < changeCount; index += 1) {
        const remaining = boundaries.filter(
          (boundary) => boundary >= minimumBoundary,
        )
        if (!remaining.length) break
        const from =
          remaining[Math.floor(random() * Math.max(1, remaining.length - 1))]
        const validEnds = boundaries.filter((boundary) => boundary >= from)
        const to = validEnds[Math.floor(random() * validEnds.length)]
        const insert = Array.from(
          { length: Math.floor(random() * 4) },
          () => alphabet[Math.floor(random() * alphabet.length)],
        ).join('')
        changes.push({ from, insert, to })
        minimumBoundary = to
      }

      changes.sort(
        (left, right) => left.from - right.from || left.to - right.to,
      )
      const nonOverlapping = changes.filter(
        (change, index) => index === 0 || change.from >= changes[index - 1].to,
      )
      const applied = applyMarkdownEditorChanges(value, nonOverlapping)
      expect(applied, `iteration ${iteration}`).toBeDefined()
      const reverted = applyMarkdownEditorChanges(
        applied?.value ?? '',
        applied?.inverse ?? [],
      )
      expect(reverted?.value, `iteration ${iteration}`).toBe(value)
    }
  })

  it('rejects overlap, out-of-range, non-integer, and surrogate-split boundaries', () => {
    const value = 'A😀B'
    const invalid: readonly (readonly MarkdownEditorChange[])[] = [
      [
        { from: 0, insert: 'x', to: 2 },
        { from: 1, insert: 'y', to: 3 },
      ],
      [{ from: -1, insert: '', to: 0 }],
      [{ from: 0, insert: '', to: 99 }],
      [{ from: 1.5, insert: '', to: 2 }],
      [{ from: 2, insert: '', to: 3 }],
    ]

    for (const changes of invalid) {
      expect(validateMarkdownEditorChanges(value, changes)).toBe(false)
      expect(applyMarkdownEditorChanges(value, changes)).toBeUndefined()
    }
  })

  it('preserves backward direction while snapping combining and ZWJ selections to graphemes', () => {
    const value = `A${'e\u0301'}👩‍👩‍👧‍👦אב`
    const combining = normalizeMarkdownEditorSelection(
      value,
      selection(2, 2, 'backward'),
    )
    expect(combining).toEqual(selection(1, 1, 'backward'))

    const familyStart = `Ae\u0301`.length
    const insideFamily = normalizeMarkdownEditorSelection(
      value,
      selection(familyStart + 3, familyStart + 6, 'backward'),
    )
    expect(insideFamily).toEqual({
      direction: 'backward',
      start: familyStart,
      end: familyStart + '👩‍👩‍👧‍👦'.length,
    })
  })

  it('rejects stale revisions without changing the document or history', () => {
    const store = new MarkdownEditorTransactionStore('draft', selection(5))
    const accepted = store.dispatch(
      transaction([{ from: 5, insert: ' one', to: 5 }], selection(9)),
    )
    expect(accepted.accepted).toBe(true)

    const stale = store.dispatch(
      transaction([{ from: 9, insert: ' stale', to: 9 }], selection(15), {
        expectedRevision: 0,
      }),
    )
    expect(stale).toMatchObject({
      accepted: false,
      reason: 'stale-revision',
      revision: 1,
      value: 'draft one',
    })
    expect(stale.history.undoDepth).toBe(1)
  })

  it('merges only adjacent same-direction input inside 1000ms and respects explicit boundaries', () => {
    const store = new MarkdownEditorTransactionStore('', selection(0))
    const insertInput = (
      from: number,
      insert: string,
      now: number,
      direction: 'backward' | 'forward' = 'forward',
    ) =>
      store.dispatch(
        transaction(
          [{ from, insert, to: from }],
          selection(from + insert.length),
          { history: 'merge', origin: 'input' },
        ),
        { mergeDirection: direction, now },
      )

    insertInput(0, '你', 0)
    insertInput(1, '好', 999)
    expect(store.history.undoDepth).toBe(1)
    expect(store.undo().value).toBe('')
    expect(store.redo().value).toBe('你好')

    store.breakMergeGroup()
    insertInput(2, '!', 1000)
    expect(store.history.undoDepth).toBe(2)
    insertInput(3, '?', 2001)
    expect(store.history.undoDepth).toBe(3)
  })

  it('stores bounded change/inverse history and evicts oldest entries deterministically', () => {
    const store = new MarkdownEditorTransactionStore('', selection(0))
    for (let index = 0; index < 105; index += 1) {
      store.dispatch(
        transaction(
          [{ from: index, insert: 'x', to: index }],
          selection(index + 1),
        ),
      )
    }
    expect(store.history).toMatchObject({
      canUndo: true,
      redoDepth: 0,
      undoDepth: 100,
    })

    for (let index = 0; index < 100; index += 1) {
      expect(store.undo().accepted).toBe(true)
    }
    expect(store.value).toBe('xxxxx')
    expect(store.undo()).toMatchObject({
      accepted: false,
      reason: 'no-history',
    })

    const oversized = new MarkdownEditorTransactionStore('', selection(0))
    oversized.dispatch(
      transaction(
        [{ from: 0, insert: 'x'.repeat(1_000_001), to: 0 }],
        selection(1_000_001),
      ),
    )
    expect(oversized.history).toMatchObject({
      retainedUnits: 0,
      undoDepth: 0,
    })
  })

  it('clears redo and old undo entries on new mutations and external reset', () => {
    const store = new MarkdownEditorTransactionStore('A', selection(1))
    store.dispatch(transaction([{ from: 1, insert: 'B', to: 1 }], selection(2)))
    store.undo()
    expect(store.history.canRedo).toBe(true)

    store.dispatch(transaction([{ from: 1, insert: 'C', to: 1 }], selection(2)))
    expect(store.history.canRedo).toBe(false)

    const reset = store.dispatch(
      transaction([{ from: 0, insert: '外部', to: 2 }], selection(2), {
        history: 'skip',
        origin: 'external',
      }),
    )
    expect(reset).toMatchObject({ accepted: true, value: '外部' })
    expect(reset.history).toMatchObject({
      canRedo: false,
      canUndo: false,
      redoDepth: 0,
      undoDepth: 0,
    })
  })
})
