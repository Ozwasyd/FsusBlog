import { describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyRuntime,
  type CommentPrivacyAdapter,
  type CommentPrivacyMetadata,
  type CommentPrivacyWorkerClient
} from '@/privacy/commentPrivacyRuntime'

describe('CommentPrivacyRuntime', () => {
  it('uses fake timers to expire prepared tickets by TTL', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-18T00:00:00Z'))
      const adapter = createAdapter({
        ticket: async ({ scope, proofBytes }) => ({
          ok: true,
          ticket: {
            scope,
            ticket: new Uint8Array(proofBytes),
            expiresAtUnixMs: Date.now() + 1_000,
            rateClass: 'common',
            requiresModeration: false
          }
        })
      })
      const runtime = createCommentPrivacyRuntime({
        adapter,
        workerClient: createWorker(),
        now: () => Date.now(),
        scheduleIdleTask: (task) => {
          task()
          return () => {}
        }
      })

      await runtime.prepareAnonymousTicket('comment:v1:article:42:top')
      expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).not.toBeNull()

      await runtime.prepareAnonymousTicket('comment:v1:article:42:top')
      vi.advanceTimersByTime(1_001)

      expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preloads article metadata, prepares a short-lived ticket, and consumes it once', async () => {
    let now = 1_000
    const adapter = createAdapter({
      metadata: async ({ scope }) => ({
        ok: true,
        metadata: {
          ...createMetadata(scope),
          rootVersion: 'root-v1',
          metadataBytes: new Uint8Array([1, 2, 3])
        }
      }),
      ticket: async ({ scope, proofBytes }) => ({
        ok: true,
        ticket: {
          scope,
          ticket: new Uint8Array(proofBytes),
          expiresAtUnixMs: now + 30_000,
          rateClass: 'common',
          requiresModeration: false
        }
      })
    })
    const worker = createWorker()
    const runtime = createCommentPrivacyRuntime({
      adapter,
      workerClient: worker,
      now: () => now,
      scheduleIdleTask: (task) => {
        queueMicrotask(task)
        return () => {}
      }
    })
    const states: string[] = []
    runtime.subscribe((state) => states.push(state))

    await runtime.preloadPrivacyMetadata(42)
    await runtime.prepareAnonymousTicket('comment:v1:article:42:top')

    expect(adapter.ensureCredentialPrepared).toHaveBeenCalledTimes(2)
    expect(adapter.loadPrivacyMetadata).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'comment:v1:article:42:top',
      articleId: 42,
      signal: expect.any(AbortSignal)
    }))
    expect(worker.prewarm).toHaveBeenCalledTimes(1)
    expect(worker.prepareProof).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'comment:v1:article:42:top',
      rootVersion: 'root-v1',
      metadataBytes: expect.any(Uint8Array),
      signal: expect.any(AbortSignal)
    }))
    expect(runtime.getUiState()).toBe('ready')
    expect(states).toContain('preparing')
    expect(states).toContain('ready')

    const ticket = runtime.consumePreparedTicket('comment:v1:article:42:top')
    expect(worker.prepareProof).toHaveBeenCalledWith(expect.objectContaining({ credentialEpoch: 20260618 }))
    expect(ticket).not.toHaveProperty('credentialEpoch')
    expect([...(ticket?.ticket ?? [])]).toEqual([9, 8, 7])
    expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).toBeNull()

    now += 30_001
    await runtime.prepareAnonymousTicket('comment:v1:article:42:top')
    now += 30_001
    expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).toBeNull()
  })

  it('returns unavailable instead of throwing when privacy endpoints are not ready', async () => {
    const runtime = createCommentPrivacyRuntime({
      adapter: createAdapter({
        metadata: async () => ({ ok: false, reason: 'privacy_metadata_unavailable' })
      }),
      workerClient: createWorker()
    })

    await expect(runtime.preloadPrivacyMetadata(7)).resolves.toBe(false)

    expect(runtime.getUiState()).toBe('unavailable')
  })

  it('passes prepared credential material to the worker proof request', async () => {
    const worker = createWorker()
    const runtime = createCommentPrivacyRuntime({
      adapter: createAdapter({
        credential: async () => ({
          ok: true,
          credential: {
            credentialSecret: new Uint8Array([11, 12, 13]),
            credentialCommitment: new Uint8Array([14, 15, 16]),
            issuerSignature: new Uint8Array([21, 22, 23]),
            revocationWitness: new Uint8Array([31, 32, 33]),
            credentialLevel: 'strong_anonymous',
            reputationBucket: 'rep:low'
          }
        })
      }),
      workerClient: worker
    })

    await runtime.prepareAnonymousTicket('comment:v1:article:42:top')

    expect(worker.prepareProof).toHaveBeenCalledWith(expect.objectContaining({
      credentialSecret: new Uint8Array([11, 12, 13]),
      credentialCommitment: new Uint8Array([14, 15, 16]),
      issuerSignature: new Uint8Array([21, 22, 23]),
      revocationWitness: new Uint8Array([31, 32, 33]),
      policyHash: '9'.repeat(64),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    }))
  })

  it('cancels stale article metadata preloads when articles switch quickly', async () => {
    const signals: AbortSignal[] = []
    const credentialSignals: AbortSignal[] = []
    const adapter = createAdapter({
      credential: async ({ signal }) => {
        credentialSignals.push(signal)
        return {
          ok: true,
          credential: {
            credentialSecret: new Uint8Array([11, 12, 13]),
            credentialCommitment: new Uint8Array([14, 15, 16]),
            issuerSignature: new Uint8Array([21, 22, 23]),
            revocationWitness: new Uint8Array([31, 32, 33]),
            credentialLevel: 'strong_anonymous',
            reputationBucket: 'rep:low'
          }
        }
      },
      metadata: async ({ scope, signal }) => {
        signals.push(signal)
        if (scope === 'comment:v1:article:1:top') {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          return { ok: false, reason: 'aborted' }
        }
        return {
          ok: true,
          metadata: {
            scope,
            rootVersion: 'root-v2',
            metadataBytes: new Uint8Array([4, 5, 6])
          }
        }
      }
    })
    const runtime = createCommentPrivacyRuntime({
      adapter,
      workerClient: createWorker(),
      scheduleIdleTask: (task) => {
        task()
        return () => {}
      }
    })

    const first = runtime.preloadPrivacyMetadata(1)
    const second = runtime.preloadPrivacyMetadata(2)

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(credentialSignals[0].aborted).toBe(true)
    expect(runtime.getUiState()).toBe('preparing')
    await runtime.prepareAnonymousTicket('comment:v1:article:2:top')
    expect(runtime.getUiState()).toBe('ready')
  })

  it('zeroizes credential copies, tickets, and terminates the privacy worker on panic', async () => {
    const worker = createWorker()
    const adapter = createAdapter()
    const runtime = createCommentPrivacyRuntime({ adapter, workerClient: worker })

    await expect(runtime.prepareAnonymousTicket('comment:v1:article:42:top')).resolves.toBe(true)
    const proofRequest = vi.mocked(worker.prepareProof).mock.calls[0][0]

    await runtime.purge('panic')

    expect(proofRequest.credentialSecret?.every(byte => byte === 0)).toBe(true)
    expect(proofRequest.issuerSignature?.every(byte => byte === 0)).toBe(true)
    expect(proofRequest.revocationWitness?.every(byte => byte === 0)).toBe(true)
    expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).toBeNull()
    expect(adapter.purgeCredential).toHaveBeenCalledTimes(1)
    expect(worker.dispose).toHaveBeenCalledTimes(1)
  })

  it('aborts in-flight preparation on rotation so stale work cannot refill the runtime', async () => {
    const deferred: { release: (() => void) | null } = { release: null }
    const adapter = createAdapter({
      credential: async ({ signal }) => {
        await new Promise<void>(resolve => {
          deferred.release = resolve
        })
        return {
          ok: true,
          credential: {
            credentialSecret: new Uint8Array([1, 2, 3]),
            credentialCommitment: new Uint8Array([4, 5, 6]),
            issuerSignature: new Uint8Array([7, 8, 9]),
            revocationWitness: new Uint8Array([10, 11, 12]),
            credentialLevel: 'strong_anonymous',
            reputationBucket: 'rep:low'
          }
        }
      }
    })
    const worker = createWorker()
    const runtime = createCommentPrivacyRuntime({ adapter, workerClient: worker })
    const preparing = runtime.prepareAnonymousTicket('comment:v1:article:42:top')

    await vi.waitFor(() => expect(deferred.release).not.toBeNull())
    await runtime.purge('issuer-key-rotation')
    deferred.release?.()

    await expect(preparing).resolves.toBe(false)
    expect(adapter.issueAnonymousTicket).not.toHaveBeenCalled()
    expect(runtime.consumePreparedTicket('comment:v1:article:42:top')).toBeNull()
  })
})

function createWorker(): CommentPrivacyWorkerClient {
  return {
    prewarm: vi.fn().mockResolvedValue(undefined),
    buildRevocationWitness: vi.fn().mockRejectedValue(new Error('unexpected revocation request in lifecycle test')),
    prepareProof: vi.fn().mockImplementation(async () => ({
      proofBytes: new Uint8Array([9, 8, 7]),
      publicInputs: new Uint8Array([6, 5, 4]),
      nullifierHash: new Uint8Array([3, 2, 1])
    })),
    dispose: vi.fn()
  }
}

function createAdapter(overrides: {
  credential?: CommentPrivacyAdapter['ensureCredentialPrepared']
  metadata?: CommentPrivacyAdapter['loadPrivacyMetadata']
  ticket?: CommentPrivacyAdapter['issueAnonymousTicket']
} = {}): CommentPrivacyAdapter {
  const ensureCredentialPrepared: CommentPrivacyAdapter['ensureCredentialPrepared'] = overrides.credential ?? (async () => ({
    ok: true,
    credential: {
      credentialSecret: new Uint8Array([11, 12, 13]),
      credentialCommitment: new Uint8Array([14, 15, 16]),
      issuerSignature: new Uint8Array([21, 22, 23]),
      revocationWitness: new Uint8Array([31, 32, 33]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    }
  }))
  const loadPrivacyMetadata: CommentPrivacyAdapter['loadPrivacyMetadata'] = overrides.metadata ?? (async ({ scope }) => ({
    ok: true,
    metadata: createMetadata(scope)
  }))
  const issueAnonymousTicket: CommentPrivacyAdapter['issueAnonymousTicket'] = overrides.ticket ?? (async ({ scope, proofBytes }) => ({
    ok: true,
    ticket: {
      scope,
      ticket: new Uint8Array(proofBytes),
      expiresAtUnixMs: Date.now() + 30_000,
      rateClass: 'common',
      requiresModeration: false
    }
  }))
  return {
    ensureCredentialPrepared: vi.fn(ensureCredentialPrepared),
    loadPrivacyMetadata: vi.fn(loadPrivacyMetadata),
    issueAnonymousTicket: vi.fn(issueAnonymousTicket),
    purgeCredential: vi.fn().mockResolvedValue(undefined)
  }
}

function createMetadata(scope: string): CommentPrivacyMetadata {
  return {
    scope,
    rootVersion: 'root',
    metadataBytes: new Uint8Array([1]),
    credentialEpoch: 20260618,
    circuitNumericId: 7,
    publicInputLayoutVersion: 6,
    circuitId: 'fsus.anonymous.comment.v5',
    verifyingKeyHash: 'a'.repeat(64),
    issuerPublicKeyHash: 'b'.repeat(64),
    policyHash: '9'.repeat(64),
    credentialRoot: new Uint8Array([2]),
    revocationRoot: new Uint8Array([3]),
    circuitMetadata: new Uint8Array([4]),
    credentialLevel: 'strong_anonymous',
    reputationBucket: 'unrated'
  }
}
