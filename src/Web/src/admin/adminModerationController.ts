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
type ClaimExpiry = { generation: number; timer?: TimerHandle }
type ModerationData = Omit<AdminModerationState, 'busy' | 'historyLoading'>
type WritableModerationData = { -readonly [K in keyof ModerationData]: ModerationData[K] }

const emptyModerationData = (): WritableModerationData => ({
  queue: null, claim: null, batchClaims: null, selected: new Set(), reason: '', batchReason: '',
  failure: '', notice: '', historyArticle: '', historyComment: '', historyDialogOpen: false,
  historyError: '', history: null, revisions: null,
})

export class AdminModerationController {
  private readonly transport: AdminModerationTransport
  private readonly clock: AdminClock
  private readonly hooks: AdminModerationHooks
  private readonly scope: AdminSessionScope
  private readonly mainChannel: AdminOperationChannel
  private readonly historyChannel: AdminOperationChannel
  private readonly listeners = new Set<() => void>()

  private s: WritableModerationData = emptyModerationData()
  private cursor: AdminCommentCursor | null = null
  private readonly claimExpiry: ClaimExpiry = { generation: 0 }
  private readonly batchTimerSlot: ClaimExpiry = { generation: 0 }
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

  get state(): AdminModerationState { return this._snapshot }
  get disposed(): boolean { return this.scope.disposed }
  get trimmedReason(): string { return this.s.reason.trim() }
  get reasonValid(): boolean { return validModerationReason(this.trimmedReason) }
  get trimmedBatchReason(): string { return this.s.batchReason.trim() }
  get batchReasonValid(): boolean { return validModerationReason(this.trimmedBatchReason) }
  get batchExpiry(): number | null {
    return this.s.batchClaims?.length ? Math.min(...this.s.batchClaims.map(row => Number(row.expiresAt))) : null
  }
  get selectedTargets() {
    return this.s.queue?.comments.filter(row => this.s.selected.has(moderationCoordinate(row))) ?? []
  }
  get visibleComments() { return this.s.batchClaims ? this.selectedTargets : this.s.queue?.comments ?? [] }
  get batchAvailable(): boolean {
    return this.s.queue?.batchEnabled === true &&
      this.s.queue.comments.length >= WireLimits.AdminModerationBatchMinimum && !this.s.claim
  }
  get canReadHistory(): boolean {
    return !this.historyChannel.pending && validModerationCoordinates(this.s.historyArticle, this.s.historyComment)
  }

  snapshot(): AdminModerationState { return this._snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  isClaimed(row: AdminCommentCursor): boolean {
    return this.s.claim?.articleId === row.articleId && this.s.claim.commentId === row.commentId
  }

  bindSession(signal: AbortSignal, options: Readonly<{ autoLoad?: boolean }> = {}): void {
    const { active } = this.scope.bindSession(signal)
    if (active && (options.autoLoad ?? true)) void this.load()
  }

  cancel(): void { this.scope.cancelOperations() }
  dispose(): void { this.scope.dispose() }

  private setField<K extends 'reason' | 'batchReason' | 'historyDialogOpen'>(key: K, value: WritableModerationData[K]): void {
    if (this.s[key] === value) return
    this.s[key] = value
    this.emitChange()
  }
  private setHistoryKey(key: 'historyArticle' | 'historyComment', value: string): void {
    if (this.s[key] === value) return
    this.s[key] = value
    this.historyChannel.cancel()
    this.clearHistoryInternal()
    this.emitChange()
  }

  setReason(value: string): void { this.setField('reason', value) }
  setBatchReason(value: string): void { this.setField('batchReason', value) }
  setHistoryArticle(value: string): void { this.setHistoryKey('historyArticle', value) }
  setHistoryComment(value: string): void { this.setHistoryKey('historyComment', value) }
  setHistoryDialogOpen(open: boolean): void { this.setField('historyDialogOpen', open) }

  load(after: AdminCommentCursor | null = null): Promise<boolean> | undefined {
    if (this.s.claim || this.s.batchClaims) return undefined
    return this.runMain(async ctx => {
      this.clearBatchInternal()
      this.s.queue = null
      this.emitChange()
      const response = await this.transport.readAdminCommentQueue(after, ctx.signal)
      if (!ctx.isCurrent()) return
      this.cursor = after
      this.s.queue = response
      this.emitChange()
    }, () => 'admin.moderation.m12')
  }

  async openCommentHistory(row: AdminCommentCursor): Promise<void> {
    const nextArticle = String(row.articleId)
    const nextComment = row.commentId.toString()
    const changed = this.s.historyArticle !== nextArticle || this.s.historyComment !== nextComment
    this.s.historyArticle = nextArticle
    this.s.historyComment = nextComment
    if (changed) {
      this.historyChannel.cancel()
      this.clearHistoryInternal()
    }
    this.s.historyDialogOpen = true
    this.emitChange()
    await this.loadHistoryAndRevisions()
  }

  loadHistory(): void { this.loadRevisions(null) }
  loadRevisions(before: number | null = null): void {
    this.s.historyDialogOpen = true
    this.emitChange()
    void this.loadHistoryAndRevisions(before)
  }

  loadHistoryAndRevisions(before: number | null = null): Promise<boolean> | undefined {
    const { historyArticle: article, historyComment: comment } = this.s
    if (!validModerationCoordinates(article, comment) || this.historyChannel.pending || !this.scope.active) return undefined

    return this.historyChannel.run(async ctx => {
      const sameTarget = () => ctx.isCurrent() && article === this.s.historyArticle && comment === this.s.historyComment
      if (before) {
        const page = await this.transport.readCommentRevisions(article, comment, before, ctx.signal)
        if (!sameTarget()) return
        this.s.revisions = page
        this.emitChange()
      } else {
        const allow404 = <T>(promise: Promise<T>) => promise.catch(error => {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        })
        const [timeline, page] = await Promise.all([
          allow404(this.transport.readModerationTimeline(article, comment, ctx.signal)),
          allow404(this.transport.readCommentRevisions(article, comment, null, ctx.signal)),
        ])
        if (!sameTarget()) return
        this.s.history = timeline
        this.s.revisions = page
        if (!timeline && !page) this.s.historyError = 'admin.moderation.m13'
        this.emitChange()
      }
    }, {
      onStart: () => {
        this.s.historyError = ''
        if (!before) {
          this.s.history = null
          this.s.revisions = null
        }
      },
      onError: error => {
        if (error instanceof ApiError && error.status === 401) {
          this.s.historyDialogOpen = false
          this.clearReviewInternal()
          this.emitChange()
          this.hooks.onSessionLost?.(error)
        } else {
          this.s.historyError = error instanceof ApiError && error.status === 404 ? 'admin.moderation.m13' : 'admin.moderation.m14'
          this.emitChange()
        }
      },
    })
  }

  claimForReview(target: AdminCommentCursor): Promise<boolean> | undefined {
    if (this.s.claim || this.s.batchClaims || this.s.selected.size > 0) return undefined
    return this.runMain(async ctx => {
      const receipt = await this.transport.claimComment(target, ctx.signal)
      if (!ctx.isCurrent()) return
      this.setClaimInternal(receipt)
      this.emitChange()
    }, error => repeatableConflict(error) ? 'admin.moderation.m17' : 'admin.moderation.m18')
  }

  renew(): Promise<boolean> | undefined {
    const receipt = this.s.claim
    if (!receipt) return undefined
    const preservedReason = this.s.reason
    return this.runMain(async ctx => {
      const renewed = await this.transport.renewCommentClaim(receipt, ctx.signal)
      if (!ctx.isCurrent()) return
      this.s.failure = ''
      this.setClaimInternal(renewed, { preserveReason: true })
      if (this.s.claim === renewed) this.s.reason = preservedReason
      this.emitChange()
    }, error => this.claimFailure(error, 'admin.moderation.m19'))
  }

  release(): Promise<boolean> | undefined {
    const receipt = this.s.claim
    if (!receipt) return undefined
    return this.runMain(async ctx => {
      await this.transport.releaseCommentClaim(receipt, ctx.signal)
      if (!ctx.isCurrent()) return
      this.s.failure = ''
      this.setClaimInternal(null)
      this.s.notice = 'admin.moderation.m20'
      this.emitChange()
    }, error => this.claimFailure(error, 'admin.moderation.m21'))
  }

  decide(decision: 1 | 2): Promise<boolean> | undefined {
    const receipt = this.s.claim
    if (!receipt || !this.reasonValid) return undefined
    const { expiresAt: _, ...rest } = receipt
    const command: AdminModerationDecision = { ...rest, expectedStatus: 0, decision, reason: this.trimmedReason }
    return this.runMain(async ctx => {
      const proof = await this.transport.proveAdminModerationDecision(command, ctx.signal)
      if (!ctx.isCurrent() || this.s.claim !== receipt) return
      await this.transport.decideComment(command, proof, ctx.signal)
      if (!ctx.isCurrent()) return
      this.setClaimInternal(null)
      this.s.queue = null
      this.s.notice = decision === 1 ? 'admin.moderation.m23' : 'admin.moderation.m24'
      this.emitChange()
      const updated = await this.transport.readAdminCommentQueue(this.cursor, ctx.signal)
      if (!ctx.isCurrent()) return
      this.s.queue = updated
      this.emitChange()
    }, error => this.claimFailure(error, this.s.notice ? 'admin.moderation.m25' : 'admin.moderation.m26'))
  }

  select(row: AdminCommentCursor, checked: boolean): void {
    if (!this.batchAvailable || this.s.batchClaims || this.mainChannel.pending || !this.scope.active) return
    const key = moderationCoordinate(row)
    const next = new Set(this.s.selected)
    if (!checked) next.delete(key)
    else if (next.size < WireLimits.AdminModerationBatchCount) next.add(key)
    this.s.selected = next
    this.emitChange()
  }

  startBatch(): Promise<boolean> | undefined {
    const targets = this.selectedTargets
    if (!this.batchAvailable || this.s.batchClaims || targets.length < WireLimits.AdminModerationBatchMinimum) return undefined
    return this.runMain(async ctx => {
      const receipts = await this.transport.claimModerationBatch(targets, ctx.signal)
      if (!ctx.isCurrent()) return
      this.s.batchClaims = receipts
      this.scheduleBatchExpiry(receipts)
      this.emitChange()
      if (this.s.batchClaims === receipts && this.hooks.onBatchClaimed) {
        await this.hooks.onBatchClaimed(() => ctx.isCurrent() && this.s.batchClaims === receipts)
      }
    }, error => batchConflict(error, targets) ?? 'admin.moderation.m28')
  }

  cancelBatch(): Promise<boolean> | undefined {
    const receipts = this.s.batchClaims
    if (!receipts) return undefined
    return this.runMain(async ctx => {
      this.clearBatchInternal()
      this.emitChange()
      const released = await this.releaseBatchClaims(receipts, ctx)
      if (!ctx.isCurrent()) return
      if (released) this.s.notice = 'admin.moderation.m29'
      else this.s.failure = 'admin.moderation.m30'
      this.emitChange()
    }, () => 'admin.moderation.m30')
  }

  decideBatch(decision: 1 | 2): Promise<boolean> | undefined {
    const receipts = this.s.batchClaims
    if (!receipts || !this.batchReasonValid) return undefined
    const rows = receipts.map(({ expiresAt: _, ...receipt }) => ({ ...receipt, expectedStatus: 0 as const }))
    const command: AdminModerationBatchDecision = { decision, reason: this.trimmedBatchReason, rows }
    return this.runMain(async ctx => {
      try {
        const receipt = await this.transport.proveAndDecideModerationBatch(command, ctx.signal)
        if (!ctx.isCurrent()) return
        this.clearBatchInternal()
        this.s.failure = ''
        this.s.queue = null
        this.s.notice = { key: decision === 1 ? 'admin.moderation.m65' : 'admin.moderation.m66', params: { count: receipt.count } }
        this.emitChange()
        const updated = await this.transport.readAdminCommentQueue(this.cursor, ctx.signal)
        if (!ctx.isCurrent()) return
        this.s.queue = updated
        this.emitChange()
      } catch (error) {
        if (!ctx.isCurrent()) return
        const conflict = batchConflict(error, rows)
        if (!conflict) throw error
        this.clearBatchInternal()
        this.emitChange()
        const released = await this.releaseBatchClaims(receipts, ctx)
        if (!ctx.isCurrent()) return
        this.s.failure = released ? conflict : { ...conflict, key: 'admin.moderation.m64' }
        this.emitChange()
      }
    }, () => this.s.notice ? 'admin.moderation.m25' : 'admin.moderation.m31')
  }

  private runMain(
    task: (context: AdminOperationContext) => Promise<void>,
    explain: (error: unknown) => ModerationDisplayMessage,
  ): Promise<boolean> {
    return this.mainChannel.run(task, {
      onStart: () => {
        this.s.failure = ''
        this.s.notice = ''
      },
      onError: error => {
        if (error instanceof ApiError && error.status === 401) {
          this.clearReviewInternal()
          this.emitChange()
          this.hooks.onSessionLost?.(error)
        } else if (error instanceof ApiError && error.status === 403) {
          this.clearReviewInternal()
          this.s.failure = 'admin.moderation.m11'
          this.emitChange()
        } else {
          this.s.failure = explain(error)
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

  private async releaseBatchClaims(receipts: readonly AdminModerationClaim[], ctx: AdminOperationContext): Promise<boolean> {
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

  private clearExpiry(slot: ClaimExpiry): void {
    slot.generation++
    if (slot.timer !== undefined) {
      this.clock.clearTimeout(slot.timer)
      slot.timer = undefined
    }
  }

  private scheduleExpiry(slot: ClaimExpiry, until: number, current: () => boolean, expired: () => void): void {
    const expectedEpoch = this.scope.sessionEpoch
    const generation = slot.generation
    const expire = () => {
      if (generation !== slot.generation || !this.scope.isSessionCurrent(expectedEpoch) || !current()) return
      const remaining = until - this.clock.now()
      if (remaining > 0) {
        slot.timer = this.clock.setTimeout(() => {
          slot.timer = undefined
          expire()
        }, Math.min(remaining, MAX_TIMEOUT_MS))
      } else expired()
    }
    expire()
  }

  private setClaimInternal(next: AdminModerationClaim | null, options: Readonly<{ preserveReason?: boolean }> = {}): void {
    this.clearExpiry(this.claimExpiry)
    if (!options.preserveReason && (!next || !this.isClaimed(next))) this.s.reason = ''
    this.s.claim = next
    if (!next) return
    this.scheduleExpiry(this.claimExpiry, Number(next.expiresAt), () => this.s.claim === next, () => {
      this.setClaimInternal(null)
      this.s.failure = 'admin.moderation.m10'
      this.emitChange()
    })
  }

  private scheduleBatchExpiry(receipts: readonly AdminModerationClaim[]): void {
    this.clearExpiry(this.batchTimerSlot)
    if (receipts.length === 0) return
    this.scheduleExpiry(this.batchTimerSlot, Math.min(...receipts.map(row => Number(row.expiresAt))), () => this.s.batchClaims === receipts, () => {
      this.clearBatchInternal()
      this.s.failure = 'admin.moderation.m27'
      this.emitChange()
    })
  }

  private clearBatchInternal(): void {
    this.clearExpiry(this.batchTimerSlot)
    this.s.batchClaims = null
    this.s.selected = new Set()
    this.s.batchReason = ''
  }

  private clearHistoryInternal(): void {
    this.s.history = null
    this.s.revisions = null
    this.s.historyError = ''
  }

  private clearReviewInternal(): void {
    this.clearExpiry(this.claimExpiry)
    this.clearExpiry(this.batchTimerSlot)
    this.cursor = null
    this.s = emptyModerationData()
  }

  private buildSnapshot(): AdminModerationState {
    return { ...this.s, busy: this.mainChannel.pending, historyLoading: this.historyChannel.pending }
  }

  private emitChange(): void {
    this._snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}
