import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/Contracts/aeds.ts'
import type { Session } from '../../src/Contracts/client.ts'
import type { ArticleCommand, Draft } from '../../src/Contracts/wire.generated.ts'
import {
  acceptEditorSourceHandoff,
  offerSearchEditorHandoff,
} from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import type { RecoveryCandidate } from '../../src/Web/src/authoring/draftJournal.ts'
import { createSourceHandoffCoordinator } from '../../src/Web/src/authoring/sourceHandoffCoordinator.ts'
import {
  createWriteCommandAdapter,
  sessionMismatchMessage,
  type WriteCommandTransportPort,
} from '../../src/Web/src/authoring/writeCommandAdapter.ts'
import {
  articleRouteDestination,
  articleRouteId,
  createWriteWorkspaceController,
  parseArticleIdInput,
  type ProtectedCloseChoice,
  type WorkspaceConfirmPort,
  type WorkspacePersistencePort,
  type WorkspaceRecoveryPort,
  type WorkspaceRouterPort,
} from '../../src/Web/src/authoring/writeWorkspaceController.ts'
import type { SavedWorkspaceLayout } from '../../src/Web/src/authoring/workspaceRegistry.ts'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    name: 'author-a',
    canAuthor: true,
    generation: 1n,
    expiresAt: 10_000_000,
    siteSessionId: 'a'.repeat(64),
    ...overrides,
  }
}

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 10,
    revision: 3n,
    title: 'Saved Title',
    body: 'Saved body',
    published: false,
    ...overrides,
  }
}

interface HarnessOptions {
  initialArticleId?: number
  initialPersistentWorkspace?: boolean
  initialAuthorizationReady?: boolean
  initialToken?: unknown
  transport?: Partial<WriteCommandTransportPort>
  recovery?: Partial<WorkspaceRecoveryPort>
  persistence?: Partial<WorkspacePersistencePort>
}

function articlePath(articleId: number | undefined) {
  if (articleId === undefined) return '/admin/articles/workspace'
  return articleId === 0 ? '/admin/articles/write' : `/admin/articles/edit/${articleId}`
}

function articleRoute(articleId: number, identity = 1) {
  return { articleId, identity, isValid: () => true }
}

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
  let refreshSessionImpl: (signal: AbortSignal, reuseInFlight: boolean) => Promise<void> = async () => {}

  const drafts = new Map<number, Draft>([
    [10, makeDraft({ id: 10, revision: 3n, title: 'Article 10', body: 'Body 10' })],
    [11, makeDraft({ id: 11, revision: 5n, title: 'Article 11', body: 'Body 11' })],
  ])

  function saveBody(input: Pick<ArticleCommand, 'id' | 'expectedRevision' | 'title' | 'body'>): Draft {
    const saved = {
      id: input.id,
      revision: input.expectedRevision + 1n,
      title: input.title,
      body: input.body,
      published: drafts.get(input.id)?.published ?? false,
    }
    drafts.set(input.id, saved)
    return saved
  }

  function revisedDraft(id: number, revision: bigint): Draft {
    return { ...(drafts.get(id) ?? makeDraft({ id })), revision: revision + 1n }
  }

  const defaultTransport: WriteCommandTransportPort = {
    readDraft: async (id, _signal, handle) => {
      events.push(`readDraft:${id}:${handle.slice(0, 4)}`)
      const draft = drafts.get(id)
      if (!draft) throw new ApiError('Not found', 404)
      return structuredClone(draft)
    },
    articleAction: async (action, input, _signal, handle) => {
      events.push(`full:${action}:${input.id}:${input.idempotencyKey}:${handle.slice(0, 4)}`)
      const nextId = input.id === 0 ? 99 : input.id
      const saved: Draft = {
        id: nextId,
        revision: input.expectedRevision + 1n,
        title: action === 'save' ? input.title : (drafts.get(nextId)?.title ?? ''),
        body: action === 'save' ? input.body : (drafts.get(nextId)?.body ?? ''),
        published: action === 'publish' ? true : action === 'retract' ? false : (drafts.get(nextId)?.published ?? false),
      }
      drafts.set(nextId, saved)
      return saved
    },
    saveWithBodyInsertion: async (input, handle) => {
      events.push(`insertion:${input.id}:${input.offset}:${input.length}:${handle.slice(0, 4)}`)
      return saveBody(input)
    },
    saveWithBodyInsertions: async (input, handle) => {
      events.push(`insertions:${input.id}:${input.insertions.length}:${handle.slice(0, 4)}`)
      return saveBody(input)
    },
    saveWithBodyEdits: async (input, handle) => {
      events.push(`edits:${input.id}:${input.edits.length}:${handle.slice(0, 4)}`)
      return saveBody(input)
    },
    assignTaxonomy: async input => ({ id: input.id, revision: input.expectedRevision + 1n }),
    rollbackDraft: async input => revisedDraft(input.id, input.expectedRevision),
    setArticleSchedule: async input => ({ revision: input.expectedRevision + 1n, publishedRevision: 0n }),
    setDraftRights: async input => ({ revision: input.expectedRevision + 1n }),
    editArticleMedia: async (id, revision) => revisedDraft(id, revision),
    saveDraftSummary: async (input, handle) => {
      events.push(`summary:${input.id}:${handle.slice(0, 4)}`)
      return revisedDraft(input.id, input.expectedRevision)
    },
    publishArticleImages: async (id, revision, _key, _assets, handle) => {
      events.push(`publishImages:${id}:${handle.slice(0, 4)}`)
      return { ...revisedDraft(id, revision), published: true }
    },
    ...options.transport,
  }

  let recheckImpl: (handle: string, signal: AbortSignal) => Promise<void> = async handle => {
    recheckCalls.push(handle)
  }

  const commands = createWriteCommandAdapter({
    session: {
      currentHandle: () => currentSession?.siteSessionId,
      hasSession: () => Boolean(currentSession),
      recheckCredential: (handle, signal) => recheckImpl(handle, signal),
    },
    transport: defaultTransport,
  })

  const handoff = createSourceHandoffCoordinator({
    initialToken: options.initialToken,
    initialArticleId: currentArticleId,
    accept: acceptEditorSourceHandoff,
    now,
    nowMs: now,
  })

  const recovery: WorkspaceRecoveryPort = {
    candidates: () => recoveryCandidates,
    guarded: () => recoveryGuarded,
    setCurrent: () => {},
    persist: (draft, edit) => { persistedRecovery.push({ draft: structuredClone(draft), edit }) },
    confirmed: () => true,
    remove: async candidate => {
      recoveryCandidates = recoveryCandidates.filter(item => item !== candidate)
      return true
    },
    discardArticle: (id, sessionId, edit) => { discardedArticles.push({ id, sessionId, edit }) },
    verifyCloseCopies: async () => true,
    discardCloseCopies: async () => true,
    dismissCandidates: () => { recoveryCandidates = [] },
    close: () => { events.push('recovery:close') },
    ...options.recovery,
  }

  const persistence: WorkspacePersistencePort = {
    reset: () => { events.push('persistence:reset') },
    restore: async () => { events.push('persistence:restore') },
    rebind: handle => { events.push(`persistence:rebind:${handle.slice(0, 4)}`) },
    changed: () => {},
    flush: async () => { events.push('persistence:flush') },
    ...options.persistence,
  }

  const router: WorkspaceRouterPort = {
    articleId: () => currentArticleId,
    path: () => currentPath,
    resolveArticlePath: articlePath,
    pushArticle: async (id, persistent) => {
      const toPath = articlePath(id)
      const fromPath = currentPath
      routerCalls.push(`push:${id}:${persistent}`)
      const allowed = await controller.beforeRouteUpdate({ toPath, fromPath, toArticleId: id })
      if (!allowed) return true
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

  let leaveDecision = true
  let protectedCloseDecision: ProtectedCloseChoice = 'keep'

  const confirm: WorkspaceConfirmPort = {
    confirmProtectedClose: async () => protectedCloseDecision,
    confirmDiscardTab: async () => true,
    confirmLeave: async () => leaveDecision,
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
    recovery,
    persistence,
    router,
    confirm,
    format: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    recordRecentOpen: (articleId, revision) => { recentOpens.push({ articleId, revision }) },
    scheduleTick: cb => { pendingTicks.push(cb) },
    nowMs: now,
    newRequestKey: () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`,
  })

  controller.syncIdentity(currentSession, identityEpoch)

  return {
    controller,
    handoff,
    events,
    persistedRecovery,
    discardedArticles,
    recheckCalls,
    routerCalls,
    assertOriginal(title: string, body: string) {
      assert.equal(controller.snapshot().original?.title, title)
      assert.equal(controller.snapshot().original?.body, body)
    },
    editCurrent(field: 'body' | 'title', value: string) {
      return controller.edit(controller.snapshot().sourcePanes[0]!, field, value)
    },
    getSession: () => currentSession,
    setSession(next: Session | null, bumpIdentity = false, bumpCredential = false) {
      currentSession = next
      if (bumpIdentity) identityEpoch++
      if (bumpCredential || bumpIdentity) credentialEpoch++
      controller.syncIdentity(currentSession, identityEpoch)
      if (bumpIdentity) controller.onIdentityEpochChanged()
      if (bumpCredential || bumpIdentity) handoff.onCredentialEpochChange()
    },
    setRoute(articleId: number | undefined) {
      currentArticleId = articleId
      currentPath = articlePath(articleId)
    },
    setRecoveryState(candidates: RecoveryCandidate[], guarded: boolean) {
      recoveryCandidates = candidates
      recoveryGuarded = guarded
    },
    setLeaveDecision(value: boolean) { leaveDecision = value },
    setProtectedCloseDecision(value: ProtectedCloseChoice) { protectedCloseDecision = value },
    setRefreshSession(fn: (signal: AbortSignal, reuseInFlight: boolean) => Promise<void>) { refreshSessionImpl = fn },
    setRecheck(fn: (handle: string, signal: AbortSignal) => Promise<void>) { recheckImpl = fn },
    flushTicks() { while (pendingTicks.length) pendingTicks.shift()!() },
    getIdentityEpoch: () => identityEpoch,
  }
}

test('route and input helpers parse valid article routes and reject out-of-range inputs', () => {
  assert.equal(articleRouteId('write', undefined), 0)
  assert.equal(articleRouteId('edit', '42'), 42)
  assert.equal(articleRouteId('article-workspace', undefined), undefined)
  assert.deepEqual(articleRouteDestination(0), { name: 'write' })
  assert.deepEqual(articleRouteDestination(42), { name: 'edit', params: { id: 42 } })
  assert.equal(parseArticleIdInput(' 42 '), 42)
  assert.equal(parseArticleIdInput('0'), undefined)
  assert.equal(parseArticleIdInput('2147483648'), undefined)
  assert.equal(parseArticleIdInput('42abc'), undefined)
})

test('dirty state, metadata guards, IME composition, delta/full save, and CAS 409 conflict preserve edits', async () => {
  const h = createHarness({ initialArticleId: 10 })
  await h.controller.syncRoute(articleRoute(10))
  assert.equal(h.controller.flags().editable, true)
  assert.equal(h.controller.flags().dirty, false)
  assert.equal(h.controller.shouldPreventUnload(), false)

  // Metadata dirty blocks editing and switching, then resets when revision advances.
  h.controller.setTaxonomyDirty(true)
  assert.equal(h.controller.flags().dirty, true)
  assert.equal(h.controller.flags().canSwitch, false)
  const pane = h.controller.snapshot().sourcePanes[0]!
  assert.equal(h.controller.edit(pane, 'body', 'Blocked while taxonomy dirty'), false)
  h.controller.setTaxonomyDirty(false)

  // Composition blocks switching until the tick after composition ends.
  h.controller.changeComposition(pane, true)
  assert.equal(h.controller.flags().canSwitch, false)
  h.controller.changeComposition(pane, false)
  assert.equal(h.controller.flags().canSwitch, false)
  h.flushTicks()
  assert.equal(h.controller.flags().canSwitch, true)

  // Single insertion uses delta saveWithBodyInsertion.
  assert.equal(h.controller.edit(pane, 'body', 'Body 10!', [{ offset: 7, removedLength: 0, insert: '!' }]), true)
  assert.equal(h.controller.flags().articleDirty, true)
  assert.equal(h.controller.shouldPreventUnload(), true)
  assert.equal(h.persistedRecovery.length, 1)
  await h.controller.submit('save')
  assert.equal(h.controller.snapshot().notice, 'author.write.draftSaved')
  assert.equal(h.controller.flags().dirty, false)
  assert.ok(h.events.includes('insertion:10:7:1:aaaa'))

  // Replacement edit uses saveWithBodyEdits.
  const paneAfterSave = h.controller.snapshot().sourcePanes[0]!
  assert.equal(h.controller.edit(paneAfterSave, 'body', 'Text 10!', [{ offset: 0, removedLength: 4, insert: 'Text' }]), true)
  await h.controller.submit('save')
  assert.ok(h.events.includes('edits:10:1:aaaa'))

  // CAS 409 conflict marks conflict, sets failure message, and retains local input.
  const conflictHarness = createHarness({
    initialArticleId: 10,
    transport: {
      articleAction: async () => { throw new ApiError('CAS conflict', 409) },
    },
  })
  await conflictHarness.controller.syncRoute(articleRoute(10))
  const conflictPane = conflictHarness.controller.snapshot().sourcePanes[0]!
  conflictHarness.controller.edit(conflictPane, 'title', 'Conflicting Title')
  await conflictHarness.controller.submit('save')
  assert.equal(conflictHarness.controller.flags().hasConflict, true)
  assert.equal(conflictHarness.controller.snapshot().failure, 'author.write.theServerHasANewerRevisionCopyYour')
  assert.equal(conflictHarness.controller.snapshot().original?.title, 'Conflicting Title')

  // Creating a brand-new draft replaces route to the assigned article ID on save.
  const createHarnessObj = createHarness({ initialArticleId: 0 })
  await createHarnessObj.controller.syncRoute(articleRoute(0))
  const newPane = createHarnessObj.controller.snapshot().sourcePanes[0]!
  createHarnessObj.controller.edit(newPane, 'title', 'Fresh Title')
  createHarnessObj.editCurrent('body', 'Fresh Body')
  await createHarnessObj.controller.submit('save')
  assert.equal(createHarnessObj.controller.snapshot().original?.id, 99)
  assert.deepEqual(createHarnessObj.routerCalls, ['replace:99:false'])
})

test('critical timing 1: cancelling leave or protected close preserves user input and tab state', async () => {
  const h = createHarness({ initialArticleId: 10 })
  await h.controller.syncRoute(articleRoute(10))
  const pane = h.controller.snapshot().sourcePanes[0]!
  h.controller.edit(pane, 'title', 'Keep This Title')
  h.editCurrent('body', 'Keep This Body')

  // Cancel route leave.
  h.setLeaveDecision(false)
  assert.equal(await h.controller.beforeRouteLeave(), false)
  h.assertOriginal('Keep This Title', 'Keep This Body')
  assert.equal(h.controller.flags().articleDirty, true)
  assert.equal(h.discardedArticles.length, 0)
  assert.equal(h.events.includes('persistence:flush'), false)

  // Cancel protected close tab.
  h.setProtectedCloseDecision('cancelled')
  const closeResult = await h.controller.closeTab(h.controller.snapshot().tab!)
  assert.equal(closeResult.outcome, 'cancelled')
  assert.equal(closeResult.focusAction, 'restore-trigger')
  h.assertOriginal('Keep This Title', 'Keep This Body')

  // Confirm leave discards and flushes persistence.
  h.setLeaveDecision(true)
  assert.equal(await h.controller.beforeRouteLeave(), true)
  assert.equal(h.discardedArticles.length, 1)
  assert.equal(h.events.includes('persistence:flush'), true)
})

test('critical timing 2: delayed recovery or late load/layout responses cannot overwrite new input', async () => {
  const h = createHarness({ initialArticleId: 0 })
  await h.controller.syncRoute(articleRoute(0))

  // Recovery initially guards input while checking.
  h.setRecoveryState([], true)
  assert.equal(h.controller.flags().recoveryBlocked, true)
  assert.equal(h.editCurrent('title', 'Blocked'), false)

  // Recovery times out -> guard clears -> user enters new draft.
  h.setRecoveryState([], false)
  assert.equal(h.editCurrent('title', 'New User Title'), true)
  assert.equal(h.editCurrent('body', 'New User Body'), true)

  // A delayed recovery candidate arrives later; restoreDraft must refuse to overwrite dirty edits.
  const lateCandidate: RecoveryCandidate = {
    writer: 'old-tab',
    editSequence: 1,
    baseRevision: 0n,
    title: 'Stale Recovery Title',
    body: 'Stale Recovery Body',
    updatedAt: 500,
    relationship: 'ahead',
  }
  h.setRecoveryState([lateCandidate], false)
  assert.equal(await h.controller.restoreDraft(lateCandidate), false)
  h.assertOriginal('New User Title', 'New User Body')

  // Late syncRoute draft load after route superseded cannot overwrite current state.
  let resolveSlowDraft!: (draft: Draft) => void
  const slowStarted = Promise.withResolvers<void>()
  const lateHarness = createHarness({
    initialArticleId: 10,
    transport: {
      readDraft: id => id === 10
        ? new Promise<Draft>(resolve => {
            resolveSlowDraft = resolve
            slowStarted.resolve()
          })
        : Promise.resolve(makeDraft({ id: 11, revision: 5n, title: 'Fast 11', body: 'Fast body' })),
    },
  })
  let firstValid = true
  const slowLoad = lateHarness.controller.syncRoute({ articleId: 10, identity: 1, isValid: () => firstValid })
  await slowStarted.promise
  firstValid = false
  lateHarness.setRoute(11)
  await lateHarness.controller.syncRoute(articleRoute(11))
  resolveSlowDraft(makeDraft({ id: 10, revision: 3n, title: 'Late 10', body: 'Late body' }))
  await slowLoad
  assert.equal(lateHarness.controller.snapshot().original?.id, 11)
  assert.equal(lateHarness.controller.snapshot().original?.title, 'Fast 11')

  // Late persistence.restore finishing after invalidation must not call router.replaceArticle.
  let resolveRestore!: () => void
  const layoutHarness = createHarness({
    initialArticleId: undefined,
    initialPersistentWorkspace: true,
    persistence: {
      restore: (_handle, restoreLayout) => new Promise<void>(resolve => {
        resolveRestore = () => {
          const layout: SavedWorkspaceLayout = {
            tabs: [10],
            activeArticleId: 10,
            inspectorOpen: false,
            secondaryTabs: [],
            secondaryActiveArticleId: 0,
            focusedGroup: 0,
          }
          void restoreLayout(layout, new AbortController().signal).then(() => resolve())
        }
      }),
    },
  })
  let layoutValid = true
  const pendingRestore = layoutHarness.controller.syncRoute({
    articleId: undefined,
    identity: 1,
    isValid: () => layoutValid,
  })
  layoutValid = false
  resolveRestore()
  await pendingRestore
  assert.deepEqual(layoutHarness.routerCalls, [])
})

test('critical timing 3: automatic session renewal rebinds handle without rebuilding active workspace', async () => {
  const h = createHarness({
    initialArticleId: 10,
    initialPersistentWorkspace: true,
  })
  await h.controller.syncRoute(articleRoute(10))
  const originalTab = h.controller.snapshot().tab!
  h.controller.togglePin(originalTab)
  h.controller.setInspectorOpen(true)
  h.editCurrent('title', 'Unsaved Across Renewal')
  h.editCurrent('body', 'Unsaved body across renewal')
  h.events.length = 0

  // Session automatically renews within the SAME identity epoch with a rotated handle and later expiry.
  const rotatedHandle = 'b'.repeat(64)
  h.setSession(makeSession({
    expiresAt: 20_000_000,
    siteSessionId: rotatedHandle,
  }), false, true)

  assert.equal(h.events.includes('persistence:reset'), false)
  assert.ok(h.events.includes('persistence:rebind:bbbb'))
  assert.equal(h.controller.snapshot().tab?.sessionId, originalTab.sessionId)
  assert.equal(h.controller.snapshot().inspectorOpen, true)
  h.assertOriginal('Unsaved Across Renewal', 'Unsaved body across renewal')

  // Saving after renewal submits using the rotated credential handle.
  await h.controller.submit('save')
  assert.equal(h.controller.snapshot().notice, 'author.write.draftSaved')
  assert.ok(h.events.some(entry => entry.startsWith('full:save:10:') && entry.endsWith(':bbbb')))
})

test('critical timing 4: switching accounts rejects old draft handles and cross-account 409 session mismatch', async () => {
  const h = createHarness({ initialArticleId: 10 })
  await h.controller.syncRoute(articleRoute(10))
  const oldPane = h.controller.snapshot().sourcePanes[0]!
  const oldTab = h.controller.snapshot().tab!
  const oldHandle = h.getSession()!.siteSessionId!
  h.controller.edit(oldPane, 'title', 'Account A Unsaved')

  // Switch to Account B (new identity epoch & handle).
  const accountBHandle = 'c'.repeat(64)
  h.setSession(makeSession({
    name: 'author-b',
    generation: 2n,
    siteSessionId: accountBHandle,
  }), true, true)

  assert.ok(h.events.includes('persistence:reset'))
  assert.equal(h.controller.snapshot().tab, undefined)
  assert.equal(h.controller.snapshot().workspaceTabs.length, 0)

  // Stale handle / tab / pane operations from Account A are rejected.
  assert.equal(h.controller.edit(oldPane, 'title', 'Injected Into Account B'), false)
  assert.equal((await h.controller.registry.save(oldTab)).kind, 'superseded')

  // Even after Account B opens article 10, operations tagged with Account A's credential handle are rejected.
  await h.controller.syncRoute(articleRoute(10, h.getIdentityEpoch()))
  h.controller.setSummaryDirty(true)
  h.events.length = 0
  await h.controller.saveSummary({
    articleId: 10,
    revision: 3n,
    credential: oldHandle,
    text: 'Stale summary',
  })
  assert.equal(h.events.filter(entry => entry.startsWith('summary:')).length, 0)
  h.controller.setSummaryDirty(false)
  await h.controller.publishSelectedImages({
    articleId: 10,
    revision: 3n,
    credential: oldHandle,
    assets: ['asset-1'],
  })
  assert.equal(h.events.filter(entry => entry.startsWith('publishImages:')).length, 0)

  // Mid-flight cross-account 409 session mismatch triggers credential recheck and does NOT treat it as CAS conflict.
  const mismatchHarness = createHarness({
    initialArticleId: 0,
    transport: {
      articleAction: async () => { throw new ApiError(sessionMismatchMessage, 409) },
    },
  })
  mismatchHarness.setRecheck(async handle => {
    mismatchHarness.recheckCalls.push(handle)
    mismatchHarness.setSession(null, true, true)
  })
  await mismatchHarness.controller.syncRoute(articleRoute(0))
  mismatchHarness.editCurrent('title', 'Stale Create')
  mismatchHarness.editCurrent('body', 'Stale Body')
  await mismatchHarness.controller.submit('save')
  assert.equal(mismatchHarness.recheckCalls.length, 1)
  assert.equal(mismatchHarness.controller.flags().hasConflict, false)
  assert.notEqual(mismatchHarness.controller.snapshot().failure, 'author.write.theServerHasANewerRevisionCopyYour')
})

test('abort and dispose clean up lifetime, recovery, persistence, registry, and ignore late completions', async () => {
  let resolveRefresh!: () => void
  let refreshAborted = false
  let saveAborted = false
  let resolveSave!: (draft: Draft) => void

  const h = createHarness({
    initialArticleId: 10,
    initialAuthorizationReady: false,
    transport: {
      articleAction: (_action, _input, signal) => new Promise<Draft>(resolve => {
        signal.addEventListener('abort', () => { saveAborted = true })
        resolveSave = resolve
      }),
    },
  })
  h.setRefreshSession(signal => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { refreshAborted = true })
    resolveRefresh = resolve
  }))

  const mountCheck = h.controller.mountSessionCheck(false)
  let notifications = 0
  const unsubscribe = h.controller.subscribe(() => { notifications++ })

  h.controller.dispose()
  assert.equal(h.controller.lifetime.signal.aborted, true)
  assert.equal(refreshAborted, true)
  assert.ok(h.events.includes('recovery:close'))
  assert.ok(h.events.includes('persistence:reset'))

  // Late mountSessionCheck resolution after dispose does not flip authorizationReady or emit.
  const countAfterDispose = notifications
  resolveRefresh()
  await mountCheck
  assert.equal(h.controller.snapshot().authorizationReady, false)
  assert.equal(notifications, countAfterDispose)
  unsubscribe()

  // Dispose during an in-flight save aborts the save signal and suppresses route/notice updates.
  const saveStarted = Promise.withResolvers<void>()
  const savingHarness = createHarness({
    initialArticleId: 10,
    transport: {
      articleAction: (_action, _input, signal) => new Promise<Draft>(resolve => {
        signal.addEventListener('abort', () => { saveAborted = true })
        resolveSave = resolve
        saveStarted.resolve()
      }),
    },
  })
  await savingHarness.controller.syncRoute(articleRoute(10))
  savingHarness.editCurrent('title', 'Saving Before Unmount')
  const pendingSave = savingHarness.controller.submit('save')
  await saveStarted.promise
  savingHarness.controller.dispose()
  assert.equal(saveAborted, true)
  resolveSave(makeDraft({ id: 10, revision: 4n, title: 'Saving Before Unmount', body: 'Body 10' }))
  await pendingSave
  assert.equal(savingHarness.controller.snapshot().notice, '')
  assert.deepEqual(savingHarness.routerCalls, [])
})

test('source handoff integrates with syncRoute to activate search seeks and clean up on credential change', async () => {
  const digest = Uint8Array.from({ length: 32 }, (_, index) => index)
  const handle = 'a'.repeat(64)
  const token = offerSearchEditorHandoff({
    articleId: 10,
    revision: 3n,
    field: 'body',
    sourceStart: 0,
    sourceEnd: 4,
    sourceByteStart: 0,
    sourceByteEnd: 4,
    sourceDigest: digest,
    match: 'Body',
  }, 1, handle)

  const h = createHarness({
    initialArticleId: 10,
    initialToken: token,
    initialAuthorizationReady: false,
  })
  await h.controller.mountSessionCheck(false)
  await h.controller.syncRoute(articleRoute(10))
  const seek = h.handoff.snapshot().sourceSeek
  assert.ok(seek)
  assert.equal(seek.kind, 'search')
  assert.equal(seek.current(), true)

  // Rotating credential invalidates the pending search seek.
  h.setSession(makeSession({ siteSessionId: 'd'.repeat(64) }), false, true)
  assert.equal(h.handoff.snapshot().sourceSeek, undefined)
})
