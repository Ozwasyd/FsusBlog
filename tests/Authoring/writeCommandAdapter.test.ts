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

function authenticatedAdapter(handle: string, transport: Partial<WriteCommandTransportPort>) {
  return createWriteCommandAdapter({
    session: { currentHandle: () => handle, hasSession: () => true, recheckCredential: async () => {} },
    transport: makeTransport(transport),
  })
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

function bodyEdit(offset: number, removedLength: number, insert: string) { return {offset,removedLength,insert} }

test('selectSaveTransport chooses full save, single insertion, multiple insertions, body edits, and empty publish/retract payloads', () => {
  const full = selectSaveTransport('save', baseDraft, 'k-full')
  assert.equal(full.kind, 'full')
  assert.equal(full.action, 'save')
  assert.equal(full.input.title, 'Draft Title')
  assert.equal(full.input.body, 'Hello world')

  const single = selectSaveTransport('save', baseDraft, 'k-single', [
    bodyEdit(5, 0, ' brave'),
  ])
  assert.equal(single.kind, 'body-insertion')
  assert.equal(single.input.offset, 5)
  assert.equal(single.input.length, 6)
  assert.equal(single.input.title, 'Draft Title')

  const multi = selectSaveTransport('save', baseDraft, 'k-multi', [
    bodyEdit(5, 0, ' A'),
    bodyEdit(13, 0, ' B'),
  ])
  assert.equal(multi.kind, 'body-insertions')
  assert.deepEqual(multi.input.insertions, [
    { offset: 5, length: 2 },
    { offset: 13, length: 2 },
  ])

  const edited = selectSaveTransport('save', baseDraft, 'k-edits', [
    bodyEdit(5, 0, ' A'),
    bodyEdit(0, 5, 'Hi'),
  ])
  assert.equal(edited.kind, 'body-edits')
  assert.equal(edited.input.edits.length, 2)

  const publish = selectSaveTransport('publish', baseDraft, 'k-pub', [
    bodyEdit(0, 0, 'ignored'),
  ])
  assert.equal(publish.kind, 'full')
  assert.equal(publish.action, 'publish')
  assert.equal(publish.input.title, '')
  assert.equal(publish.input.body, '')

  const retract = selectSaveTransport('retract', baseDraft, 'k-ret')
  assert.equal(retract.kind, 'full')
  assert.equal(retract.action, 'retract')
  assert.equal(retract.input.title, '')
  assert.equal(retract.input.body, '')
})

test('writeCommandAdapter dispatches exact delta/full transport and rejects mismatched save replies', async () => {
  const calls: string[] = []
  function savedReply(call: string, input: Pick<Draft, 'title' | 'body'>) {
    calls.push(call)
    return { ...baseDraft, title: input.title, body: input.body, revision: 5n }
  }
  const adapter = authenticatedAdapter('handle-a', {
    articleAction: async (action, input) => savedReply(`full:${action}`, input),
    saveWithBodyInsertion: async input => savedReply(`insertion:${input.offset}:${input.length}`, input),
    saveWithBodyInsertions: async input => savedReply(`insertions:${input.insertions.length}`, input),
    saveWithBodyEdits: async input => savedReply(`edits:${input.edits.length}`, input),
  })

  const signal = new AbortController().signal
  const save = adapter.articleCommand('save')
  assert.equal((await save(baseDraft, signal, 'k1')).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k2', [bodyEdit(5, 0, '!')])).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k3', [
    bodyEdit(0, 0, 'a'),
    bodyEdit(1, 0, 'b'),
  ])).kind, 'saved')
  assert.equal((await save(baseDraft, signal, 'k4', [bodyEdit(0, 2, 'Hi')])).kind, 'saved')
  assert.deepEqual(calls, ['full:save', 'insertion:5:1', 'insertions:2', 'edits:1'])

  const tampered = authenticatedAdapter('handle-a', {
    articleAction: async () => ({ ...baseDraft, title: 'Different Title', body: baseDraft.body, revision: 5n }),
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

  const submit = (key: string, requestSignal = signal) => save(baseDraft, requestSignal, key)

  // CAS 409 conflict does NOT call recheckCredential.
  assert.deepEqual(await submit('k-cas'), { kind: 'conflict' })
  assert.deepEqual(rechecked, [])

  // 400 validation error -> rejected.
  nextError = new ApiError('invalid draft', 400)
  assert.deepEqual(await submit('k-400'), { kind: 'rejected' })

  // 403 / 404 -> forbidden / missing.
  nextError = new ApiError('forbidden', 403)
  assert.deepEqual(await submit('k-403'), { kind: 'blocked', reason: 'forbidden' })
  nextError = new ApiError('missing', 404)
  assert.deepEqual(await submit('k-404'), { kind: 'blocked', reason: 'missing' })

  // 409 session mismatch triggers credential recheck and reports expired (never CAS conflict).
  nextError = new ApiError(sessionMismatchMessage, 409)
  assert.deepEqual(await submit('k-mismatch'), { kind: 'blocked', reason: 'expired' })
  assert.deepEqual(rechecked, ['handle-a'])

  // Missing handle or already-aborted signal blocks immediately without network calls.
  assert.deepEqual(await submit('k-no-handle'), { kind: 'blocked', reason: 'unavailable' })
  activeHandle = 'handle-b'
  sessionAlive = true
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await submit('k-aborted', aborted.signal), { kind: 'blocked', reason: 'unavailable' })
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
  const summaryAdapter = authenticatedAdapter('account-b', {
    saveDraftSummary: async () => ({ ...baseDraft, body: 'altered by server', revision: 5n }),
  })
  assert.deepEqual(await summaryAdapter.updateSummary('summary')(baseDraft, new AbortController().signal, 'k-sum'), {
    kind: 'blocked',
    reason: 'unavailable',
  })
})
