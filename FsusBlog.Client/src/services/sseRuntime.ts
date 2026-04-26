import type { PowParams, SseDeliveryCursor, SseEventV2, SseFailureCode } from '@/services/sseTypes'
import { SseEventType, SseFailureCodes } from '@/services/sseTypes'
import { encodeJsonToBase64 } from '@/utils/utf8'

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

type RuntimeCallbacks = {
  onEvent?: (event: SseEventV2) => void
  onCursorChange?: (cursor: SseDeliveryCursor) => void
  onStatusChange?: (status: RuntimeStatus, retryCount: number) => void
  onDuplicateEvent?: (eventId: number) => void
  onProtocolError?: (reason: string) => void
  onHandshakeFailure?: (code: SseFailureCode) => void
  onReconnectSuccess?: (replayMissed: boolean) => void
}

class SseRuntime {
  private readonly streamDecoder = new TextDecoder()
  private abortController: AbortController | null = null
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

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
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
    if (this.abortController) {
      this.abortController.abort()
    }

    this.abortController = new AbortController()
    this.onStatusChange?.(isReconnect ? 'reconnecting' : 'connecting', this.retryCount)

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'X-Fsus-Sse-Protocol': '2'
    }

    if (this.currentPow) {
      headers['X-Fsus-Pow-Proof'] = this.toSafeBase64({
        powNonce: this.currentPow.nonce,
        powSalt: this.currentPow.salt,
        browserFp: this.currentPow.fp,
        powSignature: this.currentPow.signature,
        difficulty: this.currentPow.difficulty,
        powTimestamp: this.currentPow.timestamp
      })
    }

    const requestUrl = new URL('/api/notifications/stream', window.location.origin)
    if (this.cursor.lastEventId > 0) {
      const cursorText = String(this.cursor.lastEventId)
      requestUrl.searchParams.set('cursor', cursorText)
      headers['Last-Event-ID'] = cursorText
    }

    try {
      const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
        method: 'GET',
        headers,
        credentials: 'include',
        signal: this.abortController.signal
      })

      if (!response.ok) {
        this.isConnectedFlag = false
        this.isReconnecting = false
        this.onStatusChange?.('idle', this.retryCount)
        this.onHandshakeFailure?.(await this.resolveFailureCode(response))
        return
      }

      if (!response.body) {
        this.handleProtocolMismatch('missing_body_stream')
        return
      }

      const replayMissed = response.headers.get('X-Fsus-Sse-Replay-Missed') === '1'
      this.isConnectedFlag = true
      this.onStatusChange?.('connected', this.retryCount)

      if (isReconnect) {
        this.retryCount = 0
        this.isReconnecting = false
        this.onReconnectSuccess?.(replayMissed)
      }

      await this.readStream(response.body.getReader())
    } catch (error: unknown) {
      if ((error as { name?: string }).name !== 'AbortError') {
        this.scheduleReconnect(SseFailureCodes.NetworkError)
      }
    }
  }

  private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += this.streamDecoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')

        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (!this.processChunk(chunk)) {
            return
          }
          boundary = buffer.indexOf('\n\n')
        }
      }

      buffer += this.streamDecoder.decode()
    } finally {
      reader.releaseLock()
    }

    this.scheduleReconnect(SseFailureCodes.NetworkError)
  }

  private processChunk(chunk: string): boolean {
    if (!chunk || chunk.startsWith(':')) {
      return true
    }

    let declaredId: number | null = null
    let dataPayload = ''
    let hasDataLine = false

    for (let start = 0; start <= chunk.length;) {
      const end = chunk.indexOf('\n', start)
      const nextStart = end === -1 ? chunk.length + 1 : end + 1
      const rawLine = end === -1 ? chunk.slice(start) : chunk.slice(start, end)
      start = nextStart

      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line || line.startsWith(':')) {
        continue
      }

      if (line.startsWith('id:')) {
        const value = Number(line.slice(3).trim())
        if (!Number.isFinite(value) || value <= 0) {
          this.handleProtocolMismatch('invalid_event_id')
          return false
        }

        declaredId = value
      } else if (line.startsWith('data:')) {
        if (hasDataLine) {
          dataPayload += '\n'
        }
        dataPayload += line.slice(5).trimStart()
        hasDataLine = true
      }
    }

    if (!hasDataLine) {
      return true
    }

    let event: SseEventV2
    try {
      event = JSON.parse(dataPayload) as SseEventV2
    } catch {
      this.handleProtocolMismatch('invalid_json_payload')
      return false
    }

    if (!this.isValidEvent(event, declaredId)) {
      this.handleProtocolMismatch('invalid_envelope')
      return false
    }

    const cursorState = this.acceptEventId(event.id)
    if (cursorState === 'duplicate') {
      this.onDuplicateEvent?.(event.id)
      return true
    }

    if (cursorState === 'out_of_order') {
      this.onDuplicateEvent?.(event.id)
      return true
    }

    this.onEvent?.(event)
    return true
  }

  private isValidEvent(event: SseEventV2, declaredId: number | null): boolean {
    if (!Number.isFinite(event.id) || event.id <= 0) {
      return false
    }

    if (declaredId !== null && declaredId !== event.id) {
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

  private async resolveFailureCode(response: Response): Promise<SseFailureCode> {
    if (response.status === 409) {
      return SseFailureCodes.ProtocolMismatch
    }

    if (response.status === 401 || response.status === 403) {
      return this.currentMode === 'auth' ? SseFailureCodes.AuthFailed : SseFailureCodes.PowFailed
    }

    return SseFailureCodes.ServerError
  }

  private handleProtocolMismatch(reason: string): void {
    this.onProtocolError?.(reason)
    this.scheduleReconnect(SseFailureCodes.ProtocolMismatch)
  }

  private scheduleReconnect(reason: SseFailureCode): void {
    if (this.abortController?.signal.aborted || reason === SseFailureCodes.AuthFailed || reason === SseFailureCodes.PowFailed) {
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

  private toSafeBase64(json: object): string {
    return encodeJsonToBase64(json)
  }
}

export const sseRuntime = new SseRuntime()
