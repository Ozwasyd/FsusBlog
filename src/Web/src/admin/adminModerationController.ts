import { ApiError } from '../../../Contracts/aeds.ts'
import { readAdminCommentQueue, type AdminCommentCursor, type AdminCommentQueue } from '../../../Contracts/admin-identity.ts'
import {
  claimComment,
  decideComment,
  releaseCommentClaim,
  renewCommentClaim,
  validModerationReason,
  type AdminModerationClaim,
  type AdminModerationDecision,
} from '../../../Contracts/admin-moderation.ts'
import {
  claimModerationBatch,
  proveAndDecideModerationBatch,
  readModerationBatchConflicts,
  type AdminModerationBatchDecision,
  type AdminModerationBatchReceipt,
} from '../../../Contracts/admin-moderation-batch.ts'
import { proveAdminModerationDecision } from '../../../Contracts/admin-step-up.ts'
import {
  readCommentRevisions,
  readModerationTimeline,
  validModerationCoordinates,
  type CommentRevisionPage,
  type ModerationTimeline,
} from '../../../Contracts/comment-moderation-timeline.ts'
import { WireLimits } from '../../../Contracts/wire.generated.ts'
import type { MessageKey } from '../siteLocale.ts'
import {
  AdminOperationChannel,
  AdminSessionScope,
  MAX_TIMEOUT_MS,
  systemAdminClock,
  type AdminClock,
  type AdminOperationContext,
  type TimerHandle,
} from './adminOperationCoordinator.ts'

export type ModerationConflictMessage = Readonly<{
  key: MessageKey
  conflicts: readonly AdminCommentCursor[]
}>

export type ModerationDisplayMessage =
  | MessageKey
  | Readonly<{ key: MessageKey; params: Readonly<Record<string, string | number>> }>
  | ModerationConflictMessage

export interface AdminModerationTransport {
  readAdminCommentQueue(after: AdminCommentCursor | null, signal: AbortSignal): Promise<AdminCommentQueue>
  claimComment(target: AdminCommentCursor, signal: AbortSignal): Promise<AdminModerationClaim>
  renewCommentClaim(claim: AdminModerationClaim, signal: AbortSignal): Promise<AdminModerationClaim>
  releaseCommentClaim(claim: AdminModerationClaim, signal: AbortSignal): Promise<void>
  proveAdminModerationDecision(command: AdminModerationDecision, signal: AbortSignal): Promise<string>
  decideComment(command: AdminModerationDecision, proof: string, signal: AbortSignal): Promise<void>
  claimModerationBatch(targets: readonly AdminCommentCursor[], signal: AbortSignal): Promise<readonly AdminModerationClaim[]>
  proveAndDecideModerationBatch(command: AdminModerationBatchDecision, signal: AbortSignal): Promise<AdminModerationBatchReceipt>
  readModerationTimeline(article: string, comment: string, signal: AbortSignal): Promise<ModerationTimeline>
  readCommentRevisions(article: string, comment: string, before: number | null, signal: AbortSignal): Promise<CommentRevisionPage>
}

export const defaultAdminModerationTransport: AdminModerationTransport = {
  readAdminCommentQueue,
  claimComment,
  renewCommentClaim,
  releaseCommentClaim,
  proveAdminModerationDecision,
  decideComment,
  claimModerationBatch,
  proveAndDecideModerationBatch,
  readModerationTimeline,
  readCommentRevisions,
}

export interface AdminModerationHooks {
  onSessionLost?: (error: ApiError) => void
  onBatchClaimed?: (isActive: () => boolean) => void | Promise<void>
}

export interface AdminModerationControllerOptions {
  transport?: AdminModerationTransport
  clock?: AdminClock
  hooks?: AdminModerationHooks
}

export type AdminModerationState = Readonly<{
  queue: AdminCommentQueue | null
  claim: AdminModerationClaim | null
  batchClaims: readonly AdminModerationClaim[] | null
  selected: ReadonlySet<string>
  reason: string
  batchReason: string
  busy: boolean
  failure: ModerationDisplayMessage | ''
  notice: ModerationDisplayMessage | ''
  historyArticle: string
  historyComment: string
  historyDialogOpen: boolean
  historyLoading: boolean
  historyError: MessageKey | ''
  history: ModerationTimeline | null
  revisions: CommentRevisionPage | null
}>

export function moderationCoordinate(row: AdminCommentCursor): string {
  return `${row.articleId}/${row.commentId}`
}

function repeatableConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409)
}

function batchConflict(error: unknown, targets: readonly AdminCommentCursor[]): ModerationConflictMessage | null {
  const conflicts = readModerationBatchConflicts(error, targets)
  if (!conflicts) return null
  return { key: 'admin.moderation.m63', conflicts }
}

/**
 * Explicit state & lease controller for AdminModerationControls.
 * Owns single/batch moderation claims, batch selection, expiry timers,
 * conflict resolution, history loading, cancellation, and idempotent disposal.
 */
export class AdminModerationController {
  private readonly transport: AdminModerationTransport
  private readonly clock: AdminClock
  private readonly hooks: AdminModerationHooks
  private readonly scope: AdminSessionScope
  private readonly mainChannel: AdminOperationChannel
  private readonly historyChannel: AdminOperationChannel
  private readonly listeners = new Set<() => void>()

  private _queue: AdminCommentQueue | null = null
  private _claim: AdminModerationClaim | null = null
  private _batchClaims: readonly AdminModerationClaim[] | null = null
  private _selected: ReadonlySet<string> = new Set()
  private _reason = ''
  private _batchReason = ''
  private _failure: ModerationDisplayMessage | '' = ''
  private _notice: ModerationDisplayMessage | '' = ''
  private _historyArticle = ''
  private _historyComment = ''
  private _historyDialogOpen = false
  private _historyError: MessageKey | '' = ''
  private _history: ModerationTimeline | null = null
  private _revisions: CommentRevisionPage | null = null
  private cursor: AdminCommentCursor | null = null
  private claimTimer: TimerHandle | undefined
  private claimTimerGeneration = 0
  private batchTimer: TimerHandle | undefined
  private batchTimerGeneration = 0
  private _snapshot: AdminModerationState

  constructor(options: AdminModerationControllerOptions = {}) {
    this.transport = options.transport ?? defaultAdminModerationTransport
    this.clock = options.clock ?? systemAdminClock
    this.hooks = options.hooks ?? {}
    this.scope = new AdminSessionScope({
      onReset: () => {
        this.clearReviewInternal()
        this.emitChange()
      },
    })
    this.mainChannel = new AdminOperationChannel(this.scope, () => this.emitChange())
    this.historyChannel = new AdminOperationChannel(this.scope, () => this.emitChange())
    this._snapshot = this.buildSnapshot()
  }

  get state(): AdminModerationState {
    return this._snapshot
  }

  get disposed(): boolean {
    return this.scope.disposed
  }

  get trimmedReason(): string {
    return this._reason.trim()
  }

  get reasonValid(): boolean {
    return validModerationReason(this.trimmedReason)
  }

  get trimmedBatchReason(): string {
    return this._batchReason.trim()
  }

  get batchReasonValid(): boolean {
    return validModerationReason(this.trimmedBatchReason)
  }

  get batchExpiry(): number | null {
    if (!this._batchClaims || this._batchClaims.length === 0) return null
    return Math.min(...this._batchClaims.map(row => Number(row.expiresAt)))
  }

  get selectedTargets() {
    return this._queue?.comments.filter(row => this._selected.has(moderationCoordinate(row))) ?? []
  }

  get visibleComments() {
    return this._batchClaims ? this.selectedTargets : this._queue?.comments ?? []
  }

  get batchAvailable(): boolean {
    return this._queue?.batchEnabled === true &&
      this._queue.comments.length >= WireLimits.AdminModerationBatchMinimum &&
      !this._claim
  }

  get canReadHistory(): boolean {
    return !this.historyChannel.pending && validModerationCoordinates(this._historyArticle, this._historyComment)
  }

  snapshot(): AdminModerationState {
    return this._snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isClaimed(row: AdminCommentCursor): boolean {
    return this._claim?.articleId === row.articleId && this._claim.commentId === row.commentId
  }

  bindSession(signal: AbortSignal, options: Readonly<{ autoLoad?: boolean }> = {}): void {
    const autoLoad = options.autoLoad ?? true
    const { active } = this.scope.bindSession(signal)
    if (active && autoLoad) void this.load()
  }

  cancel(): void {
    this.scope.cancelOperations()
  }

  dispose(): void {
    this.scope.dispose()
  }

  setReason(value: string): void {
    if (this._reason === value) return
    this._reason = value
    this.emitChange()
  }

  setBatchReason(value: string): void {
    if (this._batchReason === value) return
    this._batchReason = value
    this.emitChange()
  }

  setHistoryArticle(value: string): void {
    if (this._historyArticle === value) return
    this._historyArticle = value
    this.historyChannel.cancel()
    this.clearHistoryInternal()
    this.emitChange()
  }

  setHistoryComment(value: string): void {
    if (this._historyComment === value) return
    this._historyComment = value
    this.historyChannel.cancel()
    this.clearHistoryInternal()
    this.emitChange()
  }

  setHistoryDialogOpen(open: boolean): void {
    if (this._historyDialogOpen === open) return
    this._historyDialogOpen = open
    this.emitChange()
  }

  load(after: AdminCommentCursor | null = null): Promise<boolean> | undefined {
    if (this._claim || this._batchClaims) return undefined
    return this.runMain(async ctx => {
      this.clearBatchInternal()
      this._queue = null
      this.emitChange()
      const response = await this.transport.readAdminCommentQueue(after, ctx.signal)
      if (!ctx.isCurrent()) return
      this.cursor = after
      this._queue = response
      this.emitChange()
    }, () => 'admin.moderation.m12')
  }

  async openCommentHistory(row: AdminCommentCursor): Promise<void> {
    const nextArticle = String(row.articleId)
    const nextComment = row.commentId.toString()
    const changed = this._historyArticle !== nextArticle || this._historyComment !== nextComment
    this._historyArticle = nextArticle
    this._historyComment = nextComment
    if (changed) {
      this.historyChannel.cancel()
      this.clearHistoryInternal()
    }
    this._historyDialogOpen = true
    this.emitChange()
    await this.loadHistoryAndRevisions()
  }

  loadHistory(): void {
    this._historyDialogOpen = true
    this.emitChange()
    void this.loadHistoryAndRevisions()
  }

  loadRevisions(before: number | null = null): void {
    this._historyDialogOpen = true
    this.emitChange()
    void this.loadHistoryAndRevisions(before)
  }

  loadHistoryAndRevisions(before: number | null = null): Promise<boolean> | undefined {
    const article = this._historyArticle
    const comment = this._historyComment
    if (!validModerationCoordinates(article, comment) || this.historyChannel.pending || !this.scope.active) {
      return undefined
    }

    return this.historyChannel.run(async ctx => {
      if (before) {
        const page = await this.transport.readCommentRevisions(article, comment, before, ctx.signal)
        if (!ctx.isCurrent() || article !== this._historyArticle || comment !== this._historyComment) return
        this._revisions = page
        this.emitChange()
      } else {
        const [timeline, page] = await Promise.all([
          this.transport.readModerationTimeline(article, comment, ctx.signal).catch(error => {
            if (error instanceof ApiError && error.status === 404) return null
            throw error
          }),
          this.transport.readCommentRevisions(article, comment, null, ctx.signal).catch(error => {
            if (error instanceof ApiError && error.status === 404) return null
            throw error
          }),
        ])
        if (!ctx.isCurrent() || article !== this._historyArticle || comment !== this._historyComment) return
        this._history = timeline
        this._revisions = page
        if (!timeline && !page) this._historyError = 'admin.moderation.m13'
        this.emitChange()
      }
    }, {
      onStart: () => {
        this._historyError = ''
        if (!before) {
          this._history = null
          this._revisions = null
        }
      },
      onError: error => {
        if (error instanceof ApiError && error.status === 401) {
          this._historyDialogOpen = false
          this.clearReviewInternal()
          this.emitChange()
          this.hooks.onSessionLost?.(error)
        } else {
          this._historyError = error instanceof ApiError && error.status === 404
            ? 'admin.moderation.m13'
            : 'admin.moderation.m14'
          this.emitChange()
        }
      },
    })
  }

  claimForReview(target: AdminCommentCursor): Promise<boolean> | undefined {
    if (this._claim || this._batchClaims || this._selected.size > 0) return undefined
    return this.runMain(async ctx => {
      const receipt = await this.transport.claimComment(target, ctx.signal)
      if (!ctx.isCurrent()) return
      this.setClaimInternal(receipt)
      this.emitChange()
    }, error => repeatableConflict(error) ? 'admin.moderation.m17' : 'admin.moderation.m18')
  }

  renew(): Promise<boolean> | undefined {
    const receipt = this._claim
    if (!receipt) return undefined
    const preservedReason = this._reason
    return this.runMain(async ctx => {
      const renewed = await this.transport.renewCommentClaim(receipt, ctx.signal)
      if (!ctx.isCurrent()) return
      this._failure = ''
      this.setClaimInternal(renewed, { preserveReason: true })
      if (this._claim === renewed) this._reason = preservedReason
      this.emitChange()
    }, error => this.claimFailure(error, 'admin.moderation.m19'))
  }

  release(): Promise<boolean> | undefined {
    const receipt = this._claim
    if (!receipt) return undefined
    return this.runMain(async ctx => {
      await this.transport.releaseCommentClaim(receipt, ctx.signal)
      if (!ctx.isCurrent()) return
      this._failure = ''
      this.setClaimInternal(null)
      this._notice = 'admin.moderation.m20'
      this.emitChange()
    }, error => this.claimFailure(error, 'admin.moderation.m21'))
  }

  decide(decision: 1 | 2): Promise<boolean> | undefined {
    const receipt = this._claim
    if (!receipt || !this.reasonValid) return undefined
    const command: AdminModerationDecision = {
      articleId: receipt.articleId,
      commentId: receipt.commentId,
      expectedStatus: 0,
      decision,
      reason: this.trimmedReason,
      commentVersion: receipt.commentVersion,
      claimToken: receipt.claimToken,
      claimGeneration: receipt.claimGeneration,
      claimVersion: receipt.claimVersion,
    }
    return this.runMain(async ctx => {
      const proof = await this.transport.proveAdminModerationDecision(command, ctx.signal)
      if (!ctx.isCurrent() || this._claim !== receipt) return
      await this.transport.decideComment(command, proof, ctx.signal)
      if (!ctx.isCurrent()) return
      this.setClaimInternal(null)
      this._queue = null
      this._notice = decision === 1 ? 'admin.moderation.m23' : 'admin.moderation.m24'
      this.emitChange()
      const updated = await this.transport.readAdminCommentQueue(this.cursor, ctx.signal)
      if (!ctx.isCurrent()) return
      this._queue = updated
      this.emitChange()
    }, error => this.claimFailure(error, this._notice ? 'admin.moderation.m25' : 'admin.moderation.m26'))
  }

  select(row: AdminCommentCursor, checked: boolean): void {
    if (!this.batchAvailable || this._batchClaims || this.mainChannel.pending || !this.scope.active) return
    const key = moderationCoordinate(row)
    const next = new Set(this._selected)
    if (!checked) next.delete(key)
    else if (next.size < WireLimits.AdminModerationBatchCount) next.add(key)
    this._selected = next
    this.emitChange()
  }

  startBatch(): Promise<boolean> | undefined {
    const targets = this.selectedTargets
    if (!this.batchAvailable || this._batchClaims || targets.length < WireLimits.AdminModerationBatchMinimum) {
      return undefined
    }
    return this.runMain(async ctx => {
      const receipts = await this.transport.claimModerationBatch(targets, ctx.signal)
      if (!ctx.isCurrent()) return
      this._batchClaims = receipts
      this.scheduleBatchExpiry(receipts)
      this.emitChange()
      if (this._batchClaims === receipts && this.hooks.onBatchClaimed) {
        await this.hooks.onBatchClaimed(() => ctx.isCurrent() && this._batchClaims === receipts)
      }
    }, error => batchConflict(error, targets) ?? 'admin.moderation.m28')
  }

  cancelBatch(): Promise<boolean> | undefined {
    const receipts = this._batchClaims
    if (!receipts) return undefined
    return this.runMain(async ctx => {
      this.clearBatchInternal()
      this.emitChange()
      const released = await this.releaseBatchClaims(receipts, ctx)
      if (!ctx.isCurrent()) return
      if (released) this._notice = 'admin.moderation.m29'
      else this._failure = 'admin.moderation.m30'
      this.emitChange()
    }, () => 'admin.moderation.m30')
  }

  decideBatch(decision: 1 | 2): Promise<boolean> | undefined {
    const receipts = this._batchClaims
    if (!receipts || !this.batchReasonValid) return undefined
    const rows = receipts.map(({ expiresAt: _, ...receipt }) => ({ ...receipt, expectedStatus: 0 as const }))
    const command: AdminModerationBatchDecision = { decision, reason: this.trimmedBatchReason, rows }
    return this.runMain(async ctx => {
      try {
        const receipt = await this.transport.proveAndDecideModerationBatch(command, ctx.signal)
        if (!ctx.isCurrent()) return
        this.clearBatchInternal()
        this._failure = ''
        this._queue = null
        this._notice = decision === 1
          ? { key: 'admin.moderation.m65', params: { count: receipt.count } }
          : { key: 'admin.moderation.m66', params: { count: receipt.count } }
        this.emitChange()
        const updated = await this.transport.readAdminCommentQueue(this.cursor, ctx.signal)
        if (!ctx.isCurrent()) return
        this._queue = updated
        this.emitChange()
      } catch (error) {
        if (!ctx.isCurrent()) return
        const conflict = batchConflict(error, rows)
        if (!conflict) throw error
        this.clearBatchInternal()
        this.emitChange()
        const released = await this.releaseBatchClaims(receipts, ctx)
        if (!ctx.isCurrent()) return
        this._failure = released ? conflict : { ...conflict, key: 'admin.moderation.m64' }
        this.emitChange()
      }
    }, () => this._notice ? 'admin.moderation.m25' : 'admin.moderation.m31')
  }

  private runMain(
    task: (context: AdminOperationContext) => Promise<void>,
    explain: (error: unknown) => ModerationDisplayMessage,
  ): Promise<boolean> {
    return this.mainChannel.run(task, {
      onStart: () => {
        this._failure = ''
        this._notice = ''
      },
      onError: error => {
        if (error instanceof ApiError && error.status === 401) {
          this.clearReviewInternal()
          this.emitChange()
          this.hooks.onSessionLost?.(error)
        } else if (error instanceof ApiError && error.status === 403) {
          this.clearReviewInternal()
          this._failure = 'admin.moderation.m11'
          this.emitChange()
        } else {
          this._failure = explain(error)
          this.emitChange()
        }
      },
    })
  }

  private claimFailure(error: unknown, fallback: ModerationDisplayMessage): ModerationDisplayMessage {
    if (!repeatableConflict(error)) return fallback
    this.setClaimInternal(null)
    return 'admin.moderation.m22'
  }

  private async releaseBatchClaims(
    receipts: readonly AdminModerationClaim[],
    ctx: AdminOperationContext,
  ): Promise<boolean> {
    let released = true
    for (const receipt of receipts) {
      if (!ctx.isCurrent()) return false
      try {
        await this.transport.releaseCommentClaim(receipt, ctx.signal)
      } catch (error) {
        if (!ctx.isCurrent()) throw error
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error
        if (!repeatableConflict(error)) released = false
      }
    }
    return released
  }

  private clearClaimTimer(): void {
    this.claimTimerGeneration++
    if (this.claimTimer !== undefined) {
      this.clock.clearTimeout(this.claimTimer)
      this.claimTimer = undefined
    }
  }

  private clearBatchTimer(): void {
    this.batchTimerGeneration++
    if (this.batchTimer !== undefined) {
      this.clock.clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
  }

  private setClaimInternal(next: AdminModerationClaim | null, options: Readonly<{ preserveReason?: boolean }> = {}): void {
    this.clearClaimTimer()
    if (!options.preserveReason && (!next || !this.isClaimed(next))) this._reason = ''
    this._claim = next
    if (!next) return

    const until = Number(next.expiresAt)
    const expectedEpoch = this.scope.sessionEpoch
    const generation = this.claimTimerGeneration

    const expire = () => {
      if (generation !== this.claimTimerGeneration || !this.scope.isSessionCurrent(expectedEpoch) || this._claim !== next) {
        return
      }
      const remaining = until - this.clock.now()
      if (remaining > 0) {
        this.claimTimer = this.clock.setTimeout(() => {
          this.claimTimer = undefined
          expire()
        }, Math.min(remaining, MAX_TIMEOUT_MS))
      } else {
        this.setClaimInternal(null)
        this._failure = 'admin.moderation.m10'
        this.emitChange()
      }
    }

    expire()
  }

  private scheduleBatchExpiry(receipts: readonly AdminModerationClaim[]): void {
    this.clearBatchTimer()
    if (receipts.length === 0) return

    const until = Math.min(...receipts.map(row => Number(row.expiresAt)))
    const expectedEpoch = this.scope.sessionEpoch
    const generation = this.batchTimerGeneration

    const expire = () => {
      if (generation !== this.batchTimerGeneration || !this.scope.isSessionCurrent(expectedEpoch) || this._batchClaims !== receipts) {
        return
      }
      const remaining = until - this.clock.now()
      if (remaining > 0) {
        this.batchTimer = this.clock.setTimeout(() => {
          this.batchTimer = undefined
          expire()
        }, Math.min(remaining, MAX_TIMEOUT_MS))
      } else {
        this.clearBatchInternal()
        this._failure = 'admin.moderation.m27'
        this.emitChange()
      }
    }

    expire()
  }

  private clearBatchInternal(): void {
    this.clearBatchTimer()
    this._batchClaims = null
    this._selected = new Set()
    this._batchReason = ''
  }

  private clearHistoryInternal(): void {
    this._history = null
    this._revisions = null
    this._historyError = ''
  }

  private clearReviewInternal(): void {
    this.setClaimInternal(null)
    this.clearBatchInternal()
    this.cursor = null
    this._queue = null
    this._notice = ''
    this._failure = ''
    this._historyArticle = ''
    this._historyComment = ''
    this._historyDialogOpen = false
    this.clearHistoryInternal()
  }

  private buildSnapshot(): AdminModerationState {
    return {
      queue: this._queue,
      claim: this._claim,
      batchClaims: this._batchClaims,
      selected: this._selected,
      reason: this._reason,
      batchReason: this._batchReason,
      busy: this.mainChannel.pending,
      failure: this._failure,
      notice: this._notice,
      historyArticle: this._historyArticle,
      historyComment: this._historyComment,
      historyDialogOpen: this._historyDialogOpen,
      historyLoading: this.historyChannel.pending,
      historyError: this._historyError,
      history: this._history,
      revisions: this._revisions,
    }
  }

  private emitChange(): void {
    this._snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}
