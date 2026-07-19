import type { PasskeySignalState } from '@/contracts/binaryApi'
import { emitTelemetry } from '@/services/telemetryBus'

export type WebAuthnSignalApi =
  | 'signalAllAcceptedCredentials'
  | 'signalCurrentUserDetails'
  | 'signalUnknownCredential'

export type WebAuthnSignalOutcome =
  | 'sent'
  | 'unsupported'
  | 'timed_out'
  | 'canceled'
  | 'failed'
  | 'stale'
  | 'throttled'

type SignalOptions = { signal?: AbortSignal }
type ReconcileOptions = SignalOptions & { currentUserDetails?: boolean }
type CapabilityRecord = Record<string, boolean>

interface PublicKeyCredentialSignalApi {
  getClientCapabilities?: () => Promise<CapabilityRecord>
  signalAllAcceptedCredentials?: (options: {
    rpId: string
    userId: string
    allAcceptedCredentialIds: string[]
  }) => Promise<void>
  signalCurrentUserDetails?: (options: {
    rpId: string
    userId: string
    name: string
    displayName: string
  }) => Promise<void>
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

interface WebAuthnSignalDependencies {
  credentialApi?: PublicKeyCredentialSignalApi | null
  timeoutMs?: number
  now?: () => number
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'> | null
  broadcastChannelFactory?: ((name: string) => BroadcastChannel) | null
  locks?: LockManagerLike | null
}

const CAPABILITY_CACHE_MS = 5 * 60_000
const POST_LOGIN_SYNC_INTERVAL_MS = 6 * 60 * 60_000
const SIGNAL_LOCK_NAME = 'fsusblog:webauthn-signal-state'
const SIGNAL_CHANNEL_NAME = 'fsusblog:webauthn-signal-revision'
const POST_LOGIN_SYNC_KEY = 'fsusblog:webauthn-signal:last-login-sync'

export class WebAuthnSignalService {
  private readonly credentialApi: PublicKeyCredentialSignalApi | null
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  private readonly locks: LockManagerLike | null
  private readonly channel: BroadcastChannel | null
  private capabilities: { expiresAt: number; value: CapabilityRecord } | null = null
  private capabilitiesInFlight: Promise<CapabilityRecord> | null = null
  private highestRevision = -1

  constructor(dependencies: WebAuthnSignalDependencies = {}) {
    this.credentialApi = dependencies.credentialApi === undefined
      ? resolveCredentialApi()
      : dependencies.credentialApi
    this.timeoutMs = dependencies.timeoutMs ?? 2_000
    this.now = dependencies.now ?? Date.now
    this.storage = dependencies.sessionStorage === undefined ? resolveSessionStorage() : dependencies.sessionStorage
    this.locks = dependencies.locks === undefined ? resolveLocks() : dependencies.locks
    const channelFactory = dependencies.broadcastChannelFactory === undefined
      ? resolveBroadcastChannelFactory()
      : dependencies.broadcastChannelFactory
    this.channel = channelFactory?.(SIGNAL_CHANNEL_NAME) ?? null
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'number' && Number.isSafeInteger(event.data)) {
          this.highestRevision = Math.max(this.highestRevision, event.data)
        }
      }
    }
  }

  async signalUnknownCredential(
    rpId: string,
    credentialId: string,
    options: SignalOptions = {}
  ): Promise<WebAuthnSignalOutcome> {
    if (!rpId || !credentialId) return 'unsupported'
    return this.invoke('signalUnknownCredential', { rpId, credentialId }, options.signal)
  }

  async reconcile(
    fetchState: () => Promise<PasskeySignalState>,
    options: ReconcileOptions = {}
  ): Promise<WebAuthnSignalOutcome> {
    const run = () => this.reconcileUnlocked(fetchState, options)
    return this.locks ? this.locks.request(SIGNAL_LOCK_NAME, run) : run()
  }

  async commitAndReconcile<T>(
    commit: () => Promise<T>,
    fetchState: () => Promise<PasskeySignalState>,
    options: ReconcileOptions & { revisionOf?: (result: T) => number } = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const result = await commit()
      const revision = options.revisionOf?.(result)
      if (revision !== undefined) this.observeRevision(revision)
      await this.reconcileUnlocked(fetchState, options)
      return result
    }
    return this.locks ? this.locks.request(SIGNAL_LOCK_NAME, run) : run()
  }

  async reconcileAfterLogin(
    fetchState: () => Promise<PasskeySignalState>,
    options: SignalOptions = {}
  ): Promise<WebAuthnSignalOutcome> {
    const lastSync = Number(this.storage?.getItem(POST_LOGIN_SYNC_KEY) ?? '0')
    if (Number.isFinite(lastSync) && this.now() - lastSync < POST_LOGIN_SYNC_INTERVAL_MS) {
      return 'throttled'
    }
    const outcome = await this.reconcile(fetchState, { ...options, currentUserDetails: true })
    if (outcome === 'sent') {
      try {
        this.storage?.setItem(POST_LOGIN_SYNC_KEY, String(this.now()))
      } catch {
        // Storage availability is optional and must never affect authentication.
      }
    }
    return outcome
  }

  observeRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return
    this.highestRevision = Math.max(this.highestRevision, revision)
    try {
      this.channel?.postMessage(revision)
    } catch {
      // Cross-tab coordination is an optimization; local revision checks remain active.
    }
  }

  private async reconcileUnlocked(
    fetchState: () => Promise<PasskeySignalState>,
    options: ReconcileOptions
  ): Promise<WebAuthnSignalOutcome> {
    let state: PasskeySignalState
    try {
      state = await fetchState()
    } catch {
      this.record('signalAllAcceptedCredentials', 'failed')
      return 'failed'
    }
    return this.signalAuthoritativeState(state, options)
  }

  private async signalAuthoritativeState(
    state: PasskeySignalState,
    options: ReconcileOptions
  ): Promise<WebAuthnSignalOutcome> {
    if (!isValidSignalState(state)) return 'failed'
    if (state.revision < this.highestRevision) {
      this.record('signalAllAcceptedCredentials', 'stale')
      return 'stale'
    }
    this.observeRevision(state.revision)
    if (state.revision < this.highestRevision) {
      this.record('signalAllAcceptedCredentials', 'stale')
      return 'stale'
    }

    const acceptedOutcome = await this.invoke('signalAllAcceptedCredentials', {
      rpId: state.rpId,
      userId: state.userId,
      allAcceptedCredentialIds: [...state.allAcceptedCredentialIds]
    }, options.signal)
    if (acceptedOutcome !== 'sent' && acceptedOutcome !== 'unsupported') {
      return acceptedOutcome
    }
    if (!options.currentUserDetails) return acceptedOutcome
    if (state.revision < this.highestRevision) {
      this.record('signalCurrentUserDetails', 'stale')
      return 'stale'
    }
    return this.invoke('signalCurrentUserDetails', {
      rpId: state.rpId,
      userId: state.userId,
      name: state.name,
      displayName: state.displayName
    }, options.signal)
  }

  private async invoke(
    api: WebAuthnSignalApi,
    input: object,
    signal?: AbortSignal
  ): Promise<WebAuthnSignalOutcome> {
    if (signal?.aborted) {
      this.record(api, 'canceled')
      return 'canceled'
    }
    const capabilities = await this.getCapabilitiesForCall(signal)
    if (capabilities === null) {
      this.record(api, 'canceled')
      return 'canceled'
    }
    const method = this.credentialApi?.[api] as
      | ((this: PublicKeyCredentialSignalApi, options: object) => Promise<void>)
      | undefined
    if (!capabilities[api] || typeof method !== 'function') {
      this.record(api, 'unsupported')
      return 'unsupported'
    }
    if (signal?.aborted) {
      this.record(api, 'canceled')
      return 'canceled'
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    try {
      const outcome = await Promise.race<WebAuthnSignalOutcome>([
        Promise.resolve(method.call(this.credentialApi!, input)).then(() => 'sent' as const, () => 'failed' as const),
        new Promise<WebAuthnSignalOutcome>((resolve) => {
          timeoutId = setTimeout(() => resolve('timed_out'), this.timeoutMs)
          if (signal) {
            abortHandler = () => resolve('canceled')
            signal.addEventListener('abort', abortHandler, { once: true })
          }
        })
      ])
      this.record(api, outcome)
      return outcome
    } catch {
      this.record(api, 'failed')
      return 'failed'
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    }
  }

  private async getCapabilities(): Promise<CapabilityRecord> {
    if (!this.credentialApi) return {}
    if (this.capabilities && this.capabilities.expiresAt > this.now()) {
      return this.capabilities.value
    }
    if (this.capabilitiesInFlight) return this.capabilitiesInFlight
    if (typeof this.credentialApi.getClientCapabilities !== 'function') {
      return {}
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const capabilityRequest = Promise.resolve(this.credentialApi.getClientCapabilities())
      .then((value) => value && typeof value === 'object' ? value : {}, () => ({}))
    this.capabilitiesInFlight = Promise.race<CapabilityRecord>([
      capabilityRequest,
      new Promise<CapabilityRecord>((resolve) => {
        timeoutId = setTimeout(() => resolve({}), this.timeoutMs)
      })
    ])
      .then((value) => {
        this.capabilities = { expiresAt: this.now() + CAPABILITY_CACHE_MS, value }
        return value
      })
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        this.capabilitiesInFlight = null
      })
    return this.capabilitiesInFlight
  }

  private async getCapabilitiesForCall(signal?: AbortSignal): Promise<CapabilityRecord | null> {
    if (!signal) return this.getCapabilities()
    if (signal.aborted) return null
    let abortHandler: (() => void) | undefined
    try {
      return await Promise.race<CapabilityRecord | null>([
        this.getCapabilities(),
        new Promise<null>((resolve) => {
          abortHandler = () => resolve(null)
          signal.addEventListener('abort', abortHandler, { once: true })
        })
      ])
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler)
    }
  }

  private record(api: WebAuthnSignalApi, outcome: WebAuthnSignalOutcome): void {
    emitTelemetry('webauthn_signal', { api, capability: api, outcome }, outcome === 'failed' ? 'warn' : 'info')
  }
}

function isValidSignalState(state: PasskeySignalState): boolean {
  return Number.isSafeInteger(state.revision)
    && state.revision >= 0
    && Boolean(state.rpId)
    && Boolean(state.userId)
    && Boolean(state.name)
    && Boolean(state.displayName)
    && Array.isArray(state.allAcceptedCredentialIds)
    && state.allAcceptedCredentialIds.every((id) => typeof id === 'string' && id.length > 0)
}

function resolveCredentialApi(): PublicKeyCredentialSignalApi | null {
  return (globalThis as typeof globalThis & { PublicKeyCredential?: PublicKeyCredentialSignalApi })
    .PublicKeyCredential ?? null
}

function resolveSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function resolveLocks(): LockManagerLike | null {
  return (globalThis.navigator as Navigator & { locks?: LockManagerLike } | undefined)?.locks ?? null
}

function resolveBroadcastChannelFactory(): ((name: string) => BroadcastChannel) | null {
  return typeof globalThis.BroadcastChannel === 'function'
    ? (name) => new globalThis.BroadcastChannel(name)
    : null
}

export const webauthnSignalService = new WebAuthnSignalService()
