export type TimerHandle = unknown
export interface AdminClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const MAX_TIMEOUT_MS = 2_147_483_647
export const systemAdminClock: AdminClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface DerivedAdminSignal {
  readonly signal: AbortSignal; readonly sessionEpoch: number; readonly scopeEpoch: number; isCurrent(): boolean
}
export interface AdminOperationContext extends DerivedAdminSignal { readonly runId: number }
export interface AdminOperationHandlers { onStart?: () => void; onError: (error: unknown, context: AdminOperationContext) => void }
export interface AdminSessionScopeOptions { onReset?: () => void; onSessionAborted?: () => void }

/** Coordinates component lifetime, session signal switching/invalidation, cancellation, and epoch guards for admin views. */
export class AdminSessionScope {
  private readonly lifetime = new AbortController()
  private scopeController = new AbortController()
  private currentSessionSignal: AbortSignal | null = null
  private detachSessionListener: (() => void) | null = null
  private _sessionEpoch = 0
  private _scopeEpoch = 0
  private _disposed = false
  private readonly channels = new Set<AdminOperationChannel>()
  private readonly onResetCallback?: () => void
  private readonly onSessionAbortedCallback?: () => void

  constructor(options: AdminSessionScopeOptions = {}) {
    this.onResetCallback = options.onReset
    this.onSessionAbortedCallback = options.onSessionAborted
  }

  get disposed(): boolean { return this._disposed }
  get sessionEpoch(): number { return this._sessionEpoch }
  get scopeEpoch(): number { return this._scopeEpoch }
  get sessionAborted(): boolean { return this._disposed || (this.currentSessionSignal?.aborted ?? true) }
  get active(): boolean { return !this.sessionAborted }
  isSessionCurrent(sessionEpoch: number): boolean { return !this._disposed && this.active && this._sessionEpoch === sessionEpoch }
  isScopeCurrent(sessionEpoch: number, scopeEpoch: number): boolean { return this.isSessionCurrent(sessionEpoch) && this._scopeEpoch === scopeEpoch }
  registerChannel(channel: AdminOperationChannel): void { this.channels.add(channel) }

  bindSession(signal: AbortSignal): Readonly<{ active: boolean; sessionEpoch: number }> {
    if (this._disposed) return { active: false, sessionEpoch: this._sessionEpoch }
    this.detachSessionListener?.()
    this.detachSessionListener = null
    this.currentSessionSignal = signal
    const boundEpoch = this.advanceSession(signal.aborted)
    if (signal.aborted) return { active: false, sessionEpoch: boundEpoch }
    const handleAbort = () => {
      if (this._disposed || this._sessionEpoch !== boundEpoch) return
      this.detachSessionListener = null
      this.advanceSession(true)
      this.onSessionAbortedCallback?.()
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    this.detachSessionListener = () => signal.removeEventListener('abort', handleAbort)
    return { active: true, sessionEpoch: boundEpoch }
  }

  private advanceSession(abortScope: boolean): number {
    this._sessionEpoch++
    this._scopeEpoch++
    this.rotateScopeController(abortScope)
    this.resetChannels()
    this.onResetCallback?.()
    return this._sessionEpoch
  }

  cancelOperations(): number {
    if (this._disposed) return this._scopeEpoch
    this._scopeEpoch++
    this.rotateScopeController(this.sessionAborted)
    this.resetChannels()
    return this._scopeEpoch
  }

  deriveSignal(extraSignals: readonly AbortSignal[] = []): DerivedAdminSignal {
    const sessionEpoch = this._sessionEpoch, scopeEpoch = this._scopeEpoch
    const sources: AbortSignal[] = [this.lifetime.signal, this.scopeController.signal]
    if (this.currentSessionSignal) sources.push(this.currentSessionSignal)
    sources.push(...extraSignals)
    const signal = AbortSignal.any(sources)
    return { signal, sessionEpoch, scopeEpoch, isCurrent: () => !signal.aborted && this.isScopeCurrent(sessionEpoch, scopeEpoch) }
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this.detachSessionListener?.()
    this.detachSessionListener = null
    this.currentSessionSignal = null
    this._sessionEpoch++
    this._scopeEpoch++
    this.scopeController.abort()
    this.lifetime.abort()
    this.resetChannels()
    this.onResetCallback?.()
  }

  private rotateScopeController(abortNext: boolean): void {
    this.scopeController.abort()
    this.scopeController = new AbortController()
    if (abortNext) this.scopeController.abort()
  }

  private resetChannels(): void { for (const channel of this.channels) channel.resetInternal() }
}

/** Single non-reentrant asynchronous operation channel bound to an AdminSessionScope. */
export class AdminOperationChannel {
  private readonly scope: AdminSessionScope
  private readonly onPendingChange?: (pending: boolean) => void
  private channelController = new AbortController()
  private _pending = false
  private activeRunId = 0
  private nextRunId = 0

  constructor(scope: AdminSessionScope, onPendingChange?: (pending: boolean) => void) {
    this.scope = scope
    this.onPendingChange = onPendingChange
    this.scope.registerChannel(this)
  }

  get pending(): boolean { return this._pending }
  cancel(): void { this.resetInternal() }

  resetInternal(): void {
    this.activeRunId = 0
    this.channelController.abort()
    this.channelController = new AbortController()
    if (this._pending) { this._pending = false; this.onPendingChange?.(false) }
  }

  async run(task: (context: AdminOperationContext) => Promise<void>, handlers: AdminOperationHandlers): Promise<boolean> {
    if (this._pending || !this.scope.active) return false
    const runId = ++this.nextRunId
    this.activeRunId = runId
    const derived = this.scope.deriveSignal([this.channelController.signal])
    const context: AdminOperationContext = { ...derived, runId, isCurrent: () => derived.isCurrent() && this.activeRunId === runId }
    this._pending = true
    handlers.onStart?.()
    this.onPendingChange?.(true)
    try {
      await task(context)
      return context.isCurrent()
    } catch (error) {
      if (context.isCurrent()) handlers.onError(error, context)
      return false
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = 0
        if (this._pending) { this._pending = false; this.onPendingChange?.(false) }
      }
    }
  }
}
