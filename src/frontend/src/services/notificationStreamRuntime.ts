import type { PowParams, NotificationStreamCursor, NotificationStreamEventV2, NotificationStreamFailureCode } from '@/services/notificationStreamTypes'
import { NotificationStreamEventType, NotificationStreamFailureCodes } from '@/services/notificationStreamTypes'
import { decodeNotificationApiErrorFrame, decodeNotificationFrame } from '@/adapters/binary/notificationAdapter'
import { encodeNotificationStreamPowProof } from '@/services/powProofCodec'
import type { SecurityChallengeProofLease } from '@/security/challenge-client'
import { securityChallengeKindWireName } from '@/security/challenge-kind-wire'
import { resolveNotificationStreamCloseRecovery } from '@/services/notificationStreamRestartPolicy'
import { runPrivateRequest } from '@/services/privateRequestRuntime'

const RECENT_EVENT_WINDOW = 512
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 30000
const VALID_EVENT_TYPES = new Set<number>([
  NotificationStreamEventType.NoticeReceived,
  NotificationStreamEventType.GlobalNoticePublished,
  NotificationStreamEventType.UnreadCountUpdated,
  NotificationStreamEventType.AccountStatusChanged,
  NotificationStreamEventType.CommentAdded,
  NotificationStreamEventType.CommentRemoved,
  NotificationStreamEventType.MessageReceived,
  NotificationStreamEventType.ArticleChanged,
  NotificationStreamEventType.MessageRevoked,
  NotificationStreamEventType.CacheControl,
  NotificationStreamEventType.SearchIndexUpdated,
  NotificationStreamEventType.InboxConversationUpsert,
  NotificationStreamEventType.InboxMessageAppend,
  NotificationStreamEventType.InboxReadUpdated,
  NotificationStreamEventType.InboxConversationStatusChanged,
  NotificationStreamEventType.SessionRevoked
])

type RuntimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
type NotificationStreamMode = 'auth' | 'guest'
type NotificationStreamEndpointProtocol = 'http' | 'websocket'

type RuntimeCallbacks = {
  onEvent?: (event: NotificationStreamEventV2) => void
  onCursorChange?: (cursor: NotificationStreamCursor) => void
  onStatusChange?: (status: RuntimeStatus, retryCount: number) => void
  onDuplicateEvent?: (eventId: number) => void
  onProtocolError?: (reason: string) => void
  onHandshakeFailure?: (code: NotificationStreamFailureCode) => void
  onReconnectSuccess?: (replayMissed: boolean) => void
}

export type NotificationStreamRuntimeTelemetrySnapshot = Readonly<{
  preflightCount: number
  wsReconnectCount: number
  cursorSnapshotBytes: number
  eventProcessMs: number
}>

export function resolveNotificationStreamEndpointUrl(
  path: string,
  protocol: NotificationStreamEndpointProtocol,
  configuredBaseUrl: string | undefined = import.meta.env.VITE_API_BASE_URL,
  currentOrigin: string = window.location.origin
): URL {
  const configured = configuredBaseUrl?.trim()
  const baseUrl = configured && configured.length > 0 ? configured : currentOrigin
  let url: URL
  try {
    url = new URL(path, baseUrl)
  } catch {
    url = new URL(path, currentOrigin)
  }

  if (protocol === 'websocket') {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  }

  return url
}

export class NotificationStreamRuntime {
  private socket: WebSocket | null = null
  private currentMode: NotificationStreamMode = 'guest'
  private currentPow: PowParams | undefined
  private currentChallengeLease: SecurityChallengeProofLease | undefined
  private challengeRequiredForConnection = false
  private cursor: NotificationStreamCursor = { lastEventId: 0, recentEventIds: [] }
  private recentEventIds = new Set<number>()
  private readonly recentEventRing = new Array<number>(RECENT_EVENT_WINDOW)
  private recentEventRingStart = 0
  private recentEventRingLength = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private cursorChangeTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private isReconnecting = false
  private isConnectedFlag = false
  private hasSuccessfulConnection = false
  private requirePreflightOnNextConnect = false
  private replayMissedOnReconnect = false
  private connectGeneration = 0
  private telemetry = {
    preflightCount: 0,
    wsReconnectCount: 0,
    cursorSnapshotBytes: 0,
    eventProcessMs: 0
  }

  public onEvent?: RuntimeCallbacks['onEvent']
  public onCursorChange?: RuntimeCallbacks['onCursorChange']
  public onStatusChange?: RuntimeCallbacks['onStatusChange']
  public onDuplicateEvent?: RuntimeCallbacks['onDuplicateEvent']
  public onProtocolError?: RuntimeCallbacks['onProtocolError']
  public onHandshakeFailure?: RuntimeCallbacks['onHandshakeFailure']
  public onReconnectSuccess?: RuntimeCallbacks['onReconnectSuccess']

  public async start(
    powParams?: PowParams,
    cursor?: NotificationStreamCursor,
    mode: NotificationStreamMode = powParams ? 'guest' : 'auth',
    challengeProof?: SecurityChallengeProofLease | null
  ): Promise<void> {
    this.releaseCurrentChallengeLease()
    this.currentMode = mode
    this.currentPow = powParams
    this.currentChallengeLease = challengeProof ?? undefined
    this.challengeRequiredForConnection = Boolean(challengeProof)
    this.connectGeneration += 1
    this.retryCount = 0
    this.isReconnecting = false
    this.replayMissedOnReconnect = false
    this.clearReconnectTimer()

    if (cursor) {
      this.restoreCursor(cursor)
    }

    await this.connect(false, this.connectGeneration)
  }

  public async stop(clearCursor = false): Promise<void> {
    this.connectGeneration += 1
    this.releaseCurrentChallengeLease()
    this.challengeRequiredForConnection = false
    this.clearReconnectTimer()
    this.isReconnecting = false
    this.isConnectedFlag = false
    this.replayMissedOnReconnect = false

    if (this.socket) {
      this.socket.close(1000, 'stopped')
      this.socket = null
    }

    if (clearCursor) {
      this.resetCursor()
    }

    this.onStatusChange?.('stopped', this.retryCount)
  }

  public isConnected(): boolean {
    return this.isConnectedFlag
  }

  public snapshotCursor(): NotificationStreamCursor {
    const recentEventIds = this.copyRecentEventIds()
    this.telemetry.cursorSnapshotBytes += recentEventIds.length * 8
    return {
      lastEventId: this.cursor.lastEventId,
      recentEventIds
    }
  }

  public snapshotTelemetry(): NotificationStreamRuntimeTelemetrySnapshot {
    return { ...this.telemetry }
  }

  private async connect(isReconnect: boolean, generation: number = this.connectGeneration): Promise<void> {
    if (generation !== this.connectGeneration) {
      return
    }

    if (this.socket) {
      this.socket.close(1000, 'reconnect')
    }

    this.onStatusChange?.(isReconnect ? 'reconnecting' : 'connecting', this.retryCount)

    const requestUrl = resolveNotificationStreamEndpointUrl('/api/notifications/stream', 'websocket')
    if (this.cursor.lastEventId > 0) {
      requestUrl.searchParams.set('cursor', String(this.cursor.lastEventId))
    }

    if (this.currentPow) {
      requestUrl.searchParams.set('pow', encodeNotificationStreamPowProof(this.currentPow))
    }
    if (this.shouldRunHandshakePreflight(isReconnect)) {
      const preflightFailure = await this.runHandshakePreflight(requestUrl)
      if (generation !== this.connectGeneration) {
        return
      }
      if (preflightFailure) {
        this.requirePreflightOnNextConnect = true
        this.isConnectedFlag = false
        this.isReconnecting = false
        this.onStatusChange?.('idle', this.retryCount)
        this.onHandshakeFailure?.(preflightFailure)
        return
      }

      this.requirePreflightOnNextConnect = false
    }

    if (generation !== this.connectGeneration) {
      return
    }

    await this.openWebSocket(requestUrl, isReconnect)
  }

  private shouldRunHandshakePreflight(isReconnect: boolean): boolean {
    if (this.currentMode === 'guest' || this.currentPow) {
      return true
    }

    if (this.requirePreflightOnNextConnect) {
      return true
    }

    if (this.challengeRequiredForConnection) {
      return true
    }

    return !(isReconnect && this.hasSuccessfulConnection)
  }

  private async runHandshakePreflight(webSocketUrl: URL): Promise<NotificationStreamFailureCode | null> {
    this.telemetry.preflightCount += 1
    const preflightUrl = resolveNotificationStreamEndpointUrl('/api/notifications/stream/preflight', 'http')
    for (const [key, value] of webSocketUrl.searchParams.entries()) {
      preflightUrl.searchParams.set(key, value)
    }

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/octet-stream',
        'X-Fsus-Notification-Stream-Protocol': 'fsus-aeds.v2'
      }
      const challengeLease = this.currentChallengeLease
      if (challengeLease) {
        headers['X-Fsus-Challenge-Proof'] = challengeLease.proof.proofToken
        headers['X-Fsus-Challenge-Id'] = challengeLease.proof.challengeId
        headers['X-Fsus-Challenge-Kind'] = securityChallengeKindWireName(challengeLease.proof.kind)
        if (!challengeLease.markInFlight()) {
          this.currentChallengeLease = undefined
          return NotificationStreamFailureCodes.RiskChallengeRequired
        }
      }

      const fetchPreflight = (signal?: AbortSignal) => fetch(preflightUrl, {
        credentials: 'include',
        headers,
        signal
      })
      const response = this.currentMode === 'auth'
        ? await runPrivateRequest('account', undefined, fetchPreflight)
        : await fetchPreflight()
      if (response.ok) {
        this.settleCurrentChallengeLease('accepted')
        return null
      }

      const errorCode = response.headers.get('X-Fsus-Notification-Stream-Error-Code')
      this.settleCurrentChallengeLease(proofSettlementForFailure(errorCode))
      const buffer = await response.arrayBuffer().catch(() => null)
      if (buffer) {
        decodeNotificationApiErrorFrame(buffer)
      }
      return normalizeNotificationStreamHandshakeFailure(errorCode ?? undefined, response.status, this.currentMode)
    } catch {
      this.settleCurrentChallengeLease('unknown_network')
      return NotificationStreamFailureCodes.NetworkError
    }
  }

  private async openWebSocket(requestUrl: URL, isReconnect: boolean): Promise<void> {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(requestUrl, 'fsus-aeds.v2')
      this.socket = socket
      socket.binaryType = 'arraybuffer'
      let opened = false

      socket.onopen = () => {
        if (this.socket !== socket) return
        opened = true
        this.isConnectedFlag = true
        this.hasSuccessfulConnection = true
        this.onStatusChange?.('connected', this.retryCount)

        if (isReconnect) {
          this.telemetry.wsReconnectCount += 1
          this.retryCount = 0
          this.isReconnecting = false
          const replayMissed = this.replayMissedOnReconnect
          this.replayMissedOnReconnect = false
          this.onReconnectSuccess?.(replayMissed)
        }

        resolve()
      }

      socket.onmessage = (message) => {
        if (this.socket !== socket) return
        if (!(message.data instanceof ArrayBuffer)) {
          this.handleProtocolMismatch('notification_message_not_binary')
          socket.close(1002, 'binary_required')
          return
        }

        this.processNotificationFrame(message.data)
      }

      socket.onerror = () => {
        if (!opened) {
          if (this.socket === socket) {
            this.socket = null
          }
          this.isConnectedFlag = false
          this.isReconnecting = false
          this.requirePreflightOnNextConnect = true
          this.onStatusChange?.('idle', this.retryCount)
          this.onHandshakeFailure?.(this.currentMode === 'auth' ? NotificationStreamFailureCodes.AuthFailed : NotificationStreamFailureCodes.PowFailed)
          resolve()
        }
      }

      socket.onclose = (event) => {
        if (this.socket !== socket) return
        this.socket = null
        this.isConnectedFlag = false
        if (!opened) {
          this.isReconnecting = false
          this.requirePreflightOnNextConnect = true
          this.onStatusChange?.('idle', this.retryCount)
          this.onHandshakeFailure?.(this.currentMode === 'auth' ? NotificationStreamFailureCodes.AuthFailed : NotificationStreamFailureCodes.PowFailed)
          resolve()
          return
        }

        if (event.code !== 1000) {
          const recovery = resolveNotificationStreamCloseRecovery(event.code, event.reason)
          if (recovery) {
            if (!recovery.preserveCursor) {
              this.resetCursor()
            }
            this.replayMissedOnReconnect ||= recovery.requireFullResync
            this.scheduleReconnect(NotificationStreamFailureCodes.NetworkError, recovery.reconnectDelayMs)
            return
          }

          this.scheduleReconnect(NotificationStreamFailureCodes.NetworkError)
        }
      }
    })
  }

  private processNotificationFrame(buffer: ArrayBuffer): void {
    const startedAt = performance.now()
    let event: NotificationStreamEventV2
    try {
      const decoded = decodeNotificationFrame(buffer)
      if (decoded.kind === 'heartbeat') {
        return
      }

      event = decoded.event
    } catch {
      this.handleProtocolMismatch('notification_frame_invalid')
      return
    }

    if (!this.isValidEvent(event)) {
      this.handleProtocolMismatch('invalid_envelope')
      return
    }

    const cursorState = this.acceptEventId(event.id)
    if (cursorState === 'duplicate' || cursorState === 'out_of_order') {
      this.onDuplicateEvent?.(event.id)
      return
    }

    this.onEvent?.(event)
    this.telemetry.eventProcessMs += Math.max(0, performance.now() - startedAt)
  }

  private isValidEvent(event: NotificationStreamEventV2): boolean {
    if (!Number.isFinite(event.id) || event.id <= 0) {
      return false
    }

    if (!VALID_EVENT_TYPES.has(Number(event.type))) {
      return false
    }

    return Number.isFinite(event.ts) && event.ts > 0 && Object.prototype.hasOwnProperty.call(event, 'payload')
  }

  private acceptEventId(eventId: number): 'accepted' | 'duplicate' | 'out_of_order' {
    if (this.recentEventIds.has(eventId)) {
      return 'duplicate'
    }

    if (eventId < this.cursor.lastEventId) {
      return 'out_of_order'
    }

    this.cursor.lastEventId = eventId
    this.appendRecentEventId(eventId)
    this.scheduleCursorChange()
    return 'accepted'
  }

  private appendRecentEventId(eventId: number): void {
    if (this.recentEventRingLength < RECENT_EVENT_WINDOW) {
      const writeIndex = (this.recentEventRingStart + this.recentEventRingLength) % RECENT_EVENT_WINDOW
      this.recentEventRing[writeIndex] = eventId
      this.recentEventRingLength += 1
      this.recentEventIds.add(eventId)
      return
    }

    const dropped = this.recentEventRing[this.recentEventRingStart]
    if (dropped !== undefined) {
      this.recentEventIds.delete(dropped)
    }

    this.recentEventRing[this.recentEventRingStart] = eventId
    this.recentEventRingStart = (this.recentEventRingStart + 1) % RECENT_EVENT_WINDOW
    this.recentEventIds.add(eventId)
  }

  private scheduleCursorChange(): void {
    if (!this.onCursorChange || this.cursorChangeTimer !== null) {
      return
    }

    this.cursorChangeTimer = setTimeout(() => {
      this.cursorChangeTimer = null
      this.onCursorChange?.(this.snapshotCursor())
    }, 16)
  }

  private emitCursorChangeNow(): void {
    if (this.cursorChangeTimer !== null) {
      clearTimeout(this.cursorChangeTimer)
      this.cursorChangeTimer = null
    }

    this.onCursorChange?.(this.snapshotCursor())
  }

  private handleProtocolMismatch(reason: string): void {
    this.onProtocolError?.(reason)
    this.scheduleReconnect(NotificationStreamFailureCodes.ProtocolMismatch)
  }

  private scheduleReconnect(reason: NotificationStreamFailureCode, delayOverrideMs?: number): void {
    if (reason === NotificationStreamFailureCodes.AuthFailed || reason === NotificationStreamFailureCodes.PowFailed) {
      return
    }

    this.clearReconnectTimer()
    this.isConnectedFlag = false
    this.isReconnecting = true
    this.retryCount += 1
    this.onStatusChange?.('reconnecting', this.retryCount)

    const delay = delayOverrideMs
      ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, this.retryCount - 1), RETRY_MAX_DELAY_MS)
    const jitter = delayOverrideMs === undefined ? Math.floor(Math.random() * 250) : 0

    this.reconnectTimer = setTimeout(() => {
      if (!this.isReconnecting) {
        return
      }

      void this.connect(true, this.connectGeneration)
    }, delay + jitter)
  }

  private restoreCursor(cursor: NotificationStreamCursor): void {
    const recentEventIds = [...cursor.recentEventIds].slice(-RECENT_EVENT_WINDOW)
    this.cursor = {
      lastEventId: cursor.lastEventId || 0,
      recentEventIds: []
    }

    this.rebuildRecentEventRing(recentEventIds)
    this.emitCursorChangeNow()
  }

  private resetCursor(): void {
    this.cursor = { lastEventId: 0, recentEventIds: [] }
    this.rebuildRecentEventRing([])
    this.emitCursorChangeNow()
  }

  private copyRecentEventIds(): number[] {
    const ids: number[] = []
    for (let offset = 0; offset < this.recentEventRingLength; offset += 1) {
      const value = this.recentEventRing[(this.recentEventRingStart + offset) % RECENT_EVENT_WINDOW]
      if (value !== undefined) {
        ids.push(value)
      }
    }

    return ids
  }

  private rebuildRecentEventRing(ids: number[]): void {
    this.recentEventIds.clear()
    this.recentEventRingStart = 0
    this.recentEventRingLength = 0
    for (const id of ids) {
      this.appendRecentEventId(id)
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.cursorChangeTimer !== null) {
      clearTimeout(this.cursorChangeTimer)
      this.cursorChangeTimer = null
    }
  }

  private releaseCurrentChallengeLease(): void {
    this.currentChallengeLease?.settle('before_send_cancelled')
    this.currentChallengeLease = undefined
  }

  private settleCurrentChallengeLease(outcome: Parameters<SecurityChallengeProofLease['settle']>[0]): void {
    this.currentChallengeLease?.settle(outcome)
    this.currentChallengeLease = undefined
  }

}

function proofSettlementForFailure(errorCode: string | null): Parameters<SecurityChallengeProofLease['settle']>[0] {
  switch (errorCode) {
    case 'risk_challenge_expired':
      return 'expired'
    case 'risk_challenge_replayed':
      return 'replayed'
    case 'risk_challenge_binding_mismatch':
      return 'binding_mismatch'
    case 'risk_challenge_revoked':
      return 'revoked'
    default:
      return 'rejected'
  }
}

export const notificationStreamRuntime = new NotificationStreamRuntime()

export function normalizeNotificationStreamHandshakeFailure(
  errorCode: string | undefined,
  status: number,
  mode: 'auth' | 'guest'
): NotificationStreamFailureCode {
  switch (errorCode) {
    case NotificationStreamFailureCodes.AuthFailed:
    case NotificationStreamFailureCodes.PowFailed:
    case NotificationStreamFailureCodes.ProtocolMismatch:
    case NotificationStreamFailureCodes.AccountBlocked:
    case NotificationStreamFailureCodes.AccountDeleted:
    case NotificationStreamFailureCodes.WebSocketRequired:
    case NotificationStreamFailureCodes.RiskChallengeRequired:
    case NotificationStreamFailureCodes.RiskChallengeRejected:
    case NotificationStreamFailureCodes.RiskChallengeExpired:
    case NotificationStreamFailureCodes.RiskChallengeReplayed:
    case NotificationStreamFailureCodes.RiskChallengeBindingMismatch:
    case NotificationStreamFailureCodes.RiskChallengeRevoked:
    case NotificationStreamFailureCodes.RiskChallengeKindMismatch:
    case NotificationStreamFailureCodes.RiskControlBlocked:
    case NotificationStreamFailureCodes.RiskControlThrottled:
      return errorCode
    default:
      if (status === 401) {
        return mode === 'auth' ? NotificationStreamFailureCodes.AuthFailed : NotificationStreamFailureCodes.PowFailed
      }
      if (status === 409) {
        return NotificationStreamFailureCodes.ProtocolMismatch
      }
      return status >= 500 ? NotificationStreamFailureCodes.ServerError : NotificationStreamFailureCodes.NetworkError
  }
}
