import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/Contracts/aeds.ts'
import type { Session } from '../../src/Contracts/client.ts'
import type { ArticleCommand, Draft } from '../../src/Contracts/wire.generated.ts'
import { acceptEditorSourceHandoff, offerSearchEditorHandoff } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import type { RecoveryCandidate } from '../../src/Web/src/authoring/draftJournal.ts'
import { createSourceHandoffCoordinator } from '../../src/Web/src/authoring/sourceHandoffCoordinator.ts'
import {
  createWriteCommandAdapter,
  isSessionMismatchError,
  selectSaveTransport,
  sessionMismatchMessage,
  type WriteCommandTransportPort,
} from '../../src/Web/src/authoring/writeCommandAdapter.ts'
import {
  articleRouteDestination,
  articleRouteId,
  createWriteWorkspaceController,
  parseArticleIdInput,
  type ProtectedCloseChoice,
  type WorkspacePersistencePort,
  type WorkspaceRecoveryPort,
  type WorkspaceRouterPort,
} from '../../src/Web/src/authoring/writeWorkspaceController.ts'
import { expectFields } from './authoringFixture.ts'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  name: 'author-a', canAuthor: true, generation: 1n, expiresAt: 10_000_000,
  siteSessionId: 'a'.repeat(64), ...overrides,
})

const makeDraft = (overrides: Partial<Draft> = {}): Draft => ({
  id: 10, revision: 3n, title: 'Saved Title', body: 'Saved body', published: false, ...overrides,
})

interface HarnessOptions {
  initialArticleId?: number
  initialPersistentWorkspace?: boolean
  initialAuthorizationReady?: boolean
  initialToken?: unknown
  transport?: Partial<WriteCommandTransportPort>
  recovery?: Partial<WorkspaceRecoveryPort>
  persistence?: Partial<WorkspacePersistencePort>
}

const articlePath = (articleId: number | undefined) =>
  articleId === undefined ? '/admin/articles/workspace' : articleId === 0 ? '/admin/articles/write' : `/admin/articles/edit/${articleId}`
const articleRoute = (articleId: number, identity = 1) => ({ articleId, identity, isValid: () => true })

function createHarness(options: HarnessOptions = {}) {
  let currentSession: Session | null = makeSession()
  let identityEpoch = 1
  let credentialEpoch = 1
  let currentArticleId: number | undefined = options.initialArticleId ?? 10
  let currentPath = articlePath(currentArticleId)
  const now = () => 1_000
  let keyCounter = 0

  const events: string[] = []
  const persistedRecovery: Array<{ draft: Draft; edit: number }> = []
  const discardedArticles: Array<{ id: number; sessionId: number; edit: number }> = []
  const recentOpens: Array<{ articleId: number; revision: bigint }> = []
  const pendingTicks: Array<() => void> = []
  const recheckCalls: string[] = []
  const routerCalls: string[] = []
  let recoveryCandidates: RecoveryCandidate[] = []
  let recoveryGuarded = false
  let leaveDecision = true
  let protectedCloseDecision: ProtectedCloseChoice = 'keep'
  let refreshSessionImpl: (signal: AbortSignal, reuseInFlight: boolean) => Promise<void> = async () => {}
  let recheckImpl: (handle: string, signal: AbortSignal) => Promise<void> = async handle => { recheckCalls.push(handle) }

  const drafts = new Map<number, Draft>([
    [10, makeDraft({ id: 10, revision: 3n, title: 'Article 10', body: 'Body 10' })],
    [11, makeDraft({ id: 11, revision: 5n, title: 'Article 11', body: 'Body 11' })],
  ])

  const saveBody = (input: Pick<ArticleCommand, 'id' | 'expectedRevision' | 'title' | 'body'>): Draft => {
    const saved = { id: input.id, revision: input.expectedRevision + 1n, title: input.title, body: input.body, published: drafts.get(input.id)?.published ?? false }
    drafts.set(input.id, saved)
    return saved
  }
  const revisedDraft = (id: number, revision: bigint): Draft => ({ ...(drafts.get(id) ?? makeDraft({ id })), revision: revision + 1n })

  const commands = createWriteCommandAdapter({
    session: {
      currentHandle: () => currentSession?.siteSessionId,
      hasSession: () => Boolean(currentSession),
      recheckCredential: (handle, signal) => recheckImpl(handle, signal),
    },
    transport: {
      readDraft: async (id, _signal, handle) => {
        events.push(`readDraft:${id}:${handle.slice(0, 4)}`)
        const item = drafts.get(id)
        if (!item) throw new ApiError('Not found', 404)
        return structuredClone(item)
      },
      articleAction: async (action, input, _signal, handle) => {
        events.push(`full:${action}:${input.id}:${input.idempotencyKey}:${handle.slice(0, 4)}`)
        const nextId = input.id === 0 ? 99 : input.id
        const saved: Draft = {
          id: nextId, revision: input.expectedRevision + 1n,
          title: action === 'save' ? input.title : (drafts.get(nextId)?.title ?? ''),
          body: action === 'save' ? input.body : (drafts.get(nextId)?.body ?? ''),
          published: action === 'publish' ? true : action === 'retract' ? false : (drafts.get(nextId)?.published ?? false),
        }
        drafts.set(nextId, saved)
        return saved
      },
      saveWithBodyInsertion: async (input, handle) => (events.push(`insertion:${input.id}:${input.offset}:${input.length}:${handle.slice(0, 4)}`), saveBody(input)),
      saveWithBodyInsertions: async (input, handle) => (events.push(`insertions:${input.id}:${input.insertions.length}:${handle.slice(0, 4)}`), saveBody(input)),
      saveWithBodyEdits: async (input, handle) => (events.push(`edits:${input.id}:${input.edits.length}:${handle.slice(0, 4)}`), saveBody(input)),
      assignTaxonomy: async input => ({ id: input.id, revision: input.expectedRevision + 1n }),
      rollbackDraft: async input => revisedDraft(input.id, input.expectedRevision),
      setArticleSchedule: async input => ({ revision: input.expectedRevision + 1n, publishedRevision: 0n }),
      setDraftRights: async input => ({ revision: input.expectedRevision + 1n }),
      editArticleMedia: async (id, revision) => revisedDraft(id, revision),
      saveDraftSummary: async (input, handle) => (events.push(`summary:${input.id}:${handle.slice(0, 4)}`), revisedDraft(input.id, input.expectedRevision)),
      publishArticleImages: async (id, revision, _key, _assets, handle) =>
        (events.push(`publishImages:${id}:${handle.slice(0, 4)}`), { ...revisedDraft(id, revision), published: true }),
      ...options.transport,
    },
  })

  const handoff = createSourceHandoffCoordinator({
    initialToken: options.initialToken, initialArticleId: currentArticleId, accept: acceptEditorSourceHandoff, now, nowMs: now,
  })

  const router: WorkspaceRouterPort = {
    articleId: () => currentArticleId,
    path: () => currentPath,
    resolveArticlePath: articlePath,
    pushArticle: async (id, persistent) => {
      const toPath = articlePath(id)
      routerCalls.push(`push:${id}:${persistent}`)
      if (!(await controller.beforeRouteUpdate({ toPath, fromPath: currentPath, toArticleId: id }))) return true
      currentArticleId = id
      currentPath = toPath
      return false
    },
    replaceArticle: async (id, persistent) => {
      routerCalls.push(`replace:${id}:${persistent}`)
      currentArticleId = id
      currentPath = articlePath(id)
      return false
    },
    replaceWorkspace: async persistent => {
      routerCalls.push(`replaceWorkspace:${persistent}`)
      currentArticleId = undefined
      currentPath = '/admin/articles/workspace'
      return false
    },
  }

  const controller = createWriteWorkspaceController({
    origin: 'https://blog.example',
    initialPersistentWorkspace: options.initialPersistentWorkspace ?? false,
    initialAuthorizationReady: options.initialAuthorizationReady ?? true,
    commands,
    handoff,
    session: {
      current: () => currentSession,
      identityEpoch: () => identityEpoch,
      credentialEpoch: () => credentialEpoch,
      refreshSession: (signal, reuseInFlight) => refreshSessionImpl(signal, reuseInFlight),
    },
    recovery: {
      candidates: () => recoveryCandidates,
      guarded: () => recoveryGuarded,
      setCurrent: () => {},
      persist: (draft, edit) => { persistedRecovery.push({ draft: structuredClone(draft), edit }) },
      confirmed: () => true,
      remove: async candidate => ((recoveryCandidates = recoveryCandidates.filter(item => item !== candidate)), true),
      discardArticle: (id, sessionId, edit) => { discardedArticles.push({ id, sessionId, edit }) },
      verifyCloseCopies: async () => true,
      discardCloseCopies: async () => true,
      dismissCandidates: () => { recoveryCandidates = [] },
      close: () => { events.push('recovery:close') },
      ...options.recovery,
    },
    persistence: {
      reset: () => { events.push('persistence:reset') },
      restore: async () => { events.push('persistence:restore') },
      rebind: handle => { events.push(`persistence:rebind:${handle.slice(0, 4)}`) },
      changed: () => {},
      flush: async () => { events.push('persistence:flush') },
      ...options.persistence,
    },
    router,
    confirm: {
      confirmProtectedClose: async () => protectedCloseDecision,
      confirmDiscardTab: async () => true,
      confirmLeave: async () => leaveDecision,
    },
    format: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    recordRecentOpen: (articleId, revision) => { recentOpens.push({ articleId, revision }) },
    scheduleTick: cb => { pendingTicks.push(cb) },
    nowMs: now,
    newRequestKey: () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`,
  })
  controller.syncIdentity(currentSession, identityEpoch)

  return {
    controller, handoff, events, persistedRecovery, discardedArticles, recheckCalls, routerCalls,
    open: (articleId = currentArticleId!, identity = identityEpoch) => controller.syncRoute(articleRoute(articleId, identity)),
    snap: () => controller.snapshot(),
    flags: () => controller.flags(),
    save: () => controller.submit('save'),
    assertOriginal: (title: string, body: string) => expectFields(controller.snapshot().original, { title, body }),
    editCurrent: (field: 'body' | 'title', value: string) => controller.edit(controller.snapshot().sourcePanes[0]!, field, value),
    getSession: () => currentSession,
    setSession(next: Session | null, bumpIdentity = false, bumpCredential = false) {
      currentSession = next
      if (bumpIdentity) identityEpoch++
      if (bumpCredential || bumpIdentity) credentialEpoch++
      controller.syncIdentity(currentSession, identityEpoch)
      if (bumpIdentity) controller.onIdentityEpochChanged()
      if (bumpCredential || bumpIdentity) handoff.onCredentialEpochChange()
    },
    setRoute: (articleId: number | undefined) => { currentArticleId = articleId; currentPath = articlePath(articleId) },
    setRecoveryState: (candidates: RecoveryCandidate[], guarded: boolean) => { recoveryCandidates = candidates; recoveryGuarded = guarded },
    setLeaveDecision: (value: boolean) => { leaveDecision = value },
    setProtectedCloseDecision: (value: ProtectedCloseChoice) => { protectedCloseDecision = value },
    setRefreshSession: (fn: (signal: AbortSignal, reuseInFlight: boolean) => Promise<void>) => { refreshSessionImpl = fn },
    setRecheck: (fn: (handle: string, signal: AbortSignal) => Promise<void>) => { recheckImpl = fn },
    flushTicks: () => { while (pendingTicks.length) pendingTicks.shift()!() },
    getIdentityEpoch: () => identityEpoch,
  }
}

async function openHarness(options: HarnessOptions = {}) {
  const h = createHarness(options)
  await h.open()
  return h
}

function deferredAbortable<T>() {
  const deferred = Promise.withResolvers<T>()
  const started = Promise.withResolvers<void>()
  const state = { aborted: false, resolve: deferred.resolve }
  return {
    state,
    started,
    promise: (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { state.aborted = true })
      started.resolve()
      return deferred.promise
    },
  }
}

test('route and input helpers parse valid article routes and reject out-of-range inputs', () => {
  assert.equal(articleRouteId('write', undefined), 0)
  assert.equal(articleRouteId('edit', '42'), 42)
  assert.equal(articleRouteId('article-workspace', undefined), undefined)
  assert.deepEqual(articleRouteDestination(0), { name: 'write' })
  assert.deepEqual(articleRouteDestination(42), { name: 'edit', params: { id: 42 } })
  for (const [raw, expected] of [[' 42 ', 42], ['0', undefined], ['2147483648', undefined], ['42abc', undefined]] as const)
    assert.equal(parseArticleIdInput(raw), expected)
})

test('dirty state, metadata guards, IME composition, delta/full save, and CAS 409 conflict preserve edits', async () => {
  const h = await openHarness({ initialArticleId: 10 })
  expectFields(h.flags(), { editable: true, dirty: false })
  assert.equal(h.controller.shouldPreventUnload(), false)

  h.controller.setTaxonomyDirty(true)
  expectFields(h.flags(), { dirty: true, canSwitch: false })
  const pane = h.snap().sourcePanes[0]!
  assert.equal(h.controller.edit(pane, 'body', 'Blocked while taxonomy dirty'), false)
  h.controller.setTaxonomyDirty(false)

  h.controller.changeComposition(pane, true)
  assert.equal(h.flags().canSwitch, false)
  h.controller.changeComposition(pane, false)
  assert.equal(h.flags().canSwitch, false)
  h.flushTicks()
  assert.equal(h.flags().canSwitch, true)

  assert.equal(h.controller.edit(pane, 'body', 'Body 10!', [{ offset: 7, removedLength: 0, insert: '!' }]), true)
  assert.equal(h.flags().articleDirty, true)
  assert.equal(h.controller.shouldPreventUnload(), true)
  assert.equal(h.persistedRecovery.length, 1)
  await h.save()
  assert.equal(h.snap().notice, 'author.write.draftSaved')
  assert.equal(h.flags().dirty, false)
  assert.ok(h.events.includes('insertion:10:7:1:aaaa'))

  assert.equal(h.controller.edit(h.snap().sourcePanes[0]!, 'body', 'Text 10!', [{ offset: 0, removedLength: 4, insert: 'Text' }]), true)
  await h.save()
  assert.ok(h.events.includes('edits:10:1:aaaa'))

  const conflict = await openHarness({
    initialArticleId: 10,
    transport: { articleAction: async () => { throw new ApiError('CAS conflict', 409) } },
  })
  conflict.editCurrent('title', 'Conflicting Title')
  await conflict.save()
  assert.equal(conflict.flags().hasConflict, true)
  assert.equal(conflict.snap().failure, 'author.write.theServerHasANewerRevisionCopyYour')
  assert.equal(conflict.snap().original?.title, 'Conflicting Title')

  const created = await openHarness({ initialArticleId: 0 })
  created.editCurrent('title', 'Fresh Title')
  created.editCurrent('body', 'Fresh Body')
  await created.save()
  assert.equal(created.snap().original?.id, 99)
  assert.deepEqual(created.routerCalls, ['replace:99:false'])
})

test('critical timing 1: cancelling leave or protected close preserves user input and tab state', async () => {
  const h = await openHarness({ initialArticleId: 10 })
  h.editCurrent('title', 'Keep This Title')
  h.editCurrent('body', 'Keep This Body')

  h.setLeaveDecision(false)
  assert.equal(await h.controller.beforeRouteLeave(), false)
  h.assertOriginal('Keep This Title', 'Keep This Body')
  assert.equal(h.flags().articleDirty, true)
  assert.equal(h.discardedArticles.length, 0)
  assert.equal(h.events.includes('persistence:flush'), false)

  h.setProtectedCloseDecision('cancelled')
  expectFields(await h.controller.closeTab(h.snap().tab!), { outcome: 'cancelled', focusAction: 'restore-trigger' })
  h.assertOriginal('Keep This Title', 'Keep This Body')

  h.setLeaveDecision(true)
  assert.equal(await h.controller.beforeRouteLeave(), true)
  assert.equal(h.discardedArticles.length, 1)
  assert.equal(h.events.includes('persistence:flush'), true)
})

test('critical timing 2: delayed recovery or late load/layout responses cannot overwrite new input', async () => {
  const h = await openHarness({ initialArticleId: 0 })
  h.setRecoveryState([], true)
  assert.equal(h.flags().recoveryBlocked, true)
  assert.equal(h.editCurrent('title', 'Blocked'), false)

  h.setRecoveryState([], false)
  assert.equal(h.editCurrent('title', 'New User Title'), true)
  assert.equal(h.editCurrent('body', 'New User Body'), true)

  const lateCandidate: RecoveryCandidate = {
    writer: 'old-tab', editSequence: 1, baseRevision: 0n,
    title: 'Stale Recovery Title', body: 'Stale Recovery Body', updatedAt: 500, relationship: 'ahead',
  }
  h.setRecoveryState([lateCandidate], false)
  assert.equal(await h.controller.restoreDraft(lateCandidate), false)
  h.assertOriginal('New User Title', 'New User Body')

  const slowDraft = Promise.withResolvers<Draft>()
  const slowStarted = Promise.withResolvers<void>()
  const late = createHarness({
    initialArticleId: 10,
    transport: {
      readDraft: id => id === 10
        ? (slowStarted.resolve(), slowDraft.promise)
        : Promise.resolve(makeDraft({ id: 11, revision: 5n, title: 'Fast 11', body: 'Fast body' })),
    },
  })
  let firstValid = true
  const slowLoad = late.controller.syncRoute({ articleId: 10, identity: 1, isValid: () => firstValid })
  await slowStarted.promise
  firstValid = false
  late.setRoute(11)
  await late.open(11)
  slowDraft.resolve(makeDraft({ id: 10, revision: 3n, title: 'Late 10', body: 'Late body' }))
  await slowLoad
  expectFields(late.snap().original, { id: 11, title: 'Fast 11' })

  let resolveRestore!: () => void
  const layoutHarness = createHarness({
    initialArticleId: undefined,
    initialPersistentWorkspace: true,
    persistence: {
      restore: (_handle, restoreLayout) => new Promise<void>(resolve => {
        resolveRestore = () => {
          void restoreLayout({ tabs: [10], activeArticleId: 10, inspectorOpen: false, secondaryTabs: [], secondaryActiveArticleId: 0, focusedGroup: 0 },
            new AbortController().signal).then(() => resolve())
        }
      }),
    },
  })
  let layoutValid = true
  const pendingRestore = layoutHarness.controller.syncRoute({ articleId: undefined, identity: 1, isValid: () => layoutValid })
  layoutValid = false
  resolveRestore()
  await pendingRestore
  assert.deepEqual(layoutHarness.routerCalls, [])
})

test('critical timing 3: automatic session renewal rebinds handle without rebuilding active workspace', async () => {
  const h = await openHarness({ initialArticleId: 10, initialPersistentWorkspace: true })
  const originalTab = h.snap().tab!
  h.controller.togglePin(originalTab)
  h.controller.setInspectorOpen(true)
  h.editCurrent('title', 'Unsaved Across Renewal')
  h.editCurrent('body', 'Unsaved body across renewal')
  h.events.length = 0

  h.setSession(makeSession({ expiresAt: 20_000_000, siteSessionId: 'b'.repeat(64) }), false, true)
  assert.equal(h.events.includes('persistence:reset'), false)
  assert.ok(h.events.includes('persistence:rebind:bbbb'))
  assert.equal(h.snap().tab?.sessionId, originalTab.sessionId)
  assert.equal(h.snap().inspectorOpen, true)
  h.assertOriginal('Unsaved Across Renewal', 'Unsaved body across renewal')

  await h.save()
  assert.equal(h.snap().notice, 'author.write.draftSaved')
  assert.ok(h.events.some(entry => entry.startsWith('full:save:10:') && entry.endsWith(':bbbb')))
})

test('critical timing 4: switching accounts rejects old draft handles and cross-account 409 session mismatch', async () => {
  const h = await openHarness({ initialArticleId: 10 })
  const oldPane = h.snap().sourcePanes[0]!
  const oldTab = h.snap().tab!
  const oldHandle = h.getSession()!.siteSessionId!
  h.controller.edit(oldPane, 'title', 'Account A Unsaved')

  h.setSession(makeSession({ name: 'author-b', generation: 2n, siteSessionId: 'c'.repeat(64) }), true, true)
  assert.ok(h.events.includes('persistence:reset'))
  assert.equal(h.snap().tab, undefined)
  assert.equal(h.snap().workspaceTabs.length, 0)

  assert.equal(h.controller.edit(oldPane, 'title', 'Injected Into Account B'), false)
  assert.equal((await h.controller.registry.save(oldTab)).kind, 'superseded')

  await h.open(10)
  h.controller.setSummaryDirty(true)
  h.events.length = 0
  await h.controller.saveSummary({ articleId: 10, revision: 3n, credential: oldHandle, text: 'Stale summary' })
  assert.equal(h.events.filter(entry => entry.startsWith('summary:')).length, 0)
  h.controller.setSummaryDirty(false)
  await h.controller.publishSelectedImages({ articleId: 10, revision: 3n, credential: oldHandle, assets: ['asset-1'] })
  assert.equal(h.events.filter(entry => entry.startsWith('publishImages:')).length, 0)

  const mismatch = await openHarness({
    initialArticleId: 0,
    transport: { articleAction: async () => { throw new ApiError(sessionMismatchMessage, 409) } },
  })
  mismatch.setRecheck(async handle => {
    mismatch.recheckCalls.push(handle)
    mismatch.setSession(null, true, true)
  })
  mismatch.editCurrent('title', 'Stale Create')
  mismatch.editCurrent('body', 'Stale Body')
  await mismatch.save()
  assert.equal(mismatch.recheckCalls.length, 1)
  assert.equal(mismatch.flags().hasConflict, false)
  assert.notEqual(mismatch.snap().failure, 'author.write.theServerHasANewerRevisionCopyYour')
})

test('abort and dispose clean up lifetime, recovery, persistence, registry, and ignore late completions', async () => {
  const refresh = deferredAbortable<void>()
  const h = createHarness({ initialArticleId: 10, initialAuthorizationReady: false })
  h.setRefreshSession(refresh.promise)

  const mountCheck = h.controller.mountSessionCheck(false)
  let notifications = 0
  const unsubscribe = h.controller.subscribe(() => { notifications++ })

  h.controller.dispose()
  assert.equal(h.controller.lifetime.signal.aborted, true)
  assert.equal(refresh.state.aborted, true)
  assert.ok(h.events.includes('recovery:close'))
  assert.ok(h.events.includes('persistence:reset'))

  const countAfterDispose = notifications
  refresh.state.resolve()
  await mountCheck
  assert.equal(h.snap().authorizationReady, false)
  assert.equal(notifications, countAfterDispose)
  unsubscribe()

  const save = deferredAbortable<Draft>()
  const saving = await openHarness({
    initialArticleId: 10,
    transport: { articleAction: (_action, _input, signal) => save.promise(signal) },
  })
  saving.editCurrent('title', 'Saving Before Unmount')
  const pendingSave = saving.save()
  await save.started.promise
  saving.controller.dispose()
  assert.equal(save.state.aborted, true)
  save.state.resolve(makeDraft({ id: 10, revision: 4n, title: 'Saving Before Unmount', body: 'Body 10' }))
  await pendingSave
  assert.equal(saving.snap().notice, '')
  assert.deepEqual(saving.routerCalls, [])
})

test('source handoff integrates with syncRoute to activate search seeks and clean up on credential change', async () => {
  const digest = Uint8Array.from({ length: 32 }, (_, index) => index)
  const token = offerSearchEditorHandoff({
    articleId: 10, revision: 3n, field: 'body', sourceStart: 0, sourceEnd: 4,
    sourceByteStart: 0, sourceByteEnd: 4, sourceDigest: digest, match: 'Body',
  }, 1, 'a'.repeat(64))

  const h = createHarness({ initialArticleId: 10, initialToken: token, initialAuthorizationReady: false })
  await h.controller.mountSessionCheck(false)
  await h.open(10)
  const seek = h.handoff.snapshot().sourceSeek
  assert.ok(seek)
  assert.equal(seek.kind, 'search')
  assert.equal(seek.current(), true)

  h.setSession(makeSession({ siteSessionId: 'd'.repeat(64) }), false, true)
  assert.equal(h.handoff.snapshot().sourceSeek, undefined)
})

test('writeCommandAdapter selects exact transport, verifies save replies, and maps status and handle changes', async () => {
  const baseDraft = makeDraft({ id: 12, revision: 4n, title: '  Draft Title \u3000', body: 'Hello world' })
  const unsupported = () => Promise.reject(new Error('unexpected transport call'))
  const stubTransport = (overrides: Partial<WriteCommandTransportPort> = {}): WriteCommandTransportPort => ({
    readDraft: unsupported, articleAction: unsupported, saveWithBodyInsertion: unsupported,
    saveWithBodyInsertions: unsupported, saveWithBodyEdits: unsupported, assignTaxonomy: unsupported,
    rollbackDraft: unsupported, setArticleSchedule: unsupported, setDraftRights: unsupported,
    editArticleMedia: unsupported, saveDraftSummary: unsupported, publishArticleImages: unsupported, ...overrides,
  })
  const authAdapter = (handle: string, transport: Partial<WriteCommandTransportPort>) => createWriteCommandAdapter({
    session: { currentHandle: () => handle, hasSession: () => true, recheckCredential: async () => {} },
    transport: stubTransport(transport),
  })
  const bodyEdit = (offset: number, removedLength: number, insert: string) => ({ offset, removedLength, insert })

  const full = selectSaveTransport('save', baseDraft, 'k-full')
  expectFields(full, { kind: 'full', action: 'save' })
  expectFields(full.input, { title: 'Draft Title', body: 'Hello world' })
  const single = selectSaveTransport('save', baseDraft, 'k-single', [bodyEdit(5, 0, ' brave')])
  assert.equal(single.kind, 'body-insertion')
  expectFields(single.input, { offset: 5, length: 6, title: 'Draft Title' })
  const multi = selectSaveTransport('save', baseDraft, 'k-multi', [bodyEdit(5, 0, ' A'), bodyEdit(13, 0, ' B')])
  assert.equal(multi.kind, 'body-insertions')
  assert.deepEqual(multi.input.insertions, [{ offset: 5, length: 2 }, { offset: 13, length: 2 }])
  const edited = selectSaveTransport('save', baseDraft, 'k-edits', [bodyEdit(5, 0, ' A'), bodyEdit(0, 5, 'Hi')])
  assert.equal(edited.kind, 'body-edits')
  assert.equal(edited.input.edits.length, 2)
  for (const [action, edits] of [['publish', [bodyEdit(0, 0, 'ignored')]], ['retract', undefined]] as const) {
    const selected = selectSaveTransport(action, baseDraft, `k-${action}`, edits)
    expectFields(selected, { kind: 'full', action })
    expectFields(selected.input, { title: '', body: '' })
  }

  const calls: string[] = []
  const savedReply = (call: string, input: Pick<Draft, 'title' | 'body'>) =>
    (calls.push(call), { ...baseDraft, title: input.title, body: input.body, revision: 5n })
  const adapter = authAdapter('handle-a', {
    articleAction: async (action, input) => savedReply(`full:${action}`, input),
    saveWithBodyInsertion: async input => savedReply(`insertion:${input.offset}:${input.length}`, input),
    saveWithBodyInsertions: async input => savedReply(`insertions:${input.insertions.length}`, input),
    saveWithBodyEdits: async input => savedReply(`edits:${input.edits.length}`, input),
  })
  const signal = new AbortController().signal
  const save = adapter.articleCommand('save')
  for (const [key, edits] of [
    ['k1', undefined], ['k2', [bodyEdit(5, 0, '!')]],
    ['k3', [bodyEdit(0, 0, 'a'), bodyEdit(1, 0, 'b')]], ['k4', [bodyEdit(0, 2, 'Hi')]],
  ] as const) assert.equal((await save(baseDraft, signal, key, edits)).kind, 'saved')
  assert.deepEqual(calls, ['full:save', 'insertion:5:1', 'insertions:2', 'edits:1'])

  const tampered = authAdapter('handle-a', { articleAction: async () => ({ ...baseDraft, title: 'Different Title', revision: 5n }) })
  assert.deepEqual(await tampered.articleCommand('save')(baseDraft, signal, 'k5'), { kind: 'blocked', reason: 'unavailable' })

  let activeHandle: string | undefined = 'handle-a'
  let sessionAlive = true
  const rechecked: string[] = []
  let nextError: unknown
  const errAdapter = createWriteCommandAdapter({
    session: {
      currentHandle: () => activeHandle, hasSession: () => sessionAlive,
      recheckCredential: async handle => {
        rechecked.push(handle)
        if (nextError instanceof ApiError && (nextError.status === 401 || isSessionMismatchError(nextError))) {
          sessionAlive = false; activeHandle = undefined
        }
      },
    },
    transport: stubTransport({ articleAction: async () => { throw nextError } }),
  })
  const submit = (key: string, requestSignal = signal) => errAdapter.articleCommand('save')(baseDraft, requestSignal, key)
  for (const [err, key, expected, expectedRechecks] of [
    [new ApiError('stale revision', 409), 'k-cas', { kind: 'conflict' }, []],
    [new ApiError('invalid draft', 400), 'k-400', { kind: 'rejected' }, []],
    [new ApiError('forbidden', 403), 'k-403', { kind: 'blocked', reason: 'forbidden' }, []],
    [new ApiError('missing', 404), 'k-404', { kind: 'blocked', reason: 'missing' }, []],
    [new ApiError(sessionMismatchMessage, 409), 'k-mismatch', { kind: 'blocked', reason: 'expired' }, ['handle-a']],
  ] as const) {
    nextError = err
    assert.deepEqual(await submit(key), expected)
    assert.deepEqual(rechecked, expectedRechecks)
  }
  assert.deepEqual(await submit('k-no-handle'), { kind: 'blocked', reason: 'unavailable' })
  activeHandle = 'handle-b'; sessionAlive = true
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await submit('k-aborted', aborted.signal), { kind: 'blocked', reason: 'unavailable' })

  const deferred = Promise.withResolvers<Draft>()
  let loadHandle: string | undefined = 'account-a'
  const loadAdapter = createWriteCommandAdapter({
    session: { currentHandle: () => loadHandle, hasSession: () => Boolean(loadHandle), recheckCredential: async () => {} },
    transport: stubTransport({ readDraft: () => deferred.promise }),
  })
  const pendingLoad = loadAdapter.loadDraft(12, signal)
  loadHandle = 'account-b'
  deferred.resolve(baseDraft)
  assert.deepEqual(await pendingLoad, { kind: 'blocked', reason: 'unavailable' })

  const summaryAdapter = authAdapter('account-b', {
    saveDraftSummary: async () => ({ ...baseDraft, body: 'altered by server', revision: 5n }),
  })
  assert.deepEqual(await summaryAdapter.updateSummary('summary')(baseDraft, signal, 'k-sum'), { kind: 'blocked', reason: 'unavailable' })
})
