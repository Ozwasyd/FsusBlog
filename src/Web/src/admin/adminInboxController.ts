import { ApiError } from '../../../Contracts/aeds.ts'
import {
  acknowledgeAdminInboxRead,
  adminChangeStatus,
  adminInbox,
  adminInboxThread,
  adminReply,
  supportsAdminInboxLiveStatus,
  watchAdminInboxWake,
  type AdminInboxFilter,
  type AdminInboxLiveStatus,
  type AdminInboxOrder,
  type AdminInboxPage,
  type AdminInboxRow,
  type AdminInboxStatus,
  type AdminInboxThread,
} from '../../../Contracts/admin-inbox.ts'
import {
  adminSendNotice,
  isNoticeRecipient,
  newNoticeEventId,
} from '../../../Contracts/admin-inbox-notice.ts'
import type { MessageKey } from '../siteLocale.ts'
import {
  AdminOperationChannel,
  AdminSessionScope,
  systemAdminClock,
  type AdminClock,
  type AdminOperationContext,
  type TimerHandle,
} from './adminOperationCoordinator.ts'

export const adminInboxStatusFilters = ['open', 'pending', 'closed'] as const
export const adminInboxStatusTransitions: readonly (readonly AdminInboxStatus[])[] = [[1, 2], [0, 2], [0]]

export type AdminInboxReplyResult = Awaited<ReturnType<typeof adminReply>>
export type AdminInboxStatusResult = Awaited<ReturnType<typeof adminChangeStatus>>

export interface AdminInboxTransport {
  adminInbox(
    filter: AdminInboxFilter,
    next: string | null,
    signal: AbortSignal,
    shared?: boolean,
    order?: AdminInboxOrder,
  ): Promise<AdminInboxPage>
  adminInboxThread(
    id: bigint,
    before: string | null,
    signal: AbortSignal,
    shared?: boolean,
  ): Promise<AdminInboxThread>
  acknowledgeAdminInboxRead(
    id: bigint,
    snapshot: NonNullable<AdminInboxThread['readSnapshot']>,
    signal: AbortSignal,
  ): Promise<number>
  adminReply(id: bigint, body: string, key: string, signal: AbortSignal): Promise<AdminInboxReplyResult>
  adminChangeStatus(
    id: bigint,
    version: string,
    target: AdminInboxStatus,
    reason: string,
    signal: AbortSignal,
  ): Promise<AdminInboxStatusResult>
  adminSendNotice(
    account: string,
    subject: string,
    body: string,
    sourceEvent: bigint,
    signal: AbortSignal,
  ): Promise<unknown>
  watchAdminInboxWake(
    scope: bigint | AdminInboxLiveStatus,
    signal: AbortSignal,
    refresh: () => void,
    onRevoked: () => void,
  ): void
}

export const defaultAdminInboxTransport: AdminInboxTransport = {
  adminInbox,
  adminInboxThread,
  acknowledgeAdminInboxRead,
  adminReply,
  adminChangeStatus,
  adminSendNotice,
  watchAdminInboxWake,
}

export interface AdminInboxIdGenerator {
  randomUuid(): string
  newNoticeEventId(): bigint
}

export const defaultAdminInboxIdGenerator: AdminInboxIdGenerator = {
  randomUuid: () => crypto.randomUUID(),
  newNoticeEventId,
}

export interface AdminInboxHooks {
  onSessionLost?: (error: unknown) => void
  onReset?: () => void
  onThreadOpened?: () => void | Promise<void>
  onThreadRefreshed?: () => void | Promise<void>
  onThreadClosed?: () => void
  onBeforeApplyLatestThread?: (conversationId: bigint) => (() => void) | void
  onBeforeApplyLiveQueuePage?: () => (() => void) | void
}

export interface AdminInboxControllerOptions {
  transport?: AdminInboxTransport
  clock?: AdminClock
  idGenerator?: AdminInboxIdGenerator
  hooks?: AdminInboxHooks
}

export type AdminInboxState = Readonly<{
  rows: readonly AdminInboxRow[]
  thread: AdminInboxThread | undefined
  next: string | null
  filter: AdminInboxFilter
  order: AdminInboxOrder
  expanded: boolean
  pending: boolean
  queuePending: boolean
  threadPending: boolean
  readPending: boolean
  replyPending: boolean
  statusPending: boolean
  noticePending: boolean
  failed: MessageKey | ''
  reply: string
  notice: MessageKey | ''
  destination: AdminInboxStatus | undefined
  reason: string
  needsRefresh: boolean
  sharedRead: boolean
  activityAvailable: boolean
  queueLive: boolean
  unreadAckFailed: boolean
  noticesEnabled: boolean
  composeNotice: boolean
  recipient: string
  noticeSubject: string
  noticeBody: string
}>

interface ActiveLiveSubscription {
  readonly target: bigint | AdminInboxLiveStatus
  readonly generation: number
  readonly controller: AbortController
  retry: TimerHandle | undefined
  dirty: boolean
  refreshing: boolean
  delay: number
  refresh: () => Promise<void>
}

/**
 * Independent state and live-refresh coordinator for AdminInbox.
 * Preserves support inbox queue/thread pagination, shared read acknowledgements,
 * idempotent reply/notice keys, status transitions, PoW error handling,
 * and wake-driven live refreshes without forcing moderation lease semantics.
 */
export class AdminInboxController {
  private readonly transport: AdminInboxTransport
  private readonly clock: AdminClock
  private readonly idGenerator: AdminInboxIdGenerator
  private readonly hooks: AdminInboxHooks
  private readonly scope: AdminSessionScope
  private readonly queueChannel: AdminOperationChannel
  private readonly threadChannel: AdminOperationChannel
  private readonly readChannel: AdminOperationChannel
  private readonly replyChannel: AdminOperationChannel
  private readonly statusChannel: AdminOperationChannel
  private readonly noticeChannel: AdminOperationChannel
  private readonly listeners = new Set<() => void>()

  private _rows: AdminInboxRow[] = []
  private _thread: AdminInboxThread | undefined
  private _next: string | null = null
  private _filter: AdminInboxFilter = ''
  private _order: AdminInboxOrder = 'created'
  private _expanded = true
  private _failed: MessageKey | '' = ''
  private _reply = ''
  private _notice: MessageKey | '' = ''
  private _destination: AdminInboxStatus | undefined
  private _reason = ''
  private _needsRefresh = false
  private _sharedRead = false
  private _activityAvailable = false
  private _queueLive = false
  private _unreadAckFailed = false
  private _noticesEnabled = false
  private _composeNotice = false
  private _recipient = ''
  private _noticeSubject = ''
  private _noticeBody = ''

  private attempt: { conversation: bigint; body: string; key: string } | undefined
  private noticeAttempt: { account: string; subject: string; body: string; eventId: bigint } | undefined
  private activeLive: ActiveLiveSubscription | null = null
  private liveGeneration = 0
  private _snapshot: AdminInboxState

  constructor(options: AdminInboxControllerOptions = {}) {
    this.transport = options.transport ?? defaultAdminInboxTransport
    this.clock = options.clock ?? systemAdminClock
    this.idGenerator = options.idGenerator ?? defaultAdminInboxIdGenerator
    this.hooks = options.hooks ?? {}
    this.scope = new AdminSessionScope({
      onReset: () => {
        this.resetStateInternal()
        this.emitChange()
      },
      onSessionAborted: () => {
        this._expanded = false
        this._filter = ''
        this._order = 'created'
        this.emitChange()
      },
    })
    const onPendingChange = (pending: boolean) => {
      this.emitChange()
      if (!pending && this.activeLive?.dirty && !this.isLiveBlocked(this.activeLive.target)) {
        void this.activeLive.refresh()
      }
    }
    this.queueChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this.threadChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this.readChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this.replyChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this.statusChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this.noticeChannel = new AdminOperationChannel(this.scope, onPendingChange)
    this._snapshot = this.buildSnapshot()
  }

  get state(): AdminInboxState {
    return this._snapshot
  }

  get disposed(): boolean {
    return this.scope.disposed
  }

  snapshot(): AdminInboxState {
    return this._snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  liveScope(): bigint | AdminInboxLiveStatus | undefined {
    const current = this._thread
    if (current) return current.liveEnabled ? current.conversation.id : undefined
    const status = this._filter
    return this._expanded && this._queueLive && this._order === 'created' && supportsAdminInboxLiveStatus(status)
      ? status
      : undefined
  }

  bindSession(signal: AbortSignal, options: Readonly<{ autoLoad?: boolean }> = {}): void {
    const autoLoad = options.autoLoad ?? true
    this._expanded = !signal.aborted
    this._filter = ''
    this._order = 'created'
    const { active } = this.scope.bindSession(signal)
    if (active && autoLoad) void this.loadQueue()
  }

  cancel(): void {
    this.stopLive()
    this.scope.cancelOperations()
    this.emitChange()
  }

  dispose(): void {
    this.scope.dispose()
  }

  setFilter(next: AdminInboxFilter): void {
    if (this._filter === next) return
    this._filter = next
    if (!this._expanded) {
      this.emitChange()
      return
    }
    this.resetKeepingCapabilitiesAndReload()
  }

  setOrder(next: AdminInboxOrder): void {
    if (this._order === next) return
    this._order = next
    if (!this._expanded) {
      this.emitChange()
      return
    }
    this.resetKeepingCapabilitiesAndReload()
  }

  setReply(value: string): void {
    if (this._reply === value) return
    this._reply = value
    this.emitChange()
  }

  setDestination(value: AdminInboxStatus | undefined): void {
    if (this._destination === value) return
    this._destination = value
    this.emitChange()
  }

  setReason(value: string): void {
    if (this._reason === value) return
    this._reason = value
    this.emitChange()
  }

  setComposeNotice(open: boolean): void {
    if (this._composeNotice === open) return
    this._composeNotice = open
    this.emitChange()
  }

  setRecipient(value: string): void {
    if (this._recipient === value) return
    this._recipient = value
    this.emitChange()
  }

  setNoticeSubject(value: string): void {
    if (this._noticeSubject === value) return
    this._noticeSubject = value
    this.emitChange()
  }

  setNoticeBody(value: string): void {
    if (this._noticeBody === value) return
    this._noticeBody = value
    this.emitChange()
  }

  clearNotice(): void {
    this.clearNoticeInternal()
    this.emitChange()
  }

  closeThread(): void {
    this.threadChannel.cancel()
    this.readChannel.cancel()
    this._thread = undefined
    this._unreadAckFailed = false
    this.clearReplyInternal()
    this.clearStatusInternal()
    this.emitChange()
    this.syncLive()
    this.hooks.onThreadClosed?.()
  }

  toggle(): void {
    this._expanded = !this._expanded
    this._filter = ''
    this._order = 'created'
    this.scope.cancelOperations()
    this.resetStateInternal()
    this.emitChange()
    if (this._expanded && this.scope.active) void this.loadQueue()
  }

  loadQueue(cursor: string | null = null, options: Readonly<{ clearRowsOnError?: boolean }> = {}): Promise<boolean> {
    if (cursor === null && this.queueChannel.pending) {
      this.queueChannel.cancel()
    }
    return this.runOnChannel(this.queueChannel, async ctx => {
      let page = await this.transport.adminInbox(this._filter, cursor, ctx.signal, this._sharedRead, this._order)
      if (!ctx.isCurrent()) return
      if (!cursor && !this._sharedRead && page.sharedAvailable) {
        page = await this.transport.adminInbox(this._filter, null, ctx.signal, true, this._order)
        if (!ctx.isCurrent()) return
      }
      this.applyQueuePage(page, cursor !== null)
    }, 'admin.inbox.m39', options.clearRowsOnError ? () => {
      this._rows = []
      this._next = null
    } : undefined)
  }

  async openThread(id: bigint, before: string | null = null): Promise<boolean> {
    if (!before && this._thread?.conversation.id === id && !this._needsRefresh && !this.threadChannel.pending) {
      await this.hooks.onThreadOpened?.()
      if (this._unreadAckFailed && this._thread?.conversation.id === id && this._thread.readSnapshot) {
        await this.acknowledge(id)
      }
      return true
    }
    if (!before) {
      this.threadChannel.cancel()
      this.readChannel.cancel()
      if (this._thread && this._thread.conversation.id !== id) {
        this._unreadAckFailed = false
        this.clearReplyInternal()
        this.clearStatusInternal()
      }
    }
    const loaded = await this.runOnChannel(this.threadChannel, async ctx => {
      if (!before && this.activeLive?.target === id) {
        this.activeLive.dirty = false
      }
      const page = await this.transport.adminInboxThread(id, before, ctx.signal, this._sharedRead)
      if (!ctx.isCurrent()) return
      this._thread = before && this._thread?.conversation.id === id
        ? { ...page, messages: [...page.messages, ...this._thread.messages], readSnapshot: this._thread.readSnapshot }
        : page
      if (!before) {
        this._needsRefresh = false
        this.clearStatusInternal()
      }
      this.emitChange()
      this.syncLive()
      if (!before) {
        await this.hooks.onThreadOpened?.()
      }
    })
    if (loaded && !before && this._thread?.conversation.id === id && this._thread.readSnapshot) {
      await this.acknowledge(id)
    }
    return loaded
  }

  retryRead(): Promise<boolean> | undefined {
    const current = this._thread
    if (!current) return undefined
    this.readChannel.cancel()
    return this.acknowledge(current.conversation.id)
  }

  reloadThread(): Promise<boolean> | undefined {
    const current = this._thread
    if (!current) return undefined
    const id = current.conversation.id
    this.threadChannel.cancel()
    this.readChannel.cancel()
    return this.runOnChannel(this.threadChannel, ctx => this.refreshThread(id, ctx))
      .then(async ok => {
        if (ok && this._thread?.conversation.id === id && this._thread.readSnapshot) {
          await this.acknowledge(id)
        }
        return ok
      })
  }

  sendNotice(): Promise<boolean> | undefined {
    const account = this._recipient.trim().toLowerCase()
    const subject = this._noticeSubject
    const body = this._noticeBody
    if (!this._noticesEnabled || !isNoticeRecipient(account) || !body.trim() || this.noticeChannel.pending || !this.scope.active) {
      return undefined
    }
    if (this.noticeAttempt?.account !== account || this.noticeAttempt.subject !== subject || this.noticeAttempt.body !== body) {
      this.noticeAttempt = { account, subject, body, eventId: this.idGenerator.newNoticeEventId() }
    }
    const eventId = this.noticeAttempt.eventId
    this._notice = ''
    this.emitChange()
    return this.runOnChannel(this.noticeChannel, async ctx => {
      await this.transport.adminSendNotice(account, subject, body, eventId, ctx.signal)
      if (!ctx.isCurrent()) return
      this.clearNoticeInternal()
      this._notice = 'admin.inbox.m40'
      this.emitChange()
      const page = await this.transport.adminInbox(this._filter, null, ctx.signal, this._sharedRead, this._order)
      if (!ctx.isCurrent()) return
      this.applyQueuePage(page, false)
    }, 'admin.inbox.m41')
  }

  sendReply(): Promise<boolean> | undefined {
    const current = this._thread
    if (!current || current.conversation.status === 2 || !current.repliesEnabled ||
        !this._reply.trim() || this.replyChannel.pending || !this.scope.active) {
      return undefined
    }
    const conversation = current.conversation.id
    const body = this._reply
    if (this.attempt?.conversation !== conversation || this.attempt.body !== body) {
      this.attempt = { conversation, body, key: this.idGenerator.randomUuid() }
    }
    const key = this.attempt.key
    this._notice = ''
    this.emitChange()
    return this.runOnChannel(this.replyChannel, async ctx => {
      const saved = await this.transport.adminReply(conversation, body, key, ctx.signal)
      if (!ctx.isCurrent()) return
      this.clearReplyInternal()
      this._notice = 'admin.inbox.m42'
      const active = this._thread?.conversation.id === conversation ? this._thread : undefined
      if (active) {
        const messages = active.messages.some(message => message.id === saved.id)
          ? active.messages
          : [...active.messages, { id: saved.id, sender: 1 as const, internal: false, at: saved.createdAt, body: saved.body }]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        // Preserve existing version across refresh so the status form never unmounts/remounts.
        this._thread = { ...active, messages }
        this.emitChange()
        if (active.version) {
          await this.refreshThreadAfterMutation(conversation, ctx)
        }
      } else {
        this.emitChange()
      }
    }, 'admin.inbox.m43').then(async ok => {
      if (ok && this._thread?.conversation.id === conversation && this._thread.readSnapshot) {
        await this.acknowledge(conversation)
      }
      return ok
    })
  }

  saveStatus(): Promise<boolean> | undefined {
    const current = this._thread
    const target = this._destination
    if (!current?.version || target === undefined ||
        !adminInboxStatusTransitions[current.conversation.status].includes(target) ||
        !this._reason.trim() || this._reason.trim().length > 256 ||
        this.statusChannel.pending || this.replyChannel.pending || !this.scope.active) {
      return undefined
    }
    const conversation = current.conversation.id
    const version = current.version
    const explanation = this._reason
    this._notice = ''
    this.emitChange()
    return this.runOnChannel(this.statusChannel, async ctx => {
      const saved = await this.transport.adminChangeStatus(conversation, version, target, explanation, ctx.signal)
      if (!ctx.isCurrent()) return
      const active = this._thread?.conversation.id === conversation ? this._thread : undefined
      const updated = { ...(active?.conversation ?? current.conversation), status: saved.current }
      this._rows = adminInboxStatusFilters.some(status => status === this._filter) &&
        this._filter !== adminInboxStatusFilters[saved.current]
        ? this._rows.filter(item => item.id !== conversation)
        : this._rows.map(item => item.id === conversation ? updated : item)
      this.clearStatusInternal()
      this._notice = saved.changed ? 'admin.inbox.m44' : 'admin.inbox.m45'
      if (active) {
        // Keep version populated while refreshing to prevent status-form layout jump.
        this._thread = { ...active, conversation: updated }
        this.emitChange()
        await this.refreshThreadAfterMutation(conversation, ctx)
      } else {
        this.emitChange()
      }
    }, 'admin.inbox.m46').then(async ok => {
      if (ok && this._thread?.conversation.id === conversation && this._thread.readSnapshot) {
        await this.acknowledge(conversation)
      }
      return ok
    })
  }

  private runOnChannel(
    channel: AdminOperationChannel,
    task: (context: AdminOperationContext) => Promise<void>,
    message: MessageKey = 'admin.inbox.m39',
    onBeforeError?: () => void,
  ): Promise<boolean> {
    return channel.run(task, {
      onStart: () => {
        this._failed = ''
      },
      onError: error => {
        if (!(error instanceof ApiError && error.details.startsWith('pow_'))) {
          this.hooks.onSessionLost?.(error)
        }
        onBeforeError?.()
        this._failed = message
        this.emitChange()
      },
    })
  }

  private anyPending(): boolean {
    return this.queueChannel.pending ||
      this.threadChannel.pending ||
      this.readChannel.pending ||
      this.replyChannel.pending ||
      this.statusChannel.pending ||
      this.noticeChannel.pending
  }

  private isLiveBlocked(target: bigint | AdminInboxLiveStatus): boolean {
    return typeof target === 'string'
      ? this.queueChannel.pending || this.noticeChannel.pending
      : this.threadChannel.pending || this.replyChannel.pending || this.statusChannel.pending
  }

  private applyQueuePage(page: AdminInboxPage, append = false): void {
    this._rows = append ? [...this._rows, ...page.rows] : page.rows
    this._next = page.next
    this._noticesEnabled = page.noticesEnabled
    this._sharedRead = page.sharedAvailable
    this._activityAvailable = page.activityAvailable
    this._queueLive = !append && page.liveEnabled
    this.emitChange()
    this.syncLive()
  }

  private acknowledge(id: bigint): Promise<boolean> {
    return this.readChannel.run(async ctx => {
      const seen = this._thread
      if (!ctx.isCurrent() || seen?.conversation.id !== id || !seen.readSnapshot) return
      this._unreadAckFailed = false
      this.emitChange()
      try {
        const unread = await this.transport.acknowledgeAdminInboxRead(id, seen.readSnapshot, ctx.signal)
        if (!ctx.isCurrent() || this._thread?.conversation.id !== id || this._thread?.readSnapshot !== seen.readSnapshot) return
        const latest = this._thread
        const updated = { ...latest.conversation, unread }
        this._thread = { ...latest, conversation: updated, readSnapshot: null }
        this._rows = this._filter === 'unread' && unread === 0
          ? this._rows.filter(item => item.id !== id)
          : this._rows.map(item => item.id === id ? { ...item, unread } : item)
        this.emitChange()
      } catch (error) {
        if (!ctx.isCurrent()) return
        this.hooks.onSessionLost?.(error)
        this._unreadAckFailed = true
        this.emitChange()
      }
    }, { onError: () => {} })
  }

  private applyLatestThread(latest: AdminInboxThread, keepReadSnapshot = false): boolean {
    const current = this._thread
    if (current?.conversation.id !== latest.conversation.id) return false
    const afterFocus = this.hooks.onBeforeApplyLatestThread?.(latest.conversation.id)
    const first = latest.messages[0]?.id
    // Keep earlier pages only when the newest authoritative page still joins them.
    const overlap = first === undefined ? -1 : current.messages.findIndex(message => message.id === first)
    this._thread = {
      ...latest,
      previous: overlap > 0 ? current.previous : latest.previous,
      messages: overlap > 0 ? [...current.messages.slice(0, overlap), ...latest.messages] : latest.messages,
      readSnapshot: keepReadSnapshot ? current.readSnapshot : latest.readSnapshot,
    }
    if (this._destination !== undefined && !adminInboxStatusTransitions[latest.conversation.status].includes(this._destination)) {
      this._destination = undefined
    }
    this._needsRefresh = false
    this.emitChange()
    this.syncLive()
    afterFocus?.()
    return true
  }

  private async refreshThread(id: bigint, ctx: AdminOperationContext): Promise<void> {
    if (this.activeLive?.target === id) {
      this.activeLive.dirty = false
    }
    const latest = await this.transport.adminInboxThread(id, null, ctx.signal, this._sharedRead)
    if (!ctx.isCurrent() || !this.applyLatestThread(latest)) return
    await this.hooks.onThreadRefreshed?.()
  }

  private async refreshThreadAfterMutation(id: bigint, ctx: AdminOperationContext): Promise<void> {
    try {
      await this.refreshThread(id, ctx)
    } catch (error) {
      if (ctx.isCurrent() && this._thread?.conversation.id === id) {
        this._thread = { ...this._thread, version: null }
        this._needsRefresh = true
      }
      throw error
    }
  }

  private resetKeepingCapabilitiesAndReload(): void {
    this.queueChannel.cancel()
    if (typeof this.activeLive?.target === 'string') {
      this.stopLive()
    }
    this._next = null
    this._queueLive = false
    this._failed = ''
    this.emitChange()
    if (this.scope.active) void this.loadQueue(null, { clearRowsOnError: true })
  }

  private stopLive(): void {
    this.liveGeneration++
    const current = this.activeLive
    if (!current) return
    this.activeLive = null
    if (current.retry !== undefined) {
      this.clock.clearTimeout(current.retry)
      current.retry = undefined
    }
    current.controller.abort()
  }

  private syncLive(): void {
    const target = this.liveScope()
    if (!this.scope.active || target === undefined) {
      this.stopLive()
      return
    }
    if (this.activeLive && this.activeLive.target === target && !this.activeLive.controller.signal.aborted) {
      return
    }

    this.stopLive()
    const generation = ++this.liveGeneration
    const controller = new AbortController()
    const derived = this.scope.deriveSignal([controller.signal])
    const isLiveCurrent = () => generation === this.liveGeneration && derived.isCurrent()

    const subscription: ActiveLiveSubscription = {
      target,
      generation,
      controller,
      retry: undefined,
      dirty: false,
      refreshing: false,
      delay: 1_000,
      refresh: async () => {
        if (!isLiveCurrent() || this.liveScope() !== target || !subscription.dirty ||
            subscription.refreshing || this.isLiveBlocked(target) || subscription.retry !== undefined) {
          return
        }
        subscription.dirty = false
        subscription.refreshing = true
        try {
          if (typeof target === 'string') {
            const previous = this._rows
            const page = await this.transport.adminInbox(target, null, derived.signal, this._sharedRead)
            if (!isLiveCurrent() || this.liveScope() !== target) return
            if (this.isLiveBlocked(target) || previous !== this._rows) {
              subscription.dirty = true
            } else {
              const afterFocus = this.hooks.onBeforeApplyLiveQueuePage?.()
              this.applyQueuePage(page, false)
              afterFocus?.()
            }
          } else {
            const previous = this._thread
            const snapshot = await this.transport.adminInboxThread(target, null, derived.signal, this._sharedRead)
            if (!isLiveCurrent() || this.liveScope() !== target) return
            if (this.isLiveBlocked(target) || previous !== this._thread) {
              subscription.dirty = true
            } else {
              this.applyLatestThread(snapshot, this._unreadAckFailed)
            }
          }
          subscription.delay = 1_000
        } catch (error) {
          if (!isLiveCurrent()) return
          if (error instanceof ApiError && error.status === 401) {
            this.hooks.onSessionLost?.(error)
          } else if (!(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
            subscription.dirty = true
            const waitMs = subscription.delay
            subscription.delay = Math.min(subscription.delay * 2, 16_000)
            subscription.retry = this.clock.setTimeout(() => {
              if (!isLiveCurrent()) return
              subscription.retry = undefined
              void subscription.refresh()
            }, waitMs)
          }
        } finally {
          subscription.refreshing = false
          if (subscription.dirty && isLiveCurrent() && !this.isLiveBlocked(target) && subscription.retry === undefined) {
            void subscription.refresh()
          }
        }
      },
    }

    this.activeLive = subscription
    this.transport.watchAdminInboxWake(
      target,
      derived.signal,
      () => {
        if (!isLiveCurrent()) return
        subscription.dirty = true
        void subscription.refresh()
      },
      () => {
        if (!isLiveCurrent()) return
        this.hooks.onSessionLost?.(new ApiError('Administrator session expired.', 401))
      },
    )
  }

  private clearReplyInternal(): void {
    this._reply = ''
    this._notice = ''
    this.attempt = undefined
  }

  private clearStatusInternal(): void {
    this._destination = undefined
    this._reason = ''
    this._needsRefresh = false
  }

  private clearNoticeInternal(): void {
    this._composeNotice = false
    this._recipient = ''
    this._noticeSubject = ''
    this._noticeBody = ''
    this.noticeAttempt = undefined
  }

  private resetStateInternal(): void {
    this.stopLive()
    this._rows = []
    this._thread = undefined
    this._next = null
    this._failed = ''
    this.clearReplyInternal()
    this.clearStatusInternal()
    this.clearNoticeInternal()
    this._noticesEnabled = false
    this._sharedRead = false
    this._activityAvailable = false
    this._queueLive = false
    this._unreadAckFailed = false
    this.hooks.onReset?.()
  }

  private buildSnapshot(): AdminInboxState {
    return {
      rows: this._rows,
      thread: this._thread,
      next: this._next,
      filter: this._filter,
      order: this._order,
      expanded: this._expanded,
      pending: this.anyPending(),
      queuePending: this.queueChannel.pending,
      threadPending: this.threadChannel.pending,
      readPending: this.readChannel.pending,
      replyPending: this.replyChannel.pending,
      statusPending: this.statusChannel.pending,
      noticePending: this.noticeChannel.pending,
      failed: this._failed,
      reply: this._reply,
      notice: this._notice,
      destination: this._destination,
      reason: this._reason,
      needsRefresh: this._needsRefresh,
      sharedRead: this._sharedRead,
      activityAvailable: this._activityAvailable,
      queueLive: this._queueLive,
      unreadAckFailed: this._unreadAckFailed,
      noticesEnabled: this._noticesEnabled,
      composeNotice: this._composeNotice,
      recipient: this._recipient,
      noticeSubject: this._noticeSubject,
      noticeBody: this._noticeBody,
    }
  }

  private emitChange(): void {
    this._snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}
