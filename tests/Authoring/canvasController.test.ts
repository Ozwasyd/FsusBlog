import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ApiError } from '../../src/Contracts/client.ts'
import {
  defaultCanvasViewport,
  type CanvasGraphCommand,
  type CanvasGraphEdge,
  type CanvasGraphHeader,
  type CanvasGraphHistory,
  type CanvasGraphPage,
  type CanvasNode,
  type CanvasReferenceResolution,
} from '../../src/Contracts/canvas-graph.ts'
import type { CanvasLinkPlan } from '../../src/Contracts/wire.generated.ts'
import {
  CanvasController,
  type CanvasControllerOptions,
  type CanvasGraphTransport,
  type CanvasIdentity,
} from '../../src/Web/src/authoring/canvasController.ts'

const uuid = (n: number) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`
const header = (overrides: Partial<CanvasGraphHeader> = {}): CanvasGraphHeader => ({
  id: uuid(1),
  revision: 1n,
  title: 'Test Canvas',
  viewport: defaultCanvasViewport,
  deleted: false,
  nodeCount: 0,
  edgeCount: 0,
  touchedAt: 1_700_000_000_000,
  ...overrides,
})
const noteNode = (n: number, text = `Note ${n}`, x = 1000, y = 2000): CanvasNode => ({
  id: uuid(n),
  kind: 'plain-text-note',
  geometry: { x, y, width: 17000, height: 10000 },
  text,
})
const articleRef = (n: number, articleId: number, pinnedRevision: bigint | null = null): CanvasNode => ({
  id: uuid(n),
  kind: 'article-reference',
  geometry: { x: 1000, y: 2000, width: 17000, height: 10000 },
  articleId,
  pinnedRevision,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function identity(name = 'alice', overrides: Partial<CanvasIdentity> = {}): CanvasIdentity {
  return {
    name,
    generation: 1n,
    canAuthor: true,
    expiresAt: 10_000,
    siteSessionId: 'a'.repeat(64),
    credentialEpoch: 1,
    ...overrides,
  }
}

function canvasContext(documentId: string, identityEpoch = 1, session = identity()) {
  return { documentId, identity: session, identityEpoch, ready: true }
}

function graphPage(header: CanvasGraphHeader, rows: Partial<Omit<CanvasGraphPage, 'header'>> = {}): CanvasGraphPage {
  return { header, nextOffset: null, nodes: [], edges: [], ...rows }
}

function applyViewport(header: CanvasGraphHeader, cmd: CanvasGraphCommand): CanvasGraphHeader {
  return { ...header, revision: cmd.expectedRevision + 1n, viewport: cmd.viewport ?? header.viewport }
}

function createHarness(
  overrides: Partial<CanvasGraphTransport> = {},
  options: {
    now?: () => number
    openEditor?: (articleId: number, token: string) => Promise<boolean>
  } = {},
) {
  let idSeq = 100
  let invalidated = 0
  const openedDocuments: string[] = []
  let listNavigations = 0
  const offeredHandoffs: Array<{ token: string; articleId: number; revision: bigint; sourceOffset: number | null; epoch: number }> = []
  const cancelledHandoffs: string[] = []

  const transport: CanvasGraphTransport = {
    list: async () => [],
    page: async (id) => graphPage(header({ id })),
    history: async (_id, expectedRevision) => ({ revision: expectedRevision, undoRevision: null, redoRevision: null }),
    write: async command => header({
      id: command.id,
      revision: command.expectedRevision + 1n,
      title: command.title || 'Test Canvas',
      viewport: command.viewport ?? defaultCanvasViewport,
      deleted: command.action === 'delete',
    }),
    resolveReference: async (id, nodeId, revision) => ({
      canvasId: id,
      nodeId,
      canvasRevision: revision,
      state: 'resolved',
      articleId: 10,
      articleRevision: 2n,
      pinned: false,
      title: 'Target article',
      excerpt: 'Excerpt',
      sourceOffset: 12,
    }),
    readDraft: async id => ({ id, revision: 2n, body: 'Host body' }),
    readPublicArticle: async id => ({ id, revision: 5n }),
    previewLink: async input => ({
      planId: uuid(900),
      canvasRevision: input.canvasRevision,
      hostArticleId: 10,
      targetArticleId: 20,
      hostRevision: input.hostRevision,
      targetRevision: input.targetRevision,
      sourceOffset: input.sourceOffset,
      insertedMarkdown: '\n\n[Target](/article/20)',
      expiresAtUnixSeconds: 9999999999n,
    }),
    confirmLink: async plan => ({
      planId: plan.planId,
      articleId: plan.hostArticleId,
      articleRevision: plan.hostRevision + 1n,
      canvasRevision: plan.canvasRevision + 1n,
    }),
    ...overrides,
  }

  const controllerOptions: CanvasControllerOptions = {
    transport,
    navigation: {
      openDocument: async id => { openedDocuments.push(id) },
      openCanvasList: async () => { listNavigations++ },
      openEditor: options.openEditor ?? (async () => true),
    },
    handoff: {
      offer: (target, epoch) => {
        const token = uuid(++idSeq)
        offeredHandoffs.push({ token, ...target, epoch })
        return token
      },
      cancel: token => { cancelledHandoffs.push(token) },
    },
    onInvalidateSession: () => { invalidated++ },
    nativeMarkdownAvailable: true,
    now: options.now ?? (() => 1000),
    newId: () => uuid(++idSeq),
  }

  const controller = new CanvasController(controllerOptions)
  return {
    controller,
    openedDocuments,
    get listNavigations() { return listNavigations },
    get invalidated() { return invalidated },
    offeredHandoffs,
    cancelledHandoffs,
  }
}

test('initial hydration uses preloaded documents once and boundary page fetches remaining edges', async () => {
  let listCalls = 0
  const pageOffsets: number[] = []
  const n1 = noteNode(10)
  const n2 = noteNode(11)
  const e1: CanvasGraphEdge = {
    id: uuid(12),
    kind: 'visual-only',
    sourceNodeId: n1.id,
    targetNodeId: n2.id,
    order: 0,
    label: 'Edge 1',
  }
  const docHeader = header({ id: uuid(1), revision: 4n, nodeCount: 2, edgeCount: 1 })
  const { controller } = createHarness({
    list: async () => {
      listCalls++
      return [header({ id: uuid(2), title: 'From API' })]
    },
    page: async (_id, pos) => {
      const offset = pos.offset ?? 0
      pageOffsets.push(offset)
      if (offset === 0) {
        return graphPage(docHeader, { nextOffset: 2, nodes: [n1, n2] })
      }
      return graphPage(docHeader, { edges: [e1] })
    },
  })

  const preloaded = [header({ id: uuid(1), title: 'Preloaded' })]
  controller.syncContext({ ...canvasContext(''), initialDocuments: preloaded })
  assert.equal(listCalls, 0)
  assert.deepEqual(controller.state.documents, preloaded)

  controller.syncContext({ ...canvasContext(uuid(1)), initialDocuments: preloaded })
  await flushMicrotasks()
  assert.deepEqual(pageOffsets, [0, 2])
  assert.equal(controller.state.nodes.length, 2)
  assert.equal(controller.state.edges.length, 1)
  assert.equal(controller.state.offset, null)

  controller.syncContext({ ...canvasContext(''), initialDocuments: preloaded })
  await flushMicrotasks()
  assert.equal(listCalls, 1)
  assert.equal(controller.state.documents[0]?.title, 'From API')
})

test('loadAll tracks progress, rejects mismatched counts, and resets completeGraph on failure', async () => {
  const n1 = noteNode(10)
  const n2 = noteNode(11)
  const n3 = noteNode(12)
  const docHeader = header({ id: uuid(1), revision: 2n, nodeCount: 3, edgeCount: 0 })
  let mismatch = false
  const { controller } = createHarness({
    page: async (_id, pos) => {
      const offset = pos.offset ?? 0
      if (offset === 0) return graphPage(docHeader, { nextOffset: 1, nodes: [n1] })
      if (offset === 1) return graphPage(docHeader, { nextOffset: 2, nodes: [n2] })
      return graphPage(docHeader, { nodes: mismatch ? [] : [n3] })
    },
  })

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()
  assert.equal(controller.state.nodes.length, 1)
  assert.equal(controller.state.offset, 1)

  mismatch = true
  await controller.loadAll()
  assert.equal(controller.state.completeGraph, false)
  assert.equal(controller.state.error?.kind, 'key')
  if (controller.state.error?.kind === 'key') {
    assert.equal(controller.state.error.key, 'author.canvas.could_not_load_all_canvas_records_try_again')
  }

  mismatch = false
  await controller.loadAll()
  assert.equal(controller.state.completeGraph, true)
  assert.equal(controller.state.nodes.length, 3)
  assert.equal(controller.state.offset, null)
  assert.equal(controller.state.bulkProgress, 3)
})

test('viewport transforms, optimistic node moves, and showNode focus requests keep exact semantics', async () => {
  const n1 = noteNode(10, 'Node 1', 1000, 2000)
  const n2 = noteNode(11, 'Node 2', 8000, 9000)
  let pageReads = 0
  const commands: CanvasGraphCommand[] = []
  let currentHeader = header({ id: uuid(1), revision: 2n, nodeCount: 2, edgeCount: 0 })

  const { controller } = createHarness({
    page: async () => {
      pageReads++
      return graphPage(currentHeader, { nodes: [n1, n2] })
    },
    write: async cmd => {
      commands.push(cmd)
      currentHeader = applyViewport(currentHeader, cmd)
      return currentHeader
    },
  })

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()
  assert.equal(pageReads, 1)

  // No-op viewport save sends no network request.
  assert.equal(controller.saveViewport(defaultCanvasViewport), undefined)
  assert.equal(commands.length, 0)

  // Zoom clamps to [100, 4000] and sends viewport-only edit.
  await controller.zoom(5000)
  assert.equal(commands.at(-1)?.viewport?.zoom, 4000)
  assert.equal(commands.at(-1)?.changes.length, 0)
  assert.equal(controller.state.document?.revision, 3n)
  assert.equal(pageReads, 1)

  // Enable completeGraph via loadAll / offset=null? Here offset is already null, test optimistic upsert when completeGraph is true.
  // Load a paged graph first so loadAll sets completeGraph = true, then move one node without refetching pages.
  let pagedReads = 0
  const pagedHeader = header({ id: uuid(2), revision: 1n, nodeCount: 2, edgeCount: 0 })
  let currentPagedHeader = pagedHeader
  const h2 = createHarness({
    page: async (_id, pos) => {
      pagedReads++
      const offset = pos.offset ?? 0
      return offset === 0
        ? graphPage(currentPagedHeader, { nextOffset: 1, nodes: [n1] })
        : graphPage(currentPagedHeader, { nodes: [n2] })
    },
    write: async cmd => {
      currentPagedHeader = applyViewport(currentPagedHeader, cmd)
      return currentPagedHeader
    },
  })
  h2.controller.syncContext(canvasContext(uuid(2)))
  await flushMicrotasks()
  await h2.controller.loadAll()
  assert.equal(pagedReads, 2)
  assert.equal(h2.controller.state.completeGraph, true)

  await h2.controller.moveNode(n1.id, { ...n1.geometry, x: 1800 })
  assert.equal(pagedReads, 2, 'Optimistic single-node upsert must not refetch pages')
  assert.equal(h2.controller.state.nodes[0]?.geometry.x, 1800)
  assert.equal(h2.controller.state.document?.revision, 2n)

  // showNode updates viewport and requests board focus; repeating at same viewport still triggers focus request!
  h2.controller.chooseNode(n2.id)
  h2.controller.setView('outline')
  await h2.controller.showNode()
  assert.equal(h2.controller.state.view, 'canvas')
  assert.deepEqual(h2.controller.state.document?.viewport, { x: 4500, y: 5500, zoom: 1000 })
  assert.equal(h2.controller.state.focusBoardNode, n2.id)
  h2.controller.clearFocusRequest()
  assert.equal(h2.controller.state.focusBoardNode, '')

  await h2.controller.showNode()
  assert.equal(h2.controller.state.focusBoardNode, n2.id)
  h2.controller.setView('outline')
  assert.equal(h2.controller.state.focusBoardNode, '')
})

test('uncertain save preserves exact retry commandId and payload while 409 marks stale and clears retry', async () => {
  const sent: CanvasGraphCommand[] = []
  let mode: 'fail-network' | 'ok' | 'conflict' = 'fail-network'
  const currentHeader = header({ id: uuid(1), revision: 2n, nodeCount: 1, edgeCount: 0 })
  const n1 = noteNode(10)

  const { controller } = createHarness({
    page: async () => graphPage(currentHeader, { nodes: [n1] }),
    write: async cmd => {
      sent.push(cmd)
      if (mode === 'fail-network') throw new Error('socket reset')
      if (mode === 'conflict') throw new ApiError('Conflict', 409)
      return { ...currentHeader, revision: cmd.expectedRevision + 1n, title: cmd.title || currentHeader.title }
    },
  })

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()

  controller.openTitleForm()
  controller.updateForm({ title: 'Updated title' })
  await controller.saveTitle()
  assert.equal(sent.length, 1)
  assert.ok(controller.state.retry)
  assert.equal(controller.state.form, 'title')
  assert.equal(controller.state.disabled, true)
  assert.equal(controller.state.shouldProtectUnload, true)
  assert.equal(controller.state.canNavigate, false)

  // Unrelated mutation cannot bypass the pending retry.
  assert.equal(controller.zoom(250), undefined)
  assert.equal(sent.length, 1)

  mode = 'ok'
  assert.equal(await controller.retryLastCommand(), true)
  assert.equal(sent.length, 2)
  assert.equal(sent[1], sent[0])
  assert.equal(sent[1]?.commandId, sent[0]?.commandId)
  assert.equal(sent[1]?.expectedRevision, 2n)
  assert.equal(controller.state.retry, undefined)
  assert.equal(controller.state.form, undefined)

  mode = 'conflict'
  await controller.zoom(250)
  assert.equal(controller.state.stale, true)
  assert.equal(controller.state.retry, undefined)
  assert.equal(controller.state.disabled, true)
  assert.equal(controller.zoom(250), undefined)
})

test('late responses after reset or revision change never overwrite current graph or history state', async () => {
  const firstPage = deferred<CanvasGraphPage>()
  const secondPage = deferred<CanvasGraphPage>()
  const oldHistory = deferred<CanvasGraphHistory>()
  const newHistory = deferred<CanvasGraphHistory>()
  let pageCall = 0
  let historyCall = 0
  const doc1Rev1 = header({ id: uuid(1), revision: 1n, title: 'Doc 1 Rev 1' })
  const doc1Rev2 = header({ id: uuid(1), revision: 2n, title: 'Doc 1 Rev 2' })
  const doc2Rev5 = header({ id: uuid(2), revision: 5n, title: 'Doc 2 Rev 5' })

  const { controller } = createHarness({
    page: async id => {
      pageCall++
      if (id === uuid(1)) return firstPage.promise
      return secondPage.promise
    },
    history: async (_id, rev) => {
      historyCall++
      return rev === 1n ? oldHistory.promise : newHistory.promise
    },
    write: async () => doc1Rev2,
  })

  controller.syncContext(canvasContext(uuid(1)))
  assert.equal(pageCall, 1)

  // Navigate to doc 2 before doc 1 resolves.
  controller.syncContext(canvasContext(uuid(2)))
  assert.equal(pageCall, 2)

  // Late response from doc 1 must be ignored completely.
  firstPage.resolve(graphPage(doc1Rev1, { nodes: [noteNode(10, 'Stale')] }))
  await flushMicrotasks()
  assert.equal(controller.state.document, undefined)
  assert.equal(controller.state.nodes.length, 0)

  secondPage.resolve(graphPage(doc2Rev5, { nodes: [noteNode(20, 'Fresh')] }))
  await flushMicrotasks()
  assert.equal(controller.state.document?.id, uuid(2))
  assert.equal(controller.state.nodes[0]?.id, uuid(20))

  // Test late history response across revision advance on doc 1.
  const h2 = createHarness({
    page: async (_id, pos) => graphPage(pos.revision === 2n ? doc1Rev2 : doc1Rev1),
    history: async (_id, rev) => {
      return rev === 1n ? oldHistory.promise : newHistory.promise
    },
    write: async () => doc1Rev2,
  })
  h2.controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()
  await h2.controller.zoom(250)
  newHistory.resolve({ revision: 2n, undoRevision: 1n, redoRevision: null })
  await flushMicrotasks()
  assert.equal(h2.controller.state.history?.revision, 2n)

  // Late rev 1 history arrives after rev 2 history already loaded.
  oldHistory.resolve({ revision: 1n, undoRevision: null, redoRevision: null })
  await flushMicrotasks()
  assert.equal(h2.controller.state.history?.revision, 2n)
  assert.equal(h2.controller.state.history?.undoRevision, 1n)
  assert.equal(historyCall, 1)
})

test('account switch, sign-out, expiry, and 401 abort active work and block submitting old context', async () => {
  let currentTime = 1000
  const pendingWrite = deferred<CanvasGraphHeader>()
  const signals: AbortSignal[] = []
  const writes: CanvasGraphCommand[] = []
  const docA = header({ id: uuid(1), revision: 3n, title: 'Alice Canvas' })

  const { controller, invalidated } = createHarness(
    {
      page: async () => graphPage(docA, { nodes: [noteNode(10, 'Secret A')] }),
      write: async (cmd, signal) => {
        signals.push(signal)
        writes.push(cmd)
        if (writes.length === 1) throw new Error('network down')
        return pendingWrite.promise
      },
    },
    { now: () => currentTime },
  )

  const alice = identity('alice', { expiresAt: 5000 })
  const bob = identity('bob', { generation: 2n, expiresAt: 9000, siteSessionId: 'b'.repeat(64), credentialEpoch: 2 })

  controller.syncContext(canvasContext(uuid(1), 1, alice))
  await flushMicrotasks()
  assert.equal(controller.state.nodes.length, 1)

  // Fail a write so Alice has a pending retry command, then capture it.
  await controller.zoom(250)
  const aliceRetry = controller.state.retry!
  assert.ok(aliceRetry)

  // Switch from Alice -> Bob -> Alice before anything resolves; old retry must be retired and rejected!
  controller.syncContext(canvasContext(uuid(1), 2, bob))
  assert.equal(controller.state.retry, undefined)
  assert.equal(await controller.send(aliceRetry), false)

  controller.syncContext(canvasContext(uuid(1), 3, alice))
  await flushMicrotasks()
  assert.equal(await controller.send(aliceRetry), false)
  assert.equal(writes.length, 1)

  // Silent expiry extension for the same identity keeps local edits intact.
  controller.openTitleForm()
  controller.updateForm({ title: 'Unsaved Alice rename' })
  controller.syncContext(canvasContext(uuid(1), 3, identity('alice', { expiresAt: 8000 })))
  assert.equal(controller.state.form, 'title')
  assert.equal(controller.state.title, 'Unsaved Alice rename')

  // Start write, then switch to Bob mid-flight: signal aborts and late resolution does not overwrite Bob.
  const inFlight = controller.saveTitle()
  await Promise.resolve()
  const activeSignal = signals.at(-1)
  assert.equal(activeSignal?.aborted, false)
  controller.syncContext(canvasContext(uuid(1), 4, bob))
  assert.equal(activeSignal?.aborted, true)
  pendingWrite.resolve({ ...docA, revision: 4n, title: 'Unsaved Alice rename' })
  assert.equal(await inFlight, false)
  await flushMicrotasks()
  assert.equal(controller.state.document?.title, 'Alice Canvas')

  // Observed clock expiry is sticky even if clock regresses!
  currentTime = 9000
  assert.equal(controller.isAuthorized(), false)
  assert.equal(controller.zoom(250), undefined)
  assert.equal(writes.length, 2)
  currentTime = 1000
  controller.syncContext(canvasContext(uuid(1), 4, bob))
  assert.equal(controller.isAuthorized(), false)
  assert.equal(controller.zoom(250), undefined)
  assert.equal(writes.length, 2)

  // 401 from transport invalidates session cleanly.
  const h401 = createHarness({
    page: async () => { throw new ApiError('Unauthorized', 401) },
  })
  h401.controller.syncContext(canvasContext(uuid(1), 1, alice))
  await flushMicrotasks()
  assert.equal(h401.invalidated, 1)
  assert.equal(h401.controller.state.authorized, false)
  assert.equal(h401.controller.state.document, undefined)
  assert.equal(invalidated, 0)
})

test('undo and redo travel commands check history revision, update graph, and recover from history load errors', async () => {
  let revision = 2n
  let historyBroken = false
  const actions: string[] = []
  const nodeRev1 = noteNode(10, 'Note', 1000, 2000)
  const nodeRev2 = noteNode(10, 'Note', 1800, 2000)

  const { controller } = createHarness({
    page: async (_id, pos) => {
      const rev = pos.revision ?? revision
      return graphPage(header({ id: uuid(1), revision: rev, nodeCount: 1, edgeCount: 0 }), {
        nodes: [rev === 2n ? nodeRev2 : nodeRev1],
      })
    },
    history: async (_id, expectedRevision) => {
      if (historyBroken) throw new Error('history temporarily unavailable')
      if (expectedRevision === 2n) return { revision: 2n, undoRevision: 1n, redoRevision: null }
      if (expectedRevision === 3n) return { revision: 3n, undoRevision: 1n, redoRevision: 2n }
      return { revision: expectedRevision, undoRevision: 2n, redoRevision: null }
    },
    write: async cmd => {
      actions.push(cmd.action)
      revision = cmd.expectedRevision + 1n
      return header({ id: uuid(1), revision, nodeCount: 1, edgeCount: 0 })
    },
  })

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()
  assert.deepEqual(controller.state.historyActionAvailable, { undo: true, redo: false })

  // Opening a form disables undo/redo shortcuts.
  controller.openTitleForm()
  assert.deepEqual(controller.state.historyActionAvailable, { undo: false, redo: false })
  assert.equal(await controller.travel('undo'), false)
  controller.closeForm()

  assert.equal(await controller.travel('undo'), true)
  assert.deepEqual(actions, ['undo'])
  assert.equal(controller.state.document?.revision, 3n)
  assert.equal(controller.state.nodes[0]?.geometry.x, 1000)
  assert.deepEqual(controller.state.historyActionAvailable, { undo: true, redo: true })
  assert.equal(controller.state.message?.kind, 'key')

  historyBroken = true
  assert.equal(await controller.travel('redo'), true)
  assert.equal(controller.state.historyFailure, true)
  assert.deepEqual(controller.state.historyActionAvailable, { undo: false, redo: false })

  historyBroken = false
  await controller.loadHistory()
  assert.equal(controller.state.historyFailure, false)
  assert.equal(controller.state.history?.revision, 4n)
})

test('reference resolution clears on viewport or selection changes and verifies live preflight before editor handoff', async () => {
  const refA = articleRef(10, 41)
  const refB = articleRef(11, 42, 7n)
  let currentHeader = header({ id: uuid(1), revision: 1n, nodeCount: 2, edgeCount: 0 })
  let preflightResult: CanvasReferenceResolution = {
    canvasId: uuid(1),
    nodeId: refA.id,
    canvasRevision: 1n,
    state: 'resolved',
    articleId: 41,
    articleRevision: 9n,
    pinned: false,
    title: 'Article 41',
    excerpt: 'Line',
    sourceOffset: 25,
  }
  let openShouldSucceed = true
  const { controller, offeredHandoffs, cancelledHandoffs } = createHarness(
    {
      page: async () => graphPage(currentHeader, { nodes: [refA, refB] }),
      write: async cmd => {
        currentHeader = applyViewport(currentHeader, cmd)
        return currentHeader
      },
      resolveReference: async (_id, nodeId, revision, _signal, session) => {
        if (session) return preflightResult
        return {
          canvasId: uuid(1),
          nodeId,
          canvasRevision: revision,
          state: 'resolved',
          articleId: nodeId === refA.id ? 41 : 42,
          articleRevision: nodeId === refA.id ? 9n : 7n,
          pinned: nodeId === refB.id,
          title: 'Article',
          excerpt: 'Line',
          sourceOffset: 25,
        }
      },
    },
    { openEditor: async () => openShouldSucceed },
  )

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()

  controller.chooseNode(refA.id)
  await controller.resolveReference()
  assert.equal(controller.state.reference?.state, 'resolved')
  assert.equal(controller.state.canOpenReference, true)

  // Viewport zoom advances revision and synchronously clears reference preview.
  await controller.zoom(250)
  assert.equal(controller.state.reference, undefined)

  preflightResult = { ...preflightResult, canvasRevision: 2n }
  await controller.resolveReference()
  assert.equal(controller.state.reference?.state, 'resolved')

  // If editor navigation fails/aborts, handoff token is cancelled and notice is shown.
  openShouldSucceed = false
  assert.equal(await controller.openReference(), false)
  assert.equal(offeredHandoffs.length, 1)
  assert.deepEqual(cancelledHandoffs, [offeredHandoffs[0]!.token])
  assert.equal(controller.state.referenceOpenNotice?.kind, 'key')

  // If live preflight detects moved sourceOffset, refuse opening without creating a handoff token.
  preflightResult = { ...preflightResult, sourceOffset: 99 }
  assert.equal(await controller.openReference(), false)
  assert.equal(offeredHandoffs.length, 1)

  // Switching view to outline clears reference preview.
  controller.setView('outline')
  assert.equal(controller.state.reference, undefined)
})

test('article link preview preserves visual-only choice, unconfirmed retry plan, and 409 clearing', async () => {
  const n1 = articleRef(10, 1)
  const n2 = articleRef(11, 2)
  const visualEdge: CanvasGraphEdge = {
    id: uuid(12),
    kind: 'visual-only',
    sourceNodeId: n1.id,
    targetNodeId: n2.id,
    order: 0,
    label: 'Visual',
  }
  const visualFlags: boolean[] = []
  const confirmedPlans: CanvasLinkPlan[] = []
  let confirmMode: 'uncertain' | 'conflict' | 'ok' = 'uncertain'

  const { controller } = createHarness({
    page: async () => graphPage(header({ id: uuid(1), revision: 1n, nodeCount: 2, edgeCount: 1 }), {
      nodes: [n1, n2], edges: [visualEdge],
    }),
    previewLink: async (input, _host, _target, _signal, visualOnly) => {
      visualFlags.push(visualOnly)
      return {
        planId: uuid(500),
        canvasRevision: input.canvasRevision,
        hostArticleId: 1,
        targetArticleId: 2,
        hostRevision: input.hostRevision,
        targetRevision: input.targetRevision,
        sourceOffset: input.sourceOffset,
        insertedMarkdown: '\n\n[Two](/article/2)',
        expiresAtUnixSeconds: 9999999999n,
      }
    },
    confirmLink: async plan => {
      confirmedPlans.push(plan)
      if (confirmMode === 'uncertain') throw new Error('connection dropped')
      if (confirmMode === 'conflict') throw new ApiError('Conflict', 409)
      return { planId: plan.planId, articleId: 1, articleRevision: 3n, canvasRevision: 2n }
    },
  })

  controller.syncContext(canvasContext(uuid(1)))
  await flushMicrotasks()

  controller.chooseEdge(visualEdge.id)
  assert.ok(controller.state.activeLink)
  await controller.prepareLink()
  assert.deepEqual(visualFlags, [true])
  assert.equal(controller.state.plan?.edgeKind, 'visual-only')
  assert.equal(controller.state.canNavigate, false)

  // Uncertain failure sets linkUnconfirmed, retains exact plan, and blocks cancelLink.
  await controller.applyLink()
  assert.equal(controller.state.linkUnconfirmed, true)
  assert.ok(controller.state.plan)
  assert.equal(controller.state.shouldProtectUnload, true)
  controller.cancelLink()
  assert.ok(controller.state.plan)

  // Retrying submits exact same planId and succeeds.
  confirmMode = 'ok'
  await controller.applyLink()
  assert.equal(confirmedPlans.length, 2)
  assert.equal(confirmedPlans[1]?.planId, confirmedPlans[0]?.planId)
  assert.equal(controller.state.plan, undefined)
  assert.equal(controller.state.linkUnconfirmed, false)

  // 409 conflict on confirm clears plan and marks canvas stale.
  await controller.prepareLink()
  confirmMode = 'conflict'
  await controller.applyLink()
  assert.equal(controller.state.plan, undefined)
  assert.equal(controller.state.stale, true)
})
