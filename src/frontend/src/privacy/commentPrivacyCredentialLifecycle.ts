export type CommentPrivacyCredentialPurgeReason =
  | 'logout'
  | 'session-expired'
  | 'account-switch'
  | 'account-deletion'
  | 'credential-revoked'
  | 'issuer-key-rotation'
  | 'root-retired'
  | 'epoch-changed'
  | 'feature-disabled'
  | 'panic'
  | 'migration-failure'
  | 'shared-device'

type PurgeHandler = (reason: CommentPrivacyCredentialPurgeReason) => void | Promise<void>

interface PrivacyLifecycleEvent {
  v: 1
  type: 'credential-purge'
  reason: CommentPrivacyCredentialPurgeReason
  eventId: string
  at: number
}

type BroadcastChannelConstructor = new (name: string) => BroadcastChannel

const PRIVACY_BROADCAST_CHANNEL = 'fsus-comment-privacy'
const PRIVACY_BROADCAST_STORAGE_KEY = 'fsus:comment-privacy:purge'
const PURGE_REASONS = new Set<CommentPrivacyCredentialPurgeReason>([
  'logout',
  'session-expired',
  'account-switch',
  'account-deletion',
  'credential-revoked',
  'issuer-key-rotation',
  'root-retired',
  'epoch-changed',
  'feature-disabled',
  'panic',
  'migration-failure',
  'shared-device'
])

const purgeHandlers = new Set<PurgeHandler>()
let localGenerationCounter = 0
let localVaultGeneration = createLocalToken('generation')
let channel: BroadcastChannel | null = null
let storageListenerInstalled = false

export function getCommentPrivacyLocalVaultGeneration(): string {
  return localVaultGeneration
}

export function registerCommentPrivacyCredentialPurgeHandler(handler: PurgeHandler): () => void {
  purgeHandlers.add(handler)
  bindCrossTabTransport()
  return () => purgeHandlers.delete(handler)
}

function advanceCommentPrivacyLocalVaultGeneration(
  reason: CommentPrivacyCredentialPurgeReason,
  options: { broadcast?: boolean } = {}
): string {
  localGenerationCounter += 1
  localVaultGeneration = createLocalToken(`generation-${localGenerationCounter}`)
  if (options.broadcast !== false) {
    broadcastPurge(reason)
  }
  return localVaultGeneration
}

export async function purgeCommentPrivacyCredentialState(
  reason: CommentPrivacyCredentialPurgeReason,
  options: { broadcast?: boolean } = {}
): Promise<void> {
  advanceCommentPrivacyLocalVaultGeneration(reason, options)
  const pending: Promise<void>[] = []
  for (const handler of purgeHandlers) {
    try {
      pending.push(Promise.resolve(handler(reason)))
    } catch (error) {
      pending.push(Promise.reject(error))
    }
  }
  const results = await Promise.allSettled(pending)
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('comment_privacy_credential_purge_incomplete')
  }
}

export function zeroizeCommentPrivacyBytes(bytes: Uint8Array | null | undefined): void {
  if (bytes instanceof Uint8Array) {
    bytes.fill(0)
  }
}

export function resetCommentPrivacyCredentialLifecycleForTests(): void {
  closeChannelSafely()
  channel = null
  if (storageListenerInstalled && typeof window !== 'undefined') {
    window.removeEventListener('storage', handleStorageEvent)
  }
  storageListenerInstalled = false
  purgeHandlers.clear()
  localGenerationCounter = 0
  localVaultGeneration = createLocalToken('generation')
}

function bindCrossTabTransport(): void {
  if (typeof window === 'undefined' || channel || storageListenerInstalled) {
    return
  }

  const BroadcastChannelImpl = (window as Window & {
    BroadcastChannel?: BroadcastChannelConstructor
  }).BroadcastChannel
  if (typeof BroadcastChannelImpl === 'function') {
    try {
      channel = new BroadcastChannelImpl(PRIVACY_BROADCAST_CHANNEL)
      channel.addEventListener('message', handleChannelMessage)
      return
    } catch {
      closeChannelSafely()
      channel = null
    }
  }

  try {
    window.addEventListener('storage', handleStorageEvent)
    storageListenerInstalled = true
  } catch {
    storageListenerInstalled = false
  }
}

function broadcastPurge(reason: CommentPrivacyCredentialPurgeReason): void {
  bindCrossTabTransport()
  const event: PrivacyLifecycleEvent = {
    v: 1,
    type: 'credential-purge',
    reason,
    eventId: createLocalToken('event'),
    at: Date.now()
  }

  if (channel) {
    try {
      channel.postMessage(event)
      return
    } catch {
      closeChannelSafely()
      channel = null
      bindCrossTabTransport()
    }
  }
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(PRIVACY_BROADCAST_STORAGE_KEY, JSON.stringify(event))
    window.localStorage.removeItem(PRIVACY_BROADCAST_STORAGE_KEY)
  } catch {
    // Restricted/private browser contexts remain memory-only in this tab.
  }
}

function handleRemoteEvent(value: unknown): void {
  if (!isPrivacyLifecycleEvent(value)) {
    return
  }
  void purgeCommentPrivacyCredentialState(value.reason, { broadcast: false }).catch(() => {
    // The generation already rotated; the remote tab remains fail closed.
  })
}

function closeChannelSafely(): void {
  try {
    channel?.removeEventListener('message', handleChannelMessage)
    channel?.close()
  } catch {
    // A broken BroadcastChannel must not block the storage fallback.
  }
}

function handleChannelMessage(event: MessageEvent): void {
  handleRemoteEvent(event.data)
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== PRIVACY_BROADCAST_STORAGE_KEY || !event.newValue) {
    return
  }
  try {
    handleRemoteEvent(JSON.parse(event.newValue) as unknown)
  } catch {
    // Ignore malformed cross-tab payloads.
  }
}

function isPrivacyLifecycleEvent(value: unknown): value is PrivacyLifecycleEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<PrivacyLifecycleEvent>
  return candidate.v === 1 &&
    candidate.type === 'credential-purge' &&
    typeof candidate.reason === 'string' &&
    PURGE_REASONS.has(candidate.reason as CommentPrivacyCredentialPurgeReason) &&
    typeof candidate.eventId === 'string' &&
    candidate.eventId.length > 0 &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at)
}

function createLocalToken(prefix: string): string {
  const bytes = new Uint8Array(16)
  const cryptoSource = typeof globalThis.crypto === 'undefined' ? null : globalThis.crypto
  if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
    cryptoSource.getRandomValues(bytes)
    const encoded = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    bytes.fill(0)
    return `${prefix}:${encoded}`
  }

  return `${prefix}:${Date.now().toString(36)}:${localGenerationCounter.toString(36)}`
}
