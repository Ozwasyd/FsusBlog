import { ApiError } from '../../../Contracts/client.ts'
import type {
  CanvasGeometry, CanvasGraphChange, CanvasGraphCommand, CanvasGraphEdge, CanvasGraphHeader,
  CanvasGraphHistory, CanvasGraphPage, CanvasNode, CanvasViewport,
} from '../../../Contracts/canvas-graph.ts'
import {
  canApplyOptimisticNodeUpsert, computeHistoryAvailability, createCanvasCommand, deleteCanvasCommand,
  editCanvasCommand, historyTravelCommand, keyNotice, resolveActiveArticleLink, textNotice,
  validateCanvasCommand, type CanvasActiveLinkPair, type CanvasMessageKey, type CanvasNotice,
} from './canvasCommands.ts'
import { CanvasFormModel, type CanvasFormFields, type CanvasFormState } from './canvasForm.ts'
import { CanvasPreviewController, type CanvasEditorHandoffPort, type CanvasPreviewTransport } from './canvasPreviewController.ts'
import { focusNodeViewport, viewportEquals, zoomCanvasViewport } from './canvasViewport.ts'

export interface CanvasIdentity {
  readonly name: string; readonly generation: bigint; readonly canAuthor: boolean
  readonly expiresAt: number; readonly siteSessionId?: string; readonly credentialEpoch: number
}
export interface CanvasGraphTransport extends CanvasPreviewTransport {
  list(signal: AbortSignal): Promise<CanvasGraphHeader[]>
  page(id: string, position: { revision?: bigint; offset?: number }, signal: AbortSignal): Promise<CanvasGraphPage>
  history(id: string, expectedRevision: bigint, signal: AbortSignal): Promise<CanvasGraphHistory>
  write(command: CanvasGraphCommand, signal: AbortSignal): Promise<CanvasGraphHeader>
}
export interface CanvasNavigationPort {
  openDocument(id: string): Promise<unknown>; openCanvasList(): Promise<unknown>
  openEditor(articleId: number, token: string): Promise<boolean>
}
export interface CanvasControllerOptions {
  transport: CanvasGraphTransport; navigation: CanvasNavigationPort
  handoff: Pick<CanvasEditorHandoffPort, 'offer' | 'cancel'>; onInvalidateSession?: () => void
  nativeMarkdownAvailable?: boolean; now?: () => number; newId?: () => string
}
export interface CanvasContextInput {
  documentId: string; identity: CanvasIdentity | null; identityEpoch?: number
  ready: boolean; initialDocuments?: readonly CanvasGraphHeader[]
}
export type { CanvasFormFields, CanvasFormState } from './canvasForm.ts'

const emptyCanvasDocState = () => ({
  loading: false, working: false, bundlePending: false, stale: false, graphReadFailure: false,
  message: undefined as CanvasNotice | undefined, error: undefined as CanvasNotice | undefined,
  document: undefined as CanvasGraphHeader | undefined, documents: [] as readonly CanvasGraphHeader[],
  nodes: [] as readonly CanvasNode[], byId: new Map<string, CanvasNode>() as ReadonlyMap<string, CanvasNode>,
  edges: [] as readonly CanvasGraphEdge[], offset: null as number | null,
  outlinePage: 0, outlineSearch: '', focusBoardNode: '', loadingAll: false, completeGraph: false, bulkProgress: 0,
  nodeId: '', edgeId: '', retry: undefined as CanvasGraphCommand | undefined,
  history: undefined as CanvasGraphHistory | undefined, historyFailure: false, historyLoading: false,
})
type CanvasDocState = ReturnType<typeof emptyCanvasDocState>

export type CanvasControllerState = Readonly<CanvasFormState & CanvasDocState & ReturnType<CanvasPreviewController['snapshot']> & {
  ready: boolean; authorized: boolean; documentId: string; view: 'canvas' | 'outline'
  selectedNode: CanvasNode | undefined; selectedEdge: CanvasGraphEdge | undefined
  selectedReference: Extract<CanvasNode, { articleId: number }> | undefined
  activeLink: CanvasActiveLinkPair | undefined; historyActionAvailable: { readonly undo: boolean; readonly redo: boolean }
  disabled: boolean; canNavigate: boolean; shouldProtectUnload: boolean
}>

function sameAuthorSession(left: CanvasIdentity | null, right: CanvasIdentity | null): boolean {
  return left === right || (left !== null && right !== null && left.name === right.name &&
    left.generation === right.generation && left.canAuthor === right.canAuthor &&
    left.siteSessionId === right.siteSessionId && left.credentialEpoch === right.credentialEpoch)
}

const isTerminalCanvasStatus = (cause: unknown): cause is ApiError =>
  cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)

export class CanvasController {
  readonly #transport: CanvasGraphTransport
  readonly #navigation: CanvasNavigationPort
  readonly #onInvalidateSession: () => void
  readonly #now: () => number
  readonly #newId: () => string
  readonly #listeners = new Set<() => void>()
  readonly #retiredCommands = new WeakSet<CanvasGraphCommand>()
  readonly #preview: CanvasPreviewController
  readonly #form = new CanvasFormModel()

  #identity: CanvasIdentity | null = null
  #identityEpoch: number | undefined
  #expired = false
  #ready = false
  #documentId = ''
  #usedInitialDocuments = false
  #hasInitializedContext = false

  #scope = new AbortController()
  #contextToken = 0
  #historyRequest: AbortController | undefined
  #disposed = false
  #view: 'canvas' | 'outline' = 'canvas'
  #s: CanvasDocState = emptyCanvasDocState()

  #lastDocument: CanvasGraphHeader | undefined
  #lastSelectedReference: Extract<CanvasNode, { articleId: number }> | undefined
  #lastView: 'canvas' | 'outline' = 'canvas'
  #lastStale = false
  #lastNodeId = ''
  #snapshot: CanvasControllerState

  constructor(options: CanvasControllerOptions) {
    this.#transport = options.transport
    this.#navigation = options.navigation
    this.#onInvalidateSession = options.onInvalidateSession ?? (() => {})
    this.#now = options.now ?? (() => Date.now())
    this.#newId = options.newId ?? (() => crypto.randomUUID())

    this.#preview = new CanvasPreviewController(
      options.transport,
      {
        offer: options.handoff.offer,
        cancel: options.handoff.cancel,
        openEditor: options.navigation.openEditor,
      },
      {
        current: () => ({
          signal: this.#scope.signal,
          document: this.#s.document,
          selectedReference: this.selectedReference,
          selectedEdge: this.selectedEdge,
          activeLink: this.activeLink,
          disabled: this.disabled,
          siteSessionId: this.#identity?.siteSessionId,
          credentialEpoch: this.#identity?.credentialEpoch ?? 0,
          scoped: signal => this.#scoped(signal),
          canNavigate: () => this.canNavigate,
        }),
        clearError: () => { this.#s.error = undefined },
        setMessage: key => { this.#s.message = keyNotice(key) },
        recordError: (cause, signal, fallbackKey, reading) => this.#recordError(cause, signal, fallbackKey, reading),
        invalidateSession: () => this.#invalidateAuthorization(),
        reloadAfterLink: () => this.load(),
        notify: () => this.#notify(),
      },
      options.nativeMarkdownAvailable ?? false,
    )

    this.#snapshot = this.#buildState()
  }

  get state(): CanvasControllerState { return this.#snapshot }
  get contextToken(): number { return this.#contextToken }
  get selectedNode(): CanvasNode | undefined { return this.#s.nodeId ? this.#s.byId.get(this.#s.nodeId) : undefined }
  get selectedEdge(): CanvasGraphEdge | undefined {
    return this.#s.edgeId ? this.#s.edges.find(edge => edge.id === this.#s.edgeId) : undefined
  }
  get selectedReference(): Extract<CanvasNode, { articleId: number }> | undefined {
    const node = this.selectedNode
    return node && 'articleId' in node ? node : undefined
  }
  get activeLink(): CanvasActiveLinkPair | undefined { return resolveActiveArticleLink(this.selectedEdge, this.#s.byId) }

  get disabled(): boolean {
    const s = this.#s
    return s.loading || s.loadingAll || s.working || this.#preview.linkPending ||
      Boolean(this.#preview.plan) || Boolean(s.retry) || s.stale || s.graphReadFailure || s.bundlePending
  }

  get canNavigate(): boolean {
    return !this.#s.working && !this.#s.bundlePending && !this.#preview.linkPending &&
      !this.#form.isOpen && !this.#preview.plan && !this.#s.retry && !this.#preview.linkUnconfirmed
  }

  get shouldProtectUnload(): boolean {
    return this.#s.working || this.#s.bundlePending || Boolean(this.#s.retry) ||
      this.#preview.linkUnconfirmed || this.#preview.linkPending
  }

  isAuthorized(): boolean {
    if (this.#expired || !this.#identity || !this.#identity.canAuthor) return false
    if (this.#identity.expiresAt <= this.#now()) {
      this.#expired = true
      return false
    }
    return true
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  dispose(): void {
    this.#disposed = true
    this.#scope.abort()
    this.#historyRequest?.abort()
    this.#historyRequest = undefined
    this.#preview.clearReference(false)
    this.#listeners.clear()
  }

  syncContext(input: CanvasContextInput): void {
    if (this.#disposed) return
    const nextDocId = input.documentId.toLowerCase()
    const nextReady = input.ready
    const docChanged = nextDocId !== this.#documentId
    const readyChanged = nextReady !== this.#ready
    const epochChanged = input.identityEpoch !== undefined && input.identityEpoch !== this.#identityEpoch
    const sameIdentity = sameAuthorSession(this.#identity, input.identity)
    const identityChanged = epochChanged || !sameIdentity

    let shouldReset = !this.#hasInitializedContext || docChanged || readyChanged || identityChanged
    if (!identityChanged && sameIdentity && input.identity !== null) {
      const previousExpiry = this.#identity?.expiresAt ?? 0
      if (input.identity.expiresAt <= this.#now()) {
        this.#expired = true
        shouldReset = true
      } else if (this.#expired) {
        if (input.identity.expiresAt > previousExpiry) {
          this.#expired = false
          shouldReset = true
        }
      } else {
        this.#identity = input.identity
      }
    } else {
      this.#identity = input.identity
      this.#expired = input.identity !== null && input.identity.expiresAt <= this.#now()
    }

    this.#identityEpoch = input.identityEpoch
    this.#documentId = nextDocId
    this.#ready = nextReady
    this.#hasInitializedContext = true

    if (!this.#usedInitialDocuments && input.initialDocuments && !this.#documentId && this.#ready && this.isAuthorized()) {
      this.#usedInitialDocuments = true
      this.#s.documents = input.initialDocuments
      this.#syncDerived()
      this.#snapshot = this.#buildState()
      for (const listener of this.#listeners) listener()
      return
    }

    if (!shouldReset) {
      if (this.#expired) this.reset()
      else this.#notify()
      return
    }

    this.reset()
    if (this.#ready && this.isAuthorized()) void this.load()
  }

  reset(): void {
    this.#scope.abort()
    this.#scope = new AbortController()
    this.#contextToken++
    this.#retireRetry()
    this.#s = emptyCanvasDocState()
    this.#form.reset(false)
    this.#historyRequest?.abort()
    this.#historyRequest = undefined
    this.#preview.reset()
    this.#form.update({ title: '' })
    this.#lastDocument = undefined
    this.#lastSelectedReference = undefined
    this.#lastView = this.#view
    this.#lastStale = false
    this.#lastNodeId = ''
    this.#notify()
  }

  setSessionVerificationError(): void { this.#s.error = keyNotice('author.write.couldNotVerifyYourSession'); this.#notify() }
  setBundlePending(value: boolean): void { if (this.#s.bundlePending !== value) { this.#s.bundlePending = value; this.#notify() } }
  setView(view: 'canvas' | 'outline'): void { if (this.#view !== view) { this.#view = view; this.#notify() } }
  toggleView(): void { this.setView(this.#view === 'canvas' ? 'outline' : 'canvas') }
  setOutlineSearch(value: string): void { if (this.#s.outlineSearch !== value) { this.#s.outlineSearch = value; this.#s.outlinePage = 0; this.#notify() } }
  previousOutlinePage(): void { if (this.#s.outlinePage > 0) { this.#s.outlinePage--; this.#notify() } }
  nextOutlinePage(): void { this.#s.outlinePage++; this.#notify() }
  clearFocusRequest(): void { if (this.#s.focusBoardNode) { this.#s.focusBoardNode = ''; this.#notify() } }
  chooseNode(id: string): void { this.#s.nodeId = id; this.#s.edgeId = ''; this.#notify() }
  chooseEdge(id: string): void { this.#s.edgeId = id; this.#s.nodeId = ''; this.#notify() }

  async showNode(): Promise<void> {
    const node = this.selectedNode, viewport = this.#s.document?.viewport
    if (!node || !viewport) return
    const signal = this.#scope.signal
    this.#view = 'canvas'
    this.#notify()
    await this.saveViewport(focusNodeViewport(viewport, node))
    if (this.#scoped(signal) && this.selectedNode?.id === node.id && this.#view === 'canvas' && !this.#s.stale) {
      this.#s.focusBoardNode = node.id
      this.#notify()
    }
  }

  updateForm(patch: Partial<CanvasFormFields>): void { this.#form.update(patch); this.#notify() }
  setFrameMembers(shownChoices: readonly CanvasNode[], selectedOptionIds: readonly string[]): void { this.#form.setFrameMembers(shownChoices, selectedOptionIds); this.#notify() }
  openTitleForm(): void { this.#form.openTitle(this.#s.document?.title); this.#notify() }
  openNodeForm(kind: CanvasNode['kind'] = 'plain-text-note', existing = false): void { this.#form.openNode(kind, existing ? this.selectedNode : undefined); this.#notify() }
  openEdgeForm(edge?: CanvasGraphEdge): void { if (edge || this.selectedNode) { this.#form.openEdge(edge); this.#notify() } }
  closeForm(): void { if (this.#form.close(this.#s.working || Boolean(this.#s.retry))) this.#notify() }

  async loadHistory(current = this.#s.document): Promise<void> {
    const signal = this.#scope.signal
    if (!current || !this.#scoped(signal)) return
    this.#historyRequest?.abort()
    const request = new AbortController()
    this.#historyRequest = request
    this.#s.historyLoading = true
    this.#s.history = undefined
    this.#s.historyFailure = false
    this.#notify()

    const isLatest = () =>
      request === this.#historyRequest && !request.signal.aborted && this.#scoped(signal) &&
      this.#s.document?.id === current.id && this.#s.document.revision === current.revision

    try {
      const next = await this.#transport.history(current.id, current.revision, request.signal)
      if (!isLatest()) return
      if (next.revision !== current.revision) throw new Error('Canvas history revision changed')
      this.#s.history = next
      this.#notify()
    } catch (cause) {
      if (!isLatest()) return
      if (isTerminalCanvasStatus(cause)) {
        this.#recordError(cause, signal, 'author.canvas.could_not_load_canvas_history', true)
      } else {
        this.#s.historyFailure = true
        this.#notify()
      }
    } finally {
      if (request === this.#historyRequest && this.#scoped(signal)) {
        this.#s.historyLoading = false
        this.#historyRequest = undefined
        this.#notify()
      }
    }
  }

  async load(more = false, confirmed?: CanvasGraphHeader): Promise<void> {
    const signal = this.#scope.signal
    if (!this.#scoped(signal) || this.#s.loading || (more && this.#s.offset === null)) return
    this.#s.loading = true
    this.#s.error = undefined
    this.#notify()

    try {
      if (!this.#documentId) {
        const value = await this.#transport.list(signal)
        if (this.#scoped(signal)) this.#s.documents = value
      } else {
        const previous = more ? this.#s.document : undefined
        const id = this.#documentId
        const position = confirmed
          ? { revision: confirmed.revision }
          : previous && this.#s.offset !== null
            ? { revision: previous.revision, offset: this.#s.offset }
            : {}
        const page = await this.#transport.page(id, position, signal)
        if (!this.#scoped(signal) || (more && this.#s.document !== previous)) return
        this.#s.document = page.header
        this.#setNodes(more ? [...this.#s.nodes, ...page.nodes] : page.nodes)
        this.#s.edges = more ? [...this.#s.edges, ...page.edges] : page.edges
        this.#s.offset = page.nextOffset
        if (!more) {
          this.#s.outlinePage = 0
          if (page.nextOffset !== null && page.nextOffset === page.header.nodeCount) {
            const edgePage = await this.#transport.page(id, { revision: page.header.revision, offset: page.nextOffset }, signal)
            if (!this.#scoped(signal)) return
            this.#s.edges = edgePage.edges
            this.#s.offset = edgePage.nextOffset
          }
        }
        if (this.#s.offset === null) this.#pruneSelection(this.#s.edges)
      }
      if (this.#scoped(signal)) {
        this.#s.stale = false
        this.#s.graphReadFailure = false
        this.#notify()
        if (!more && this.#s.document) {
          if (confirmed) await this.loadHistory(this.#s.document)
          else void this.loadHistory(this.#s.document)
        }
        if (this.#s.completeGraph && this.#s.offset !== null && !more) await this.loadAll()
      }
    } catch (cause) {
      if (this.#scoped(signal)) this.#s.graphReadFailure = true
      this.#recordError(cause, signal, 'author.canvas.could_not_load_the_canvas', true)
    } finally {
      if (this.#scoped(signal) && this.#s.loading) {
        this.#s.loading = false
        this.#notify()
      }
    }
  }

  async loadAll(): Promise<void> {
    const current = this.#s.document
    const signal = this.#scope.signal
    let next = this.#s.offset
    if (!current || next === null || this.#s.loadingAll || !this.#scoped(signal)) return
    this.#s.loadingAll = true
    this.#s.error = undefined
    this.#s.bulkProgress = this.#s.nodes.length + this.#s.edges.length
    this.#notify()

    const nextNodes = [...this.#s.nodes]
    const nextEdges = [...this.#s.edges]
    try {
      while (next !== null) {
        const page = await this.#transport.page(current.id, { revision: current.revision, offset: next }, signal)
        if (!this.#scoped(signal) || current !== this.#s.document) return
        nextNodes.push(...page.nodes)
        nextEdges.push(...page.edges)
        this.#s.bulkProgress = nextNodes.length + nextEdges.length
        next = page.nextOffset
        this.#notify()
      }
      if (nextNodes.length !== current.nodeCount || nextEdges.length !== current.edgeCount) {
        throw new Error('Canvas pages did not cover the advertised counts')
      }
      if (!this.#scoped(signal) || current !== this.#s.document) return
      this.#setNodes(nextNodes)
      this.#s.edges = nextEdges
      this.#s.offset = null
      this.#s.completeGraph = true
      this.#pruneSelection(nextEdges)
      this.#notify()
    } catch (cause) {
      if (!this.#scoped(signal)) return
      this.#s.completeGraph = false
      if (isTerminalCanvasStatus(cause)) {
        this.#recordError(cause, signal, 'author.canvas.could_not_load_all_canvas_records', true)
      } else {
        this.#s.error = keyNotice('author.canvas.could_not_load_all_canvas_records_try_again')
        this.#notify()
      }
    } finally {
      if (this.#scoped(signal) && this.#s.loadingAll) {
        this.#s.loadingAll = false
        this.#notify()
      }
    }
  }

  async send(command: CanvasGraphCommand): Promise<boolean> {
    const signal = this.#scope.signal
    if (!this.#scoped(signal) || this.#s.working || this.#preview.linkPending || this.#s.stale ||
      (this.#s.retry && this.#s.retry !== command) || this.#retiredCommands.has(command)) {
      return false
    }
    if (command.action === 'create') {
      if (this.#documentId !== '' || this.#s.document !== undefined) return false
    } else if (!this.#s.document || command.id !== this.#s.document.id || command.expectedRevision !== this.#s.document.revision) {
      return false
    }
    if (!validateCanvasCommand(command)) {
      this.#s.error = keyNotice('author.canvas.check_the_canvas_text_reference_and_size_limits')
      this.#notify()
      return false
    }

    this.#s.working = true
    this.#s.message = undefined
    this.#s.error = undefined
    this.#s.retry = command
    this.#notify()

    try {
      const result = await this.#transport.write(command, signal)
      if (!this.#scoped(signal)) return false
      this.#retireRetry()
      this.#s.working = false
      this.#form.clearEditing()
      this.#s.message = keyNotice(command.action === 'undo' ? 'author.canvas.canvas_change_undone'
        : command.action === 'redo' ? 'author.canvas.canvas_change_redone' : 'author.canvas.canvas_saved')

      if (command.action === 'create') { this.#notify(); await this.#navigation.openDocument(result.id) }
      else if (result.deleted) { this.#notify(); await this.#navigation.openCanvasList() }
      else if (command.action === 'undo' || command.action === 'redo') { this.#notify(); await this.load(false, result) }
      else if (command.changes.length === 0) { this.#s.document = result; this.#notify(); void this.loadHistory(result) }
      else {
        const optimisticNode = canApplyOptimisticNodeUpsert(
          this.#s.completeGraph, command, this.#s.byId, result, this.#s.nodes.length, this.#s.edges.length,
        )
        if (optimisticNode) {
          this.#setNodes(this.#s.nodes.map(node => node.id === optimisticNode.id ? optimisticNode : node))
          this.#s.document = result
          this.#notify()
          void this.loadHistory(result)
        } else { this.#notify(); await this.load(false, result) }
      }
      return true
    } catch (cause) {
      if (this.#recordError(cause, signal, 'author.canvas.could_not_confirm_the_change_retry_the_same_request')) {
        this.#retireRetry()
        this.#notify()
      }
      return false
    } finally {
      if (this.#scoped(signal) && this.#s.working) { this.#s.working = false; this.#notify() }
    }
  }

  retryLastCommand(): Promise<boolean> { return this.#s.retry ? this.send(this.#s.retry) : Promise.resolve(false) }
  patch(changes: readonly CanvasGraphChange[] = [], name = '', viewport: CanvasViewport | null = null): Promise<boolean> | undefined {
    return this.#s.document && !this.disabled && this.isAuthorized()
      ? this.send(editCanvasCommand(this.#s.document, this.#newId(), { changes, title: name, viewport })) : undefined
  }
  saveViewport(viewport: CanvasViewport): Promise<boolean> | undefined {
    const saved = this.#s.document?.viewport
    return saved && !viewportEquals(viewport, saved) ? this.patch([], '', viewport) : undefined
  }
  zoom(amount: number): Promise<boolean> | undefined {
    return this.#s.document?.viewport ? this.saveViewport(zoomCanvasViewport(this.#s.document.viewport, amount)) : undefined
  }
  moveNode(id: string, geometry: CanvasGeometry): Promise<boolean> | undefined {
    const node = this.#s.byId.get(id)
    return node ? this.patch([{ kind: 'upsert-node', node: { ...node, geometry } }]) : undefined
  }
  removeNode(id: string): Promise<boolean> | undefined { return this.#s.byId.has(id) ? this.patch([{ kind: 'remove-node', id }]) : undefined }
  removeEdge(id: string): Promise<boolean> | undefined { return this.#s.edges.some(edge => edge.id === id) ? this.patch([{ kind: 'remove-edge', id }]) : undefined }
  saveTitle(): Promise<boolean> | undefined {
    const next = this.#form.title.trim()
    return next && next !== this.#s.document?.title
      ? (this.#s.document ? this.patch([], next) : this.send(createCanvasCommand(next, this.#newId(), this.#newId()))) : undefined
  }
  saveNode(): Promise<boolean> | undefined {
    const canvas = this.#s.document
    if (!canvas) return undefined
    const built = this.#form.buildNode(canvas, this.#newId())
    if (!built.ok) { this.#s.error = keyNotice(built.errorKey); this.#notify(); return undefined }
    return this.patch([{ kind: 'upsert-node', node: built.node }])
  }
  saveEdge(): Promise<boolean> | undefined {
    const built = this.#form.buildEdge({
      selectedNodeId: this.selectedNode?.id, byId: this.#s.byId, edgeCount: this.#s.document?.edgeCount ?? 0, generatedEdgeId: this.#newId(),
    })
    return built ? this.patch([{ kind: 'upsert-edge', edge: built }]) : undefined
  }
  travel(action: 'undo' | 'redo'): Promise<boolean> {
    return this.#s.document && this.#historyAvailability()[action]
      ? this.send(historyTravelCommand(this.#s.document, action, this.#newId())) : Promise.resolve(false)
  }
  deleteDocument(expected = this.#s.document): Promise<boolean> {
    return expected && this.#s.document === expected && !this.disabled
      ? this.send(deleteCanvasCommand(expected, this.#newId())) : Promise.resolve(false)
  }

  resolveReference(): Promise<void> { return this.#preview.resolveReference() }
  openReference(): Promise<boolean> { return this.#preview.openReference() }
  prepareLink(): Promise<void> { return this.#preview.prepareLink() }
  applyLink(): Promise<void> { return this.#preview.applyLink() }
  cancelLink(): void { this.#preview.cancelLink() }

  #retireRetry(): void { if (this.#s.retry) { this.#retiredCommands.add(this.#s.retry); this.#s.retry = undefined } }
  #scoped(signal: AbortSignal): boolean { return !this.#disposed && this.#scope.signal === signal && !signal.aborted && this.isAuthorized() }
  #setNodes(nodes: readonly CanvasNode[]): void { this.#s.nodes = nodes; this.#s.byId = new Map(nodes.map(node => [node.id, node])) }
  #pruneSelection(edges: readonly CanvasGraphEdge[]): void {
    if (this.#s.nodeId && !this.#s.byId.has(this.#s.nodeId)) this.#s.nodeId = ''
    if (this.#s.edgeId && !edges.some(edge => edge.id === this.#s.edgeId)) this.#s.edgeId = ''
  }
  #invalidateAuthorization(): void { this.#identity = null; this.reset(); this.#onInvalidateSession() }

  #recordError(cause: unknown, signal: AbortSignal, fallbackKey: CanvasMessageKey, reading = false): boolean {
    if (!this.#scoped(signal)) return false
    if (!(cause instanceof ApiError)) { this.#s.error = keyNotice(fallbackKey); this.#notify(); return false }
    if (cause.status === 401) { this.#invalidateAuthorization(); return true }
    if (cause.status === 403 || (cause.status === 404 && reading)) {
      this.#setNodes([])
      Object.assign(this.#s, { edges: [], document: undefined, documents: [], history: undefined, historyFailure: false })
      this.#preview.clearLinkOnUnavailable()
      this.#retireRetry()
      this.#preview.clearReference(false)
      this.#s.error = keyNotice('author.canvas.canvas_is_unavailable')
    } else if (cause.status === 409) {
      this.#s.stale = true
      this.#preview.clearReference(false)
      this.#s.error = keyNotice('author.canvas.the_canvas_changed_reload_the_current_revision')
    } else if (cause.status === 400 || cause.status === 404) {
      this.#s.error = textNotice(cause.message)
    } else { this.#s.error = keyNotice(fallbackKey); this.#notify(); return false }
    this.#notify()
    return true
  }

  #historyAvailability() {
    return computeHistoryAvailability({
      disabled: this.disabled,
      hasOpenForm: this.#form.isOpen,
      document: this.#s.document,
      history: this.#s.history,
    })
  }

  #syncDerived(): void {
    const selectedRef = this.selectedReference
    if (this.#view !== this.#lastView || this.#s.nodeId !== this.#lastNodeId) this.#s.focusBoardNode = ''
    if (this.#s.document !== this.#lastDocument || selectedRef !== this.#lastSelectedReference ||
        this.#view !== this.#lastView || this.#s.stale !== this.#lastStale) {
      this.#preview.clearReference(false)
    }
    this.#lastDocument = this.#s.document
    this.#lastSelectedReference = selectedRef
    this.#lastView = this.#view
    this.#lastStale = this.#s.stale
    this.#lastNodeId = this.#s.nodeId
  }

  #notify(): void {
    this.#syncDerived()
    this.#snapshot = this.#buildState()
    if (this.#disposed) return
    for (const listener of this.#listeners) listener()
  }

  #buildState(): CanvasControllerState {
    const selectedNode = this.selectedNode
    const selectedEdge = this.selectedEdge
    const selectedReference = selectedNode && 'articleId' in selectedNode ? selectedNode : undefined
    return Object.freeze({
      ready: this.#ready,
      authorized: this.isAuthorized(),
      documentId: this.#documentId,
      view: this.#view,
      ...this.#s,
      selectedNode,
      selectedEdge,
      selectedReference,
      activeLink: resolveActiveArticleLink(selectedEdge, this.#s.byId),
      ...this.#preview.snapshot(this.#identity?.siteSessionId),
      historyActionAvailable: this.#historyAvailability(),
      ...this.#form.snapshot(),
      disabled: this.disabled,
      canNavigate: this.canNavigate,
      shouldProtectUnload: this.shouldProtectUnload,
    })
  }
}
