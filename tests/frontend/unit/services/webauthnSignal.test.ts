import { afterEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_EVENT } from '@/services/telemetryBus'
import { WebAuthnSignalService } from '@/services/webauthnSignal'
import type { PasskeySignalState } from '@/contracts/binaryApi'

const state = (revision = 1): PasskeySignalState => ({
  revision,
  rpId: 'example.test',
  userId: 'private-user-handle',
  name: 'fsus-anonymous-account',
  displayName: 'Quiet Reader',
  allAcceptedCredentialIds: ['private-credential-a']
})

describe('WebAuthnSignalService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('feature-detects once and sends the exact Level 3 all-accepted payload', async () => {
    const getClientCapabilities = vi.fn().mockResolvedValue({ signalAllAcceptedCredentials: true })
    const signalAllAcceptedCredentials = vi.fn().mockResolvedValue(undefined)
    const service = new WebAuthnSignalService({
      credentialApi: { getClientCapabilities, signalAllAcceptedCredentials },
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    await expect(service.reconcile(async () => state())).resolves.toBe('sent')
    await expect(service.reconcile(async () => state(2))).resolves.toBe('sent')

    expect(getClientCapabilities).toHaveBeenCalledOnce()
    expect(signalAllAcceptedCredentials).toHaveBeenLastCalledWith({
      rpId: 'example.test',
      userId: 'private-user-handle',
      allAcceptedCredentialIds: ['private-credential-a']
    })
  })

  it('is a no-op when the browser or capability is absent', async () => {
    const service = new WebAuthnSignalService({
      credentialApi: null,
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    await expect(service.signalUnknownCredential('example.test', 'credential')).resolves.toBe('unsupported')
  })

  it('bounds a provider promise that never settles', async () => {
    vi.useFakeTimers()
    const service = new WebAuthnSignalService({
      credentialApi: {
        getClientCapabilities: vi.fn().mockResolvedValue({ signalUnknownCredential: true }),
        signalUnknownCredential: vi.fn(() => new Promise<void>(() => {}))
      },
      timeoutMs: 25,
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    const outcome = service.signalUnknownCredential('example.test', 'private-credential')
    await vi.advanceTimersByTimeAsync(25)
    await expect(outcome).resolves.toBe('timed_out')
  })

  it('also bounds capability discovery that never settles', async () => {
    vi.useFakeTimers()
    const service = new WebAuthnSignalService({
      credentialApi: {
        getClientCapabilities: vi.fn(() => new Promise<Record<string, boolean>>(() => {})),
        signalUnknownCredential: vi.fn()
      },
      timeoutMs: 25,
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    const outcome = service.signalUnknownCredential('example.test', 'private-credential')
    await vi.advanceTimersByTimeAsync(25)
    await expect(outcome).resolves.toBe('unsupported')
  })

  it('honors cancellation without throwing into the caller', async () => {
    const controller = new AbortController()
    controller.abort()
    const signalUnknownCredential = vi.fn()
    const service = new WebAuthnSignalService({
      credentialApi: {
        getClientCapabilities: vi.fn().mockResolvedValue({ signalUnknownCredential: true }),
        signalUnknownCredential
      },
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    await expect(service.signalUnknownCredential('example.test', 'private-credential', {
      signal: controller.signal
    })).resolves.toBe('canceled')
    expect(signalUnknownCredential).not.toHaveBeenCalled()
  })

  it('rejects a stale complete credential list observed from another tab', async () => {
    const signalAllAcceptedCredentials = vi.fn().mockResolvedValue(undefined)
    const service = new WebAuthnSignalService({
      credentialApi: {
        getClientCapabilities: vi.fn().mockResolvedValue({ signalAllAcceptedCredentials: true }),
        signalAllAcceptedCredentials
      },
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })
    service.observeRevision(8)

    await expect(service.reconcile(async () => state(7))).resolves.toBe('stale')
    expect(signalAllAcceptedCredentials).not.toHaveBeenCalled()
  })

  it('never places user handles or credential ids into telemetry', async () => {
    const telemetry: unknown[] = []
    const listener = (event: Event) => telemetry.push((event as CustomEvent).detail)
    window.addEventListener(TELEMETRY_EVENT, listener)
    const service = new WebAuthnSignalService({
      credentialApi: {
        getClientCapabilities: vi.fn().mockResolvedValue({ signalAllAcceptedCredentials: true }),
        signalAllAcceptedCredentials: vi.fn().mockRejectedValue(new Error('provider unavailable'))
      },
      broadcastChannelFactory: null,
      locks: null,
      sessionStorage: null
    })

    await service.reconcile(async () => state())
    window.removeEventListener(TELEMETRY_EVENT, listener)

    const serialized = JSON.stringify(telemetry)
    expect(serialized).not.toContain('private-user-handle')
    expect(serialized).not.toContain('private-credential-a')
    expect(serialized).toContain('signalAllAcceptedCredentials')
  })
})
