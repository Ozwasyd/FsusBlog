import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/Contracts/aeds.ts'
import type { Draft } from '../../src/Contracts/wire.generated.ts'
import {
  createWriteCommandAdapter,
  isSessionMismatchError,
  selectSaveTransport,
  sessionMismatchMessage,
  type WriteCommandTransportPort,
} from '../../src/Web/src/authoring/writeCommandAdapter.ts'

const baseDraft: Draft = {
  id: 12,
  revision: 4n,
  title: '  Draft Title \u3000',
  body: 'Hello world',
  published: false,
}

function makeTransport(overrides: Partial<WriteCommandTransportPort> = {}): WriteCommandTransportPort {
  const unsupported = () => Promise.reject(new Error('unexpected transport call'))
  return {
    readDraft: unsupported,
    articleAction: unsupported,
    saveWithBodyInsertion: unsupported,
    saveWithBodyInsertions: unsupported,
    saveWithBodyEdits: unsupported,
    assignTaxonomy: unsupported,
    rollbackDraft: unsupported,
    setArticleSchedule: unsupported,
    setDraftRights: unsupported,
    editArticleMedia: unsupported,
    saveDraftSummary: unsupported,
    publishArticleImages: unsupported,
    ...overrides,
  }
}

test('selectSaveTransport chooses full save, single insertion, multiple insertions, body edits, and empty publish/retract payloads', () => {
  const full = selectSaveTransport('save', baseDraft, 'k-full')
  assert.equal(full.kind, 'full')
  if (full.kind === 'full') {
    assert.equal(full.action, 'save')
    assert.equal(full.input.title, 'Draft Title')
    assert.equal(full.input.body, 'Hello world')
  }

  const single = selectSaveTransport('save', baseDraft, 'k-single', [
    { offset: 5, removedLength: 0, insert: ' brave' },
  ])
  assert.equal(single.kind, 'body-insertion')
  if (single.kind === 'body-insertion') {
    assert.equal(single.input.offset, 5)
    assert.equal(single.input.length, 6)
    assert.equal(single.input.title, 'Draft Title')
  }

  const multi = selectSaveTransport('save', baseDraft, 'k-multi', [
    { offset: 5, removedLength: 0, insert: ' A' },
    { offset: 13, removedLength: 0, insert: ' B' },
  ])
  assert.equal(multi.kind, 'body-insertions')
  if (multi.kind === 'body-insertions') {
    assert.deepEqual(multi.input.insertions, [
      { offset: 5, length: 2 },
      { offset: 13, length: 2 },
    ])
  }

  const edited = selectSaveTransport('save', baseDraft, 'k-edits', [
    { offset: 5, removedLength: 0, insert: ' A' },
    { offset: 0, removedLength: 5, insert: 'Hi' },
  ])
  assert.equal(edited.kind, 'body-edits')
  if (edited.kind === 'body-edits') {
    assert.equal(edited.input.edits.length, 2)
  }

  const publish = selectSaveTransport('publish', baseDraft, 'k-pub', [
    { offset: 0, removedLength: 0, insert: 'ignored' },
  ])
  assert.equal(publish.kind, 'full')
  if (publish.kind === 'full') {
    assert.equal(publish.action, 'publish')
    assert.equal(publish.input.title, '')
    assert.equal(publish.input.body, '')
  }

  const retract = selectSaveTransport('retract', baseDraft, 'k-ret')
  assert.equal(retract.kind, 'full')
  if (retract.kind === 'full') {
    assert.equal(retract.action, 'retract')
    assert.equal(retract.input.title, '')
    assert.equal(retract.input.body, '')
  }
})

test('writeCommandAdapter dispatches exact delta/full transport and rejects mismatched save replies', async () => {
  const calls: string[] = []
  const adapter = createWriteCommandAdapter({
    session: {
      currentHandle: () => 'handle-a',
      hasSession: () => true,
      recheckCredential: async () => {},
    },
    transport: makeTransport({
      articleAction: async (action, input) => {
        calls.push(`full:${action}`)
        return { ...baseDraft, title: input.title, body: input.body, revision: 5n }
      },
      saveWithBodyInsertion: async input => {
        calls.push(`insertion:${input.offset}:${input.length}`)
        return { ...baseDraft, title: input.title, body: input.body, revision: 5n }
      },
      saveWithBodyInsertions: async input => {
        calls.push(`insertions:${input.insertions.length}`)
        return { ...baseDraft, title: input.title, body: input.body, revision: 5n }
      },
      saveWithBodyEdits: async input => {
        calls.push(`edits:${input.edits.length}`)
        return { ...baseDraft, title: input.title, body: input.body, revision: 5n }
      },
    }),
  })

  const signal = new AbortController().signal
  const save = adapter.articleCommand('save')
  assert.equal((await save(baseDraft, signal, 'k1')).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k2', [{ offset: 5, removedLength: 0, insert: '!' }])).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k3', [
    { offset: 0, removedLength: 0, insert: 'a' },
    { offset: 1, removedLength: 0, insert: 'b' },
  ])).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k4', [{ offset: 0, removedLength: 2, insert: 'Hi' }])).kind, 'saved')
  assert.deepEqual(calls, ['full:save', 'insertion:5:1', 'insertions:2', 'edits:1'])

  const tampered = createWriteCommandAdapter({
    session: {
      currentHandle: () => 'handle-a',
      hasSession: () => true,
      recheckCredential: async () => {},
    },
    transport: makeTransport({
      articleAction: async () => ({ ...baseDraft, title: 'Different Title', body: baseDraft.body, revision: 5n }),
    }),
  })
  assert.deepEqual(await tampered.articleCommand('save')(baseDraft, signal, 'k5'), {
    kind: 'blocked',
    reason: 'unavailable',
  })
})

test('writeCommandAdapter distinguishes CAS 409 conflict from cross-account 409 session mismatch, 400, 401/403/404, and abort', async () => {
  let activeHandle: string | undefined = 'handle-a'
  let sessionAlive = true
  const rechecked: string[] = []
  let nextError: unknown = new ApiError('stale revision', 409)

  const adapter = createWriteCommandAdapter({
    session: {
      currentHandle: () => activeHandle,
      hasSession: () => sessionAlive,
      recheckCredential: async handle => {
        rechecked.push(handle)
        if (nextError instanceof ApiError && (nextError.status === 401 || isSessionMismatchError(nextError))) {
          sessionAlive = false
          activeHandle = undefined
        }
      },
    },
    transport: makeTransport({
      articleAction: async () => { throw nextError },
    }),
  })

  const signal = new AbortController().signal
  const save = adapter.articleCommand('save')

  // CAS 409 conflict does NOT call recheckCredential.
  assert.deepEqual(await save(baseDraft, signal, 'k-cas'), { kind: 'conflict' })
  assert.deepEqual(rechecked, [])

  // 400 validation error -> rejected.
  nextError = new ApiError('invalid draft', 400)
  assert.deepEqual(await save(baseDraft, signal, 'k-400'), { kind: 'rejected' })

  // 403 / 404 -> forbidden / missing.
  nextError = new ApiError('forbidden', 403)
  assert.deepEqual(await save(baseDraft, signal, 'k-403'), { kind: 'blocked', reason: 'forbidden' })
  nextError = new ApiError('missing', 404)
  assert.deepEqual(await save(baseDraft, signal, 'k-404'), { kind: 'blocked', reason: 'missing' })

  // 409 session mismatch triggers credential recheck and reports expired (never CAS conflict).
  nextError = new ApiError(sessionMismatchMessage, 409)
  assert.deepEqual(await save(baseDraft, signal, 'k-mismatch'), { kind: 'blocked', reason: 'expired' })
  assert.deepEqual(rechecked, ['handle-a'])

  // Missing handle or already-aborted signal blocks immediately without network calls.
  assert.deepEqual(await save(baseDraft, signal, 'k-no-handle'), { kind: 'blocked', reason: 'unavailable' })
  activeHandle = 'handle-b'
  sessionAlive = true
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await save(baseDraft, aborted.signal, 'k-aborted'), { kind: 'blocked', reason: 'unavailable' })
})

test('loadDraft rejects late responses and non-expired errors after account handle changes', async () => {
  let activeHandle: string | undefined = 'account-a'
  let resolveDraft!: (draft: Draft) => void
  const adapter = createWriteCommandAdapter({
    session: {
      currentHandle: () => activeHandle,
      hasSession: () => Boolean(activeHandle),
      recheckCredential: async () => {},
    },
    transport: makeTransport({
      readDraft: () => new Promise<Draft>(resolve => { resolveDraft = resolve }),
    }),
  })

  const pending = adapter.loadDraft(12, new AbortController().signal)
  // Account switched before the in-flight draft load returned.
  activeHandle = 'account-b'
  resolveDraft(baseDraft)
  assert.deepEqual(await pending, { kind: 'blocked', reason: 'unavailable' })

  // Summary reply that alters title/body is rejected.
  const summaryAdapter = createWriteCommandAdapter({
    session: {
      currentHandle: () => 'account-b',
      hasSession: () => true,
      recheckCredential: async () => {},
    },
    transport: makeTransport({
      saveDraftSummary: async () => ({ ...baseDraft, body: 'altered by server', revision: 5n }),
    }),
  })
  assert.deepEqual(await summaryAdapter.updateSummary('summary')(baseDraft, new AbortController().signal, 'k-sum'), {
    kind: 'blocked',
    reason: 'unavailable',
  })
})
