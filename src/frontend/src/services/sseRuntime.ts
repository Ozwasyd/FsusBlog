import type { PowParams, SseDeliveryCursor, SseEventV2, SseFailureCode } from '@/services/sseTypes'
import { SseEventType, SseFailureCodes } from '@/services/sseTypes'
import { decodeNotificationFrame } from '@/adapters/binary/notificationAdapter'
import { encodeSsePowProof } from '@/services/powProofCodec'

const RECENT_EVENT_WINDOW = 512
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 30000
const VALID_EVENT_TYPES = new Set<number>([
  SseEventType.NoticeReceived,
  SseEventType.GlobalNoticePublished,
  SseEventType.UnreadCountUpdated,
  SseEventType.UserStatusChanged,
  SseEventType.CommentAdded,
  SseEventType.CommentRemoved,
  SseEventType.MessageReceived,
  SseEventType.ArticleChanged,
  SseEventType.MessageRevoked,
  SseEventType.CacheControl,
  SseEventType.SearchIndexUpdated,
  SseEventType.InboxConversationUpsert,
  SseEventType.InboxMessageAppend,
  SseEventType.InboxReadUpdated,
  SseEventType.InboxConversationClosed
])

type RuntimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
type SseEndpointProtocol = 'http' | 'websocket'

type RuntimeCallbacks = {
  onEvent?: (event: SseEventV2) => void
  onCursorChange?: (cursor: SseDeliveryCursor) => void
  onStatusChange?: (status: RuntimeStatus, retryCount: number) => void
  onDuplicateEvent?: (eventId: number) => void
  onProtocolError?: (reason: string) => void
  onHandshakeFailure?: (code: SseFailureCode) => void
  onReconnectSuccess?: (replayMissed: boolean) => void
}

export function resolveSseEndpointUrl(
  path: string,
  protocol: SseEndpointProtocol,
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

class SseRuntime {
  private socket: WebSocket | null = null
  private currentMode: 'auth' | 'guest' = 'guest'
  private currentPow: PowParams | undefined
  private cursor: SseDeliveryCursor = { lastEventId: 0, recentEventIds: [] }
  private recentEventIds = new Set<number>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private isReconnecting = false
  private isConnectedFlag = false

  public onEvent?: RuntimeCallbacks['onEvent']
  public onCursorChange?: RuntimeCallbacks['onCursorChange']
  public onStatusChange?: RuntimeCallbacks['onStatusChange']
  public onDuplicateEvent?: RuntimeCallbacks['onDuplicateEvent']
  public onProtocolError?: RuntimeCallbacks['onProtocolError']
  public onHandshakeFailure?: RuntimeCallbacks['onHandshakeFailure']
  public onReconnectSuccess?: RuntimeCallbacks['onReconnectSuccess']

  public async start(powParams?: PowParams, cursor?: SseDeliveryCursor): Promise<void> {
    this.currentMode = powParams ? 'guest' : 'auth'
    this.currentPow = powParams
    this.retryCount = 0
    this.isReconnecting = false
    this.clearReconnectTimer()

    if (cursor) {
      this.restoreCursor(cursor)
    }

    await this.connect(false)
  }

  public async stop(clearCursor = false): Promise<void> {
    this.clearReconnectTimer()
    this.isReconnecting = false
    this.isConnectedFlag = false

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

  public snapshotCursor(): SseDeliveryCursor {
    return {
      lastEventId: this.cursor.lastEventId,
      recentEventIds: [...this.cursor.recentEventIds]
    }
  }

  private async connect(isReconnect: boolean): Promise<void> {
    if (this.socket) {
      this.socket.close(1000, 'reconnect')
    }

    this.onStatusChange?.(isReconnect ? 'reconnecting' : 'connecting', this.retryCount)

    const requestUrl = resolveSseEndpointUrl('/api/notifications/stream', 'websocket')
    if (this.cursor.lastEventId > 0) {
      requestUrl.searchParams.set('cursor', String(this.cursor.lastEventId))
    }

    if (this.currentPow) {
      requestUrl.searchParams.set('pow', encodeSsePowProof(this.currentPow))
    }

    const preflightFailure = await this.runHandshakePreflight(requestUrl)
    if (preflightFailure) {
      this.isConnectedFlag = false
      this.isReconnecting = false
      this.onStatusChange?.('idle', this.retryCount)
      this.onHandshakeFailure?.(preflightFailure)
      return
    }

    await this.openWebSocket(requestUrl, isReconnect)
  }

  private async runHandshakePreflight(webSocketUrl: URL): Promise<SseFailureCode | null> {
    const preflightUrl = resolveSseEndpointUrl('/api/notifications/stream/preflight', 'http')
    for (const [key, value] of webSocketUrl.searchParams.entries()) {
      preflightUrl.searchParams.set(key, value)
    }

    try {
      const response = await fetch(preflightUrl, {
        credentials: 'include',
        headers: {
          'X-Fsus-Sse-Protocol': 'fsus-aeds.v2'
        }
      })
      if (response.ok) {
        return null
      }

      const payload = await response.json().catch(() => null) as { errorCode?: string } | null
      return normalizeHandshakeFailure(payload?.errorCode, response.status, this.currentMode)
    } catch {
      return SseFailureCodes.NetworkError
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
        this.onStatusChange?.('connected', this.retryCount)

        if (isReconnect) {
          this.retryCount = 0
          this.isReconnecting = false
          this.onReconnectSuccess?.(false)
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
          this.onStatusChange?.('idle', this.retryCount)
          this.onHandshakeFailure?.(this.currentMode === 'auth' ? SseFailureCodes.AuthFailed : SseFailureCodes.PowFailed)
          resolve()
        }
      }

      socket.onclose = (event) => {
        if (this.socket !== socket) return
        this.socket = null
        this.isConnectedFlag = false
        if (!opened) {
          this.isReconnecting = false
          this.onStatusChange?.('idle', this.retryCount)
          this.onHandshakeFailure?.(this.currentMode === 'auth' ? SseFailureCodes.AuthFailed : SseFailureCodes.PowFailed)
          resolve()
          return
        }

        if (event.code !== 1000) {
          this.scheduleReconnect(SseFailureCodes.NetworkError)
        }
      }
    })
  }

  private processNotificationFrame(buffer: ArrayBuffer): void {
    let event: SseEventV2
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
  }

  private isValidEvent(event: SseEventV2): boolean {
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
    this.cursor.recentEventIds.push(eventId)
    this.recentEventIds.add(eventId)

    while (this.cursor.recentEventIds.length > RECENT_EVENT_WINDOW) {
      const dropped = this.cursor.recentEventIds.shift()
      if (dropped !== undefined) {
        this.recentEventIds.delete(dropped)
      }
    }

    this.onCursorChange?.(this.snapshotCursor())
    return 'accepted'
  }

  private handleProtocolMismatch(reason: string): void {
    this.onProtocolError?.(reason)
    this.scheduleReconnect(SseFailureCodes.ProtocolMismatch)
  }

  private scheduleReconnect(reason: SseFailureCode): void {
    if (reason === SseFailureCodes.AuthFailed || reason === SseFailureCodes.PowFailed) {
      return
    }

    this.clearReconnectTimer()
    this.isConnectedFlag = false
    this.isReconnecting = true
    this.retryCount += 1
    this.onStatusChange?.('reconnecting', this.retryCount)

    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, this.retryCount - 1), RETRY_MAX_DELAY_MS)
    const jitter = Math.floor(Math.random() * 250)

    this.reconnectTimer = window.setTimeout(() => {
      if (!this.isReconnecting) {
        return
      }

      void this.connect(true)
    }, delay + jitter)
  }

  private restoreCursor(cursor: SseDeliveryCursor): void {
    this.cursor = {
      lastEventId: cursor.lastEventId || 0,
      recentEventIds: [...cursor.recentEventIds].slice(-RECENT_EVENT_WINDOW)
    }

    this.recentEventIds = new Set<number>(this.cursor.recentEventIds)
    this.onCursorChange?.(this.snapshotCursor())
  }

  private resetCursor(): void {
    this.cursor = { lastEventId: 0, recentEventIds: [] }
    this.recentEventIds.clear()
    this.onCursorChange?.(this.snapshotCursor())
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

}

export const sseRuntime = new SseRuntime()

function normalizeHandshakeFailure(
  errorCode: string | undefined,
  status: number,
  mode: 'auth' | 'guest'
): SseFailureCode {
  switch (errorCode) {
    case SseFailureCodes.AuthFailed:
    case SseFailureCodes.PowFailed:
    case SseFailureCodes.ProtocolMismatch:
    case SseFailureCodes.AccountBlocked:
    case SseFailureCodes.AccountDeleted:
    case SseFailureCodes.WebSocketRequired:
      return errorCode
    default:
      if (status === 401) {
        return mode === 'auth' ? SseFailureCodes.AuthFailed : SseFailureCodes.PowFailed
      }
      if (status === 409) {
        return SseFailureCodes.ProtocolMismatch
      }
      return status >= 500 ? SseFailureCodes.ServerError : SseFailureCodes.NetworkError
  }
}
