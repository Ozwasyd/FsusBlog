import { ApiError } from '../../../Contracts/client.ts'
import type {
  CanvasGeometry,
  CanvasGraphChange,
  CanvasGraphCommand,
  CanvasGraphEdge,
  CanvasGraphHeader,
  CanvasGraphHistory,
  CanvasGraphPage,
  CanvasNode,
  CanvasReferenceResolution,
  CanvasViewport,
} from '../../../Contracts/canvas-graph.ts'
import {
  canApplyOptimisticNodeUpsert,
  computeHistoryAvailability,
  createCanvasCommand,
  deleteCanvasCommand,
  editCanvasCommand,
  historyTravelCommand,
  keyNotice,
  resolveActiveArticleLink,
  textNotice,
  validateCanvasCommand,
  type CanvasActiveLinkPair,
  type CanvasMessageKey,
  type CanvasNotice,
} from './canvasCommands.ts'
import {
  CanvasFormModel,
  type CanvasFormFields,
  type CanvasFormState,
} from './canvasForm.ts'
import {
  CanvasPreviewController,
  type CanvasEditorHandoffPort,
  type CanvasLinkPreviewPlan,
  type CanvasPreviewTransport,
} from './canvasPreviewController.ts'
import { focusNodeViewport, viewportEquals, zoomCanvasViewport } from './canvasViewport.ts'

export interface CanvasIdentity {
  readonly name: string
  readonly generation: bigint
  readonly canAuthor: boolean
  readonly expiresAt: number
  readonly siteSessionId?: string
  readonly credentialEpoch: number
}

export interface CanvasGraphTransport extends CanvasPreviewTransport {
  list(signal: AbortSignal): Promise<CanvasGraphHeader[]>
  page(id: string, position: { revision?: bigint; offset?: number }, signal: AbortSignal): Promise<CanvasGraphPage>
  history(id: string, expectedRevision: bigint, signal: AbortSignal): Promise<CanvasGraphHistory>
  write(command: CanvasGraphCommand, signal: AbortSignal): Promise<CanvasGraphHeader>
}

export interface CanvasNavigationPort {
  openDocument(id: string): Promise<unknown>
  openCanvasList(): Promise<unknown>
  openEditor(articleId: number, token: string): Promise<boolean>
}

export interface CanvasControllerOptions {
  transport: CanvasGraphTransport
  navigation: CanvasNavigationPort
  handoff: Pick<CanvasEditorHandoffPort, 'offer' | 'cancel'>
  onInvalidateSession?: () => void
  nativeMarkdownAvailable?: boolean
  now?: () => number
  newId?: () => string
}

export interface CanvasContextInput {
  documentId: string
  identity: CanvasIdentity | null
  identityEpoch?: number
  ready: boolean
  initialDocuments?: readonly CanvasGraphHeader[]
}

export type { CanvasFormFields, CanvasFormState } from './canvasForm.ts'

export interface CanvasControllerState extends CanvasFormState {
  readonly ready: boolean
  readonly authorized: boolean
  readonly documentId: string
  readonly loading: boolean
  readonly working: boolean
  readonly bundlePending: boolean
  readonly stale: boolean
  readonly graphReadFailure: boolean
  readonly message: CanvasNotice | undefined
  readonly error: CanvasNotice | undefined
  readonly document: CanvasGraphHeader | undefined
  readonly documents: readonly CanvasGraphHeader[]
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasGraphEdge[]
  readonly byId: ReadonlyMap<string, CanvasNode>
  readonly offset: number | null
  readonly view: 'canvas' | 'outline'
  readonly outlinePage: number
  readonly outlineSearch: string
  readonly focusBoardNode: string
  readonly loadingAll: boolean
  readonly completeGraph: boolean
  readonly bulkProgress: number
  readonly nodeId: string
  readonly edgeId: string
  readonly selectedNode: CanvasNode | undefined
  readonly selectedEdge: CanvasGraphEdge | undefined
  readonly selectedReference: Extract<CanvasNode, { articleId: number }> | undefined
  readonly activeLink: CanvasActiveLinkPair | undefined
  readonly retry: CanvasGraphCommand | undefined
  readonly plan: CanvasLinkPreviewPlan | undefined
  readonly linkPending: boolean
  readonly linkUnconfirmed: boolean
  readonly history: CanvasGraphHistory | undefined
  readonly historyFailure: boolean
  readonly historyLoading: boolean
  readonly historyActionAvailable: { readonly undo: boolean; readonly redo: boolean }
  readonly reference: CanvasReferenceResolution | undefined
  readonly referenceLoading: boolean
  readonly referenceError: boolean
  readonly referenceOpenNotice: CanvasNotice | undefined
  readonly canOpenReference: boolean
  readonly disabled: boolean
  readonly canNavigate: boolean
  readonly shouldProtectUnload: boolean
}

function sameAuthorSession(left: CanvasIdentity | null, right: CanvasIdentity | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.name === right.name &&
    left.generation === right.generation &&
    left.canAuthor === right.canAuthor &&
    left.siteSessionId === right.siteSessionId &&
    left.credentialEpoch === right.credentialEpoch
}

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

  #loading = false
  #working = false
  #bundlePending = false
  #stale = false
  #graphReadFailure = false
  #message: CanvasNotice | undefined
  #error: CanvasNotice | undefined
  #document: CanvasGraphHeader | undefined
  #documents: readonly CanvasGraphHeader[] = []
  #nodes: readonly CanvasNode[] = []
  #byId: ReadonlyMap<string, CanvasNode> = new Map()
  #edges: readonly CanvasGraphEdge[] = []
  #offset: number | null = null
  #view: 'canvas' | 'outline' = 'canvas'
  #outlinePage = 0
  #outlineSearch = ''
  #focusBoardNode = ''
  #loadingAll = false
  #completeGraph = false
  #bulkProgress = 0
  #nodeId = ''
  #edgeId = ''
  #retry: CanvasGraphCommand | undefined
  #history = undefined as CanvasGraphHistory | undefined
  #historyFailure = false
  #historyLoading = false

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
          document: this.#document,
          selectedReference: this.selectedReference,
          selectedEdge: this.selectedEdge,
          activeLink: this.activeLink,
          disabled: this.disabled,
          siteSessionId: this.#identity?.siteSessionId,
          credentialEpoch: this.#identity?.credentialEpoch ?? 0,
          scoped: signal => this.#scoped(signal),
          canNavigate: () => this.canNavigate,
        }),
        clearError: () => { this.#error = undefined },
        setMessage: key => { this.#message = keyNotice(key) },
        recordError: (cause, signal, fallbackKey, reading) => this.#recordError(cause, signal, fallbackKey, reading),
        invalidateSession: () => this.#invalidateAuthorization(),
        reloadAfterLink: () => this.load(),
        notify: () => this.#notify(),
      },
      options.nativeMarkdownAvailable ?? false,
    )

    this.#snapshot = this.#buildState()
  }

  get state(): CanvasControllerState {
    return this.#snapshot
  }

  get contextToken(): number {
    return this.#contextToken
  }

  get selectedNode(): CanvasNode | undefined {
    return this.#nodeId ? this.#byId.get(this.#nodeId) : undefined
  }

  get selectedEdge(): CanvasGraphEdge | undefined {
    return this.#edgeId ? this.#edges.find(edge => edge.id === this.#edgeId) : undefined
  }

  get selectedReference(): Extract<CanvasNode, { articleId: number }> | undefined {
    const node = this.selectedNode
    return node && 'articleId' in node ? node : undefined
  }

  get activeLink(): CanvasActiveLinkPair | undefined {
    return resolveActiveArticleLink(this.selectedEdge, this.#byId)
  }

  get disabled(): boolean {
    return this.#loading ||
      this.#loadingAll ||
      this.#working ||
      this.#preview.linkPending ||
      Boolean(this.#preview.plan) ||
      Boolean(this.#retry) ||
      this.#stale ||
      this.#graphReadFailure ||
      this.#bundlePending
  }

  get canNavigate(): boolean {
    return !this.#working &&
      !this.#bundlePending &&
      !this.#preview.linkPending &&
      !this.#form.isOpen &&
      !this.#preview.plan &&
      !this.#retry &&
      !this.#preview.linkUnconfirmed
  }

  get shouldProtectUnload(): boolean {
    return this.#working ||
      this.#bundlePending ||
      Boolean(this.#retry) ||
      this.#preview.linkUnconfirmed ||
      this.#preview.linkPending
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
      this.#documents = input.initialDocuments
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
    if (this.#ready && this.isAuthorized()) {
      void this.load()
    }
  }

  reset(): void {
    this.#scope.abort()
    this.#scope = new AbortController()
    this.#contextToken++
    this.#document = undefined
    this.#documents = []
    this.#setNodes([])
    this.#edges = []
    this.#nodeId = ''
    this.#edgeId = ''
    this.#offset = null
    this.#outlinePage = 0
    this.#outlineSearch = ''
    this.#focusBoardNode = ''
    this.#loadingAll = false
    this.#completeGraph = false
    this.#bulkProgress = 0
    if (this.#retry) this.#retiredCommands.add(this.#retry)
    this.#retry = undefined
    this.#form.reset(false)
    this.#working = false
    this.#bundlePending = false
    this.#loading = false
    this.#stale = false
    this.#graphReadFailure = false
    this.#history = undefined
    this.#historyFailure = false
    this.#historyLoading = false
    this.#historyRequest?.abort()
    this.#historyRequest = undefined
    this.#preview.reset()
    this.#error = undefined
    this.#message = undefined
    this.#form.update({ title: '' })
    this.#lastDocument = undefined
    this.#lastSelectedReference = undefined
    this.#lastView = this.#view
    this.#lastStale = false
    this.#lastNodeId = ''
    this.#notify()
  }

  setSessionVerificationError(): void {
    this.#error = keyNotice('author.canvas.could_not_verify_your_session')
    this.#notify()
  }

  setBundlePending(value: boolean): void {
    if (this.#bundlePending === value) return
    this.#bundlePending = value
    this.#notify()
  }

  setView(view: 'canvas' | 'outline'): void {
    if (this.#view === view) return
    this.#view = view
    this.#notify()
  }

  toggleView(): void {
    this.setView(this.#view === 'canvas' ? 'outline' : 'canvas')
  }

  setOutlineSearch(value: string): void {
    if (this.#outlineSearch === value) return
    this.#outlineSearch = value
    this.#outlinePage = 0
    this.#notify()
  }

  previousOutlinePage(): void {
    if (this.#outlinePage <= 0) return
    this.#outlinePage--
    this.#notify()
  }

  nextOutlinePage(): void {
    this.#outlinePage++
    this.#notify()
  }

  clearFocusRequest(): void {
    if (!this.#focusBoardNode) return
    this.#focusBoardNode = ''
    this.#notify()
  }

  chooseNode(id: string): void {
    this.#nodeId = id
    this.#edgeId = ''
    this.#notify()
  }

  chooseEdge(id: string): void {
    this.#edgeId = id
    this.#nodeId = ''
    this.#notify()
  }

  async showNode(): Promise<void> {
    const node = this.selectedNode
    const viewport = this.#document?.viewport
    if (!node || !viewport) return
    const signal = this.#scope.signal
    this.#view = 'canvas'
    this.#notify()
    await this.saveViewport(focusNodeViewport(viewport, node))
    if (this.#scoped(signal) && this.selectedNode?.id === node.id && this.#view === 'canvas' && !this.#stale) {
      this.#focusBoardNode = node.id
      this.#notify()
    }
  }

  updateForm(patch: Partial<CanvasFormFields>): void {
    this.#form.update(patch)
    this.#notify()
  }

  setFrameMembers(shownChoices: readonly CanvasNode[], selectedOptionIds: readonly string[]): void {
    this.#form.setFrameMembers(shownChoices, selectedOptionIds)
    this.#notify()
  }

  openTitleForm(): void {
    this.#form.openTitle(this.#document?.title)
    this.#notify()
  }

  openNodeForm(kind: CanvasNode['kind'] = 'plain-text-note', existing = false): void {
    this.#form.openNode(kind, existing ? this.selectedNode : undefined)
    this.#notify()
  }

  openEdgeForm(edge?: CanvasGraphEdge): void {
    if (!edge && !this.selectedNode) return
    this.#form.openEdge(edge)
    this.#notify()
  }

  closeForm(): void {
    if (this.#form.close(this.#working || Boolean(this.#retry))) this.#notify()
  }

  async loadHistory(current = this.#document): Promise<void> {
    const signal = this.#scope.signal
    if (!current || !this.#scoped(signal)) return
    this.#historyRequest?.abort()
    const request = new AbortController()
    this.#historyRequest = request
    this.#historyLoading = true
    this.#history = undefined
    this.#historyFailure = false
    this.#notify()

    const isLatest = () =>
      request === this.#historyRequest &&
      !request.signal.aborted &&
      this.#scoped(signal) &&
      this.#document?.id === current.id &&
      this.#document.revision === current.revision

    try {
      const next = await this.#transport.history(current.id, current.revision, request.signal)
      if (!isLatest()) return
      if (next.revision !== current.revision) throw new Error('Canvas history revision changed')
      this.#history = next
      this.#notify()
    } catch (cause) {
      if (!isLatest()) return
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        this.#recordError(cause, signal, 'author.canvas.could_not_load_canvas_history', true)
      } else {
        this.#historyFailure = true
        this.#notify()
      }
    } finally {
      if (request === this.#historyRequest && this.#scoped(signal)) {
        this.#historyLoading = false
        this.#historyRequest = undefined
        this.#notify()
      }
    }
  }

  async load(more = false, confirmed?: CanvasGraphHeader): Promise<void> {
    const signal = this.#scope.signal
    if (!this.#scoped(signal) || this.#loading || (more && this.#offset === null)) return
    this.#loading = true
    this.#error = undefined
    this.#notify()

    try {
      if (!this.#documentId) {
        const value = await this.#transport.list(signal)
        if (this.#scoped(signal)) this.#documents = value
      } else {
        const previous = more ? this.#document : undefined
        const id = this.#documentId
        const position = confirmed
          ? { revision: confirmed.revision }
          : previous && this.#offset !== null
            ? { revision: previous.revision, offset: this.#offset }
            : {}
        const page = await this.#transport.page(id, position, signal)
        if (!this.#scoped(signal) || (more && this.#document !== previous)) return
        this.#document = page.header
        this.#setNodes(more ? [...this.#nodes, ...page.nodes] : page.nodes)
        this.#edges = more ? [...this.#edges, ...page.edges] : page.edges
        this.#offset = page.nextOffset
        if (!more) {
          this.#outlinePage = 0
          if (page.nextOffset !== null && page.nextOffset === page.header.nodeCount) {
            const edgePage = await this.#transport.page(
              id,
              { revision: page.header.revision, offset: page.nextOffset },
              signal,
            )
            if (!this.#scoped(signal)) return
            this.#edges = edgePage.edges
            this.#offset = edgePage.nextOffset
          }
        }
        if (this.#offset === null) {
          if (this.#nodeId && !this.#byId.has(this.#nodeId)) this.#nodeId = ''
          if (this.#edgeId && !this.#edges.some(edge => edge.id === this.#edgeId)) this.#edgeId = ''
        }
      }
      if (this.#scoped(signal)) {
        this.#stale = false
        this.#graphReadFailure = false
        this.#notify()
        if (!more && this.#document) {
          if (confirmed) await this.loadHistory(this.#document)
          else void this.loadHistory(this.#document)
        }
        if (this.#completeGraph && this.#offset !== null && !more) {
          await this.loadAll()
        }
      }
    } catch (cause) {
      if (this.#scoped(signal)) this.#graphReadFailure = true
      this.#recordError(cause, signal, 'author.canvas.could_not_load_the_canvas', true)
    } finally {
      if (this.#scoped(signal) && this.#loading) {
        this.#loading = false
        this.#notify()
      }
    }
  }

  async loadAll(): Promise<void> {
    const current = this.#document
    const signal = this.#scope.signal
    let next = this.#offset
    if (!current || next === null || this.#loadingAll || !this.#scoped(signal)) return
    this.#loadingAll = true
    this.#error = undefined
    this.#bulkProgress = this.#nodes.length + this.#edges.length
    this.#notify()

    const nextNodes = [...this.#nodes]
    const nextEdges = [...this.#edges]
    try {
      while (next !== null) {
        const page = await this.#transport.page(current.id, { revision: current.revision, offset: next }, signal)
        if (!this.#scoped(signal) || current !== this.#document) return
        nextNodes.push(...page.nodes)
        nextEdges.push(...page.edges)
        this.#bulkProgress = nextNodes.length + nextEdges.length
        next = page.nextOffset
        this.#notify()
      }
      if (nextNodes.length !== current.nodeCount || nextEdges.length !== current.edgeCount) {
        throw new Error('Canvas pages did not cover the advertised counts')
      }
      if (!this.#scoped(signal) || current !== this.#document) return
      this.#setNodes(nextNodes)
      this.#edges = nextEdges
      this.#offset = null
      this.#completeGraph = true
      if (this.#nodeId && !this.#byId.has(this.#nodeId)) this.#nodeId = ''
      if (this.#edgeId && !nextEdges.some(edge => edge.id === this.#edgeId)) this.#edgeId = ''
      this.#notify()
    } catch (cause) {
      if (!this.#scoped(signal)) return
      this.#completeGraph = false
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        this.#recordError(cause, signal, 'author.canvas.could_not_load_all_canvas_records', true)
      } else {
        this.#error = keyNotice('author.canvas.could_not_load_all_canvas_records_try_again')
        this.#notify()
      }
    } finally {
      if (this.#scoped(signal) && this.#loadingAll) {
        this.#loadingAll = false
        this.#notify()
      }
    }
  }

  async send(command: CanvasGraphCommand): Promise<boolean> {
    const signal = this.#scope.signal
    if (!this.#scoped(signal) || this.#working || this.#preview.linkPending || this.#stale ||
      (this.#retry && this.#retry !== command) || this.#retiredCommands.has(command)) {
      return false
    }
    if (command.action === 'create') {
      if (this.#documentId !== '' || this.#document !== undefined) return false
    } else {
      if (!this.#document || command.id !== this.#document.id || command.expectedRevision !== this.#document.revision) {
        return false
      }
    }
    if (!validateCanvasCommand(command)) {
      this.#error = keyNotice('author.canvas.check_the_canvas_text_reference_and_size_limits')
      this.#notify()
      return false
    }

    this.#working = true
    this.#message = undefined
    this.#error = undefined
    this.#retry = command
    this.#notify()

    try {
      const result = await this.#transport.write(command, signal)
      if (!this.#scoped(signal)) return false
      if (this.#retry) this.#retiredCommands.add(this.#retry)
      this.#retry = undefined
      this.#working = false
      this.#form.clearEditing()
      this.#message = keyNotice(
        command.action === 'undo'
          ? 'author.canvas.canvas_change_undone'
          : command.action === 'redo'
            ? 'author.canvas.canvas_change_redone'
            : 'author.canvas.canvas_saved',
      )

      if (command.action === 'create') {
        this.#notify()
        await this.#navigation.openDocument(result.id)
      } else if (result.deleted) {
        this.#notify()
        await this.#navigation.openCanvasList()
      } else if (command.action === 'undo' || command.action === 'redo') {
        this.#notify()
        await this.load(false, result)
      } else if (command.changes.length === 0) {
        this.#document = result
        this.#notify()
        void this.loadHistory(result)
      } else {
        const optimisticNode = canApplyOptimisticNodeUpsert(
          this.#completeGraph,
          command,
          this.#byId,
          result,
          this.#nodes.length,
          this.#edges.length,
        )
        if (optimisticNode) {
          this.#setNodes(this.#nodes.map(node => node.id === optimisticNode.id ? optimisticNode : node))
          this.#document = result
          this.#notify()
          void this.loadHistory(result)
        } else {
          this.#notify()
          await this.load(false, result)
        }
      }
      return true
    } catch (cause) {
      if (this.#recordError(cause, signal, 'author.canvas.could_not_confirm_the_change_retry_the_same_request')) {
        if (this.#retry) this.#retiredCommands.add(this.#retry)
        this.#retry = undefined
        this.#notify()
      }
      return false
    } finally {
      if (this.#scoped(signal) && this.#working) {
        this.#working = false
        this.#notify()
      }
    }
  }

  retryLastCommand(): Promise<boolean> {
    if (!this.#retry) return Promise.resolve(false)
    return this.send(this.#retry)
  }

  patch(
    changes: readonly CanvasGraphChange[] = [],
    name = '',
    viewport: CanvasViewport | null = null,
  ): Promise<boolean> | undefined {
    if (!this.#document || this.disabled || !this.isAuthorized()) return undefined
    return this.send(editCanvasCommand(this.#document, this.#newId(), { changes, title: name, viewport }))
  }

  saveViewport(viewport: CanvasViewport): Promise<boolean> | undefined {
    const saved = this.#document?.viewport
    if (saved && !viewportEquals(viewport, saved)) {
      return this.patch([], '', viewport)
    }
    return undefined
  }

  zoom(amount: number): Promise<boolean> | undefined {
    const viewport = this.#document?.viewport
    if (!viewport) return undefined
    return this.saveViewport(zoomCanvasViewport(viewport, amount))
  }

  moveNode(id: string, geometry: CanvasGeometry): Promise<boolean> | undefined {
    const node = this.#byId.get(id)
    if (!node) return undefined
    return this.patch([{ kind: 'upsert-node', node: { ...node, geometry } }])
  }

  removeNode(id: string): Promise<boolean> | undefined {
    if (!this.#byId.has(id)) return undefined
    return this.patch([{ kind: 'remove-node', id }])
  }

  removeEdge(id: string): Promise<boolean> | undefined {
    if (!this.#edges.some(edge => edge.id === id)) return undefined
    return this.patch([{ kind: 'remove-edge', id }])
  }

  saveTitle(): Promise<boolean> | undefined {
    const next = this.#form.title.trim()
    if (!next || next === this.#document?.title) return undefined
    if (this.#document) return this.patch([], next)
    return this.send(createCanvasCommand(next, this.#newId(), this.#newId()))
  }

  saveNode(): Promise<boolean> | undefined {
    const canvas = this.#document
    if (!canvas) return undefined
    const built = this.#form.buildNode(canvas, this.#newId())
    if (!built.ok) {
      this.#error = keyNotice(built.errorKey)
      this.#notify()
      return undefined
    }
    return this.patch([{ kind: 'upsert-node', node: built.node }])
  }

  saveEdge(): Promise<boolean> | undefined {
    const built = this.#form.buildEdge({
      selectedNodeId: this.selectedNode?.id,
      byId: this.#byId,
      edgeCount: this.#document?.edgeCount ?? 0,
      generatedEdgeId: this.#newId(),
    })
    if (!built) return undefined
    return this.patch([{ kind: 'upsert-edge', edge: built }])
  }

  travel(action: 'undo' | 'redo'): Promise<boolean> {
    const current = this.#document
    if (!current || !this.#historyAvailability()[action]) return Promise.resolve(false)
    return this.send(historyTravelCommand(current, action, this.#newId()))
  }

  deleteDocument(expected = this.#document): Promise<boolean> {
    if (!expected || this.#document !== expected || this.disabled) return Promise.resolve(false)
    return this.send(deleteCanvasCommand(expected, this.#newId()))
  }

  resolveReference(): Promise<void> {
    return this.#preview.resolveReference()
  }

  openReference(): Promise<boolean> {
    return this.#preview.openReference()
  }

  prepareLink(): Promise<void> {
    return this.#preview.prepareLink()
  }

  applyLink(): Promise<void> {
    return this.#preview.applyLink()
  }

  cancelLink(): void {
    this.#preview.cancelLink()
  }

  #scoped(signal: AbortSignal): boolean {
    return !this.#disposed && this.#scope.signal === signal && !signal.aborted && this.isAuthorized()
  }

  #setNodes(nodes: readonly CanvasNode[]): void {
    this.#nodes = nodes
    this.#byId = new Map(nodes.map(node => [node.id, node]))
  }

  #invalidateAuthorization(): void {
    this.#identity = null
    this.reset()
    this.#onInvalidateSession()
  }

  #recordError(cause: unknown, signal: AbortSignal, fallbackKey: CanvasMessageKey, reading = false): boolean {
    if (!this.#scoped(signal)) return false
    if (!(cause instanceof ApiError)) {
      this.#error = keyNotice(fallbackKey)
      this.#notify()
      return false
    }
    if (cause.status === 401) {
      this.#invalidateAuthorization()
      return true
    }
    if (cause.status === 403 || (cause.status === 404 && reading)) {
      this.#setNodes([])
      this.#edges = []
      this.#document = undefined
      this.#documents = []
      this.#history = undefined
      this.#historyFailure = false
      this.#preview.clearLinkOnUnavailable()
      if (this.#retry) this.#retiredCommands.add(this.#retry)
      this.#retry = undefined
      this.#preview.clearReference(false)
      this.#error = keyNotice('author.canvas.canvas_is_unavailable')
    } else if (cause.status === 409) {
      this.#stale = true
      this.#preview.clearReference(false)
      this.#error = keyNotice('author.canvas.the_canvas_changed_reload_the_current_revision')
    } else if (cause.status === 400 || cause.status === 404) {
      this.#error = textNotice(cause.message)
    } else {
      this.#error = keyNotice(fallbackKey)
      this.#notify()
      return false
    }
    this.#notify()
    return true
  }

  #historyAvailability() {
    return computeHistoryAvailability({
      disabled: this.disabled,
      hasOpenForm: this.#form.isOpen,
      document: this.#document,
      history: this.#history,
    })
  }

  #syncDerived(): void {
    const selectedRef = this.selectedReference
    if (this.#view !== this.#lastView || this.#nodeId !== this.#lastNodeId) {
      this.#focusBoardNode = ''
    }
    if (
      this.#document !== this.#lastDocument ||
      selectedRef !== this.#lastSelectedReference ||
      this.#view !== this.#lastView ||
      this.#stale !== this.#lastStale
    ) {
      this.#preview.clearReference(false)
    }
    this.#lastDocument = this.#document
    this.#lastSelectedReference = selectedRef
    this.#lastView = this.#view
    this.#lastStale = this.#stale
    this.#lastNodeId = this.#nodeId
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
    const activeLink = resolveActiveArticleLink(selectedEdge, this.#byId)
    return Object.freeze({
      ready: this.#ready,
      authorized: this.isAuthorized(),
      documentId: this.#documentId,
      loading: this.#loading,
      working: this.#working,
      bundlePending: this.#bundlePending,
      stale: this.#stale,
      graphReadFailure: this.#graphReadFailure,
      message: this.#message,
      error: this.#error,
      document: this.#document,
      documents: this.#documents,
      nodes: this.#nodes,
      edges: this.#edges,
      byId: this.#byId,
      offset: this.#offset,
      view: this.#view,
      outlinePage: this.#outlinePage,
      outlineSearch: this.#outlineSearch,
      focusBoardNode: this.#focusBoardNode,
      loadingAll: this.#loadingAll,
      completeGraph: this.#completeGraph,
      bulkProgress: this.#bulkProgress,
      nodeId: this.#nodeId,
      edgeId: this.#edgeId,
      selectedNode,
      selectedEdge,
      selectedReference,
      activeLink,
      retry: this.#retry,
      plan: this.#preview.plan,
      linkPending: this.#preview.linkPending,
      linkUnconfirmed: this.#preview.linkUnconfirmed,
      history: this.#history,
      historyFailure: this.#historyFailure,
      historyLoading: this.#historyLoading,
      historyActionAvailable: this.#historyAvailability(),
      reference: this.#preview.reference,
      referenceLoading: this.#preview.referenceLoading,
      referenceError: this.#preview.referenceError,
      referenceOpenNotice: this.#preview.referenceOpenNotice,
      canOpenReference: this.#preview.canOpenReference(this.#identity?.siteSessionId),
      ...this.#form.snapshot(),
      disabled: this.disabled,
      canNavigate: this.canNavigate,
      shouldProtectUnload: this.shouldProtectUnload,
    })
  }
}
