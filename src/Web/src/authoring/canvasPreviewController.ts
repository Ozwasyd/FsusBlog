import { ApiError } from '../../../Contracts/client.ts'
import type {
  CanvasGraphEdge,
  CanvasGraphHeader,
  CanvasNode,
  CanvasReferenceResolution,
} from '../../../Contracts/canvas-graph.ts'
import type { CanvasLinkPlan, CanvasPreview } from '../../../Contracts/wire.generated.ts'
import {
  keyNotice,
  type CanvasActiveLinkPair,
  type CanvasMessageKey,
  type CanvasNotice,
} from './canvasCommands.ts'
import type { CanvasEditorTarget } from './canvasEditorHandoff.ts'

export type CanvasLinkPreviewPlan = CanvasLinkPlan & { edgeKind: CanvasGraphEdge['kind'] }

export interface CanvasPreviewTransport {
  resolveReference(
    id: string,
    nodeId: string,
    revision: bigint,
    signal: AbortSignal,
    currentSession?: string,
  ): Promise<CanvasReferenceResolution>
  readDraft(articleId: number, signal: AbortSignal): Promise<{ id: number; revision: bigint; body: string }>
  readPublicArticle(articleId: number, signal: AbortSignal): Promise<{ id: number; revision: bigint }>
  previewLink(
    input: CanvasPreview,
    host: number,
    target: number,
    signal: AbortSignal,
    visualOnly: boolean,
  ): Promise<CanvasLinkPlan>
  confirmLink(plan: CanvasLinkPlan, signal: AbortSignal): Promise<unknown>
}

export interface CanvasEditorHandoffPort {
  offer(target: CanvasEditorTarget, credentialEpoch: number): string
  cancel(token: string): void
  openEditor(articleId: number, token: string): Promise<boolean>
}

export interface CanvasPreviewContext {
  readonly signal: AbortSignal
  readonly document: CanvasGraphHeader | undefined
  readonly selectedReference: Extract<CanvasNode, { articleId: number }> | undefined
  readonly selectedEdge: CanvasGraphEdge | undefined
  readonly activeLink: CanvasActiveLinkPair | undefined
  readonly disabled: boolean
  readonly siteSessionId: string | undefined
  readonly credentialEpoch: number
  scoped(signal: AbortSignal): boolean
  canNavigate(): boolean
}

export interface CanvasPreviewHost {
  current(): CanvasPreviewContext
  clearError(): void
  setMessage(key: CanvasMessageKey): void
  recordError(cause: unknown, signal: AbortSignal, fallbackKey: CanvasMessageKey, reading?: boolean): boolean
  invalidateSession(): void
  reloadAfterLink(): Promise<void>
  notify(): void
}

export class CanvasPreviewController {
  readonly #transport: CanvasPreviewTransport
  readonly #handoff: CanvasEditorHandoffPort
  readonly #host: CanvasPreviewHost
  readonly #nativeMarkdownAvailable: boolean

  #reference: CanvasReferenceResolution | undefined
  #referenceLoading = false
  #referenceError = false
  #referenceOpenNotice: CanvasNotice | undefined
  #referenceRequest: AbortController | undefined

  #plan: CanvasLinkPreviewPlan | undefined
  #linkPending = false
  #linkUnconfirmed = false

  constructor(
    transport: CanvasPreviewTransport,
    handoff: CanvasEditorHandoffPort,
    host: CanvasPreviewHost,
    nativeMarkdownAvailable: boolean,
  ) {
    this.#transport = transport
    this.#handoff = handoff
    this.#host = host
    this.#nativeMarkdownAvailable = nativeMarkdownAvailable
  }

  get reference(): CanvasReferenceResolution | undefined { return this.#reference }
  get referenceLoading(): boolean { return this.#referenceLoading }
  get referenceError(): boolean { return this.#referenceError }
  get referenceOpenNotice(): CanvasNotice | undefined { return this.#referenceOpenNotice }
  get plan(): CanvasLinkPreviewPlan | undefined { return this.#plan }
  get linkPending(): boolean { return this.#linkPending }
  get linkUnconfirmed(): boolean { return this.#linkUnconfirmed }

  canOpenReference(siteSessionId: string | undefined): boolean {
    return this.#reference?.state === 'resolved' &&
      Boolean(siteSessionId) &&
      (this.#reference.sourceOffset === null || this.#nativeMarkdownAvailable)
  }

  clearReference(shouldNotify = true): void {
    const hadState = this.#referenceRequest !== undefined ||
      this.#reference !== undefined ||
      this.#referenceLoading ||
      this.#referenceError ||
      this.#referenceOpenNotice !== undefined
    this.#referenceRequest?.abort()
    this.#referenceRequest = undefined
    this.#reference = undefined
    this.#referenceLoading = false
    this.#referenceError = false
    this.#referenceOpenNotice = undefined
    if (hadState && shouldNotify) this.#host.notify()
  }

  clearLinkOnUnavailable(): void {
    this.#plan = undefined
  }

  reset(): void {
    this.clearReference(false)
    this.#plan = undefined
    this.#linkPending = false
    this.#linkUnconfirmed = false
  }

  #beginReference(ctx: CanvasPreviewContext, current: CanvasPreviewContext['document'], node: CanvasPreviewContext['selectedReference'],
    stillAllowed?: (latest: CanvasPreviewContext) => boolean) {
    const request = new AbortController()
    this.#referenceRequest = request
    this.#referenceLoading = true
    this.#referenceOpenNotice = undefined
    this.#host.notify()
    return { request, isLatest: () => {
      const latest = this.#host.current()
      return ctx.scoped(ctx.signal) && request === this.#referenceRequest && !request.signal.aborted &&
        latest.document === current && latest.selectedReference === node && (!stillAllowed || stillAllowed(latest))
    } }
  }

  #finishReference(request: AbortController) {
    if (this.#referenceRequest !== request) return
    this.#referenceLoading = false
    this.#referenceRequest = undefined
    this.#host.notify()
  }

  async resolveReference(): Promise<void> {
    const ctx = this.#host.current()
    const current = ctx.document
    const node = ctx.selectedReference
    const signal = ctx.signal
    if (!current || !node || ctx.disabled || !ctx.scoped(signal) || this.#referenceLoading) return
    this.clearReference(false)
    const { request, isLatest } = this.#beginReference(ctx, current, node)

    try {
      const result = await this.#transport.resolveReference(current.id, node.id, current.revision, request.signal)
      if (!isLatest()) return
      if (result.canvasId !== current.id || result.nodeId !== node.id || result.canvasRevision !== current.revision ||
        (result.articleId !== null && (result.articleId !== node.articleId ||
          result.pinned !== (node.pinnedRevision !== null) ||
          (node.pinnedRevision !== null && result.articleRevision !== node.pinnedRevision)))) {
        this.#referenceError = true
        this.#host.notify()
        return
      }
      this.#reference = result
      this.#host.notify()
    } catch (cause) {
      if (!isLatest()) return
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        this.#host.recordError(cause, signal, 'author.canvas.could_not_resolve_the_reference', true)
      } else {
        this.#referenceError = true
        this.#host.notify()
      }
    } finally {
      this.#finishReference(request)
    }
  }

  async openReference(): Promise<boolean> {
    const ctx = this.#host.current()
    const canvas = ctx.document
    const node = ctx.selectedReference
    const preview = this.#reference
    const handle = ctx.siteSessionId
    const epoch = ctx.credentialEpoch
    const signal = ctx.signal
    if (!canvas || !node || !this.canOpenReference(handle) || !preview?.articleId || preview.articleRevision === null ||
      !handle || ctx.disabled || this.#referenceLoading || !ctx.scoped(signal) || !ctx.canNavigate()) {
      return false
    }

    const { request, isLatest } = this.#beginReference(ctx, canvas, node, latest => latest.credentialEpoch === epoch && latest.canNavigate())

    let token: string | undefined
    try {
      const result = await this.#transport.resolveReference(canvas.id, node.id, canvas.revision, request.signal, handle)
      if (!isLatest()) return false
      if (result.state !== 'resolved' || result.articleId !== preview.articleId ||
        result.articleRevision !== preview.articleRevision || result.sourceOffset !== preview.sourceOffset || result.pinned !== preview.pinned) {
        this.#referenceOpenNotice = preview.pinned && result.state === 'stale-revision'
          ? keyNotice('author.canvas.the_pinned_revision_cannot_be_opened_as_the_current_draft')
          : keyNotice('author.canvas.could_not_open_this_reference_at_its_resolved_position_resolve_it_again')
        this.#host.notify()
        return false
      }
      token = this.#handoff.offer(
        { articleId: preview.articleId, revision: preview.articleRevision, sourceOffset: result.sourceOffset },
        epoch,
      )
      const navigated = await this.#handoff.openEditor(preview.articleId, token)
      if (!navigated) {
        this.#handoff.cancel(token)
        if (isLatest()) {
          this.#referenceOpenNotice = keyNotice('author.canvas.the_editor_could_not_be_opened_try_again')
          this.#host.notify()
        }
        return false
      }
      return true
    } catch (cause) {
      if (token) this.#handoff.cancel(token)
      if (isLatest()) {
        if (cause instanceof ApiError && cause.status === 401) this.#host.invalidateSession()
        this.#referenceOpenNotice = keyNotice('author.canvas.the_editor_could_not_be_opened_resolve_the_reference_again')
        this.#host.notify()
      }
      return false
    } finally {
      this.#finishReference(request)
    }
  }

  async prepareLink(): Promise<void> {
    const ctx = this.#host.current()
    const pair = ctx.activeLink
    const edge = ctx.selectedEdge
    const canvas = ctx.document
    const signal = ctx.signal
    if (!pair || !edge || !canvas || ctx.disabled) return
    this.#linkPending = true
    this.#host.clearError()
    this.#host.notify()
    try {
      const [hostDraft, targetArticle] = await Promise.all([
        this.#transport.readDraft(pair.from.articleId, signal),
        this.#transport.readPublicArticle(pair.to.articleId, signal),
      ])
      const afterReads = this.#host.current()
      if (!ctx.scoped(signal) || afterReads.document !== canvas || afterReads.selectedEdge !== edge) return
      const preview = await this.#transport.previewLink(
        {
          canvasId: canvas.id,
          edgeId: edge.id,
          canvasRevision: canvas.revision,
          hostRevision: hostDraft.revision,
          targetRevision: targetArticle.revision,
          sourceOffset: hostDraft.body.length,
        },
        hostDraft.id,
        targetArticle.id,
        signal,
        edge.kind === 'visual-only',
      )
      const afterPreview = this.#host.current()
      if (ctx.scoped(signal) && afterPreview.document === canvas && afterPreview.selectedEdge === edge) {
        this.#plan = { ...preview, edgeKind: edge.kind }
        this.#host.notify()
      }
    } catch (cause) {
      this.#host.recordError(cause, signal, 'author.canvas.could_not_prepare_the_article_link')
    } finally {
      if (ctx.scoped(signal)) {
        this.#linkPending = false
        this.#host.notify()
      }
    }
  }

  async applyLink(): Promise<void> {
    const ctx = this.#host.current()
    const preview = this.#plan
    const signal = ctx.signal
    if (!preview || !ctx.scoped(signal) || this.#linkPending) return
    this.#linkPending = true
    this.#host.clearError()
    this.#host.notify()
    try {
      await this.#transport.confirmLink(preview, signal)
      if (!ctx.scoped(signal)) return
      this.#plan = undefined
      this.#linkUnconfirmed = false
      this.#host.setMessage('author.canvas.link_added_to_a_new_article_draft')
      this.#host.notify()
      await this.#host.reloadAfterLink()
    } catch (cause) {
      const rejected = this.#host.recordError(
        cause,
        signal,
        'author.canvas.the_outcome_is_uncertain_retry_the_same_link_confirmation',
      )
      if (ctx.scoped(signal)) {
        if (rejected) this.#plan = undefined
        this.#linkUnconfirmed = !rejected
        this.#host.notify()
      }
    } finally {
      if (ctx.scoped(signal)) {
        this.#linkPending = false
        this.#host.notify()
      }
    }
  }

  cancelLink(): void {
    if (!this.#linkPending && !this.#linkUnconfirmed && this.#plan !== undefined) {
      this.#plan = undefined
      this.#host.notify()
    }
  }
}
