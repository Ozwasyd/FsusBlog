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
            credentialEpoch: 20260618,
            ticket: proofBytes,
            expiresAtUnixMs: Date.now() + 1_000
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

      await runtime.prepareAnonymousTicket('article:42')
      expect(runtime.consumePreparedTicket('article:42')).not.toBeNull()

      await runtime.prepareAnonymousTicket('article:42')
      vi.advanceTimersByTime(1_001)

      expect(runtime.consumePreparedTicket('article:42')).toBeNull()
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
          scope,
          rootVersion: 'root-v1',
          metadataBytes: new Uint8Array([1, 2, 3])
        }
      }),
      ticket: async ({ scope, proofBytes }) => ({
        ok: true,
        ticket: {
          scope,
          credentialEpoch: 20260618,
          ticket: proofBytes,
          expiresAtUnixMs: now + 30_000
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
    await runtime.prepareAnonymousTicket('article:42')

    expect(adapter.ensureCredentialPrepared).toHaveBeenCalledTimes(1)
    expect(adapter.loadPrivacyMetadata).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'article:42',
      articleId: 42,
      signal: expect.any(AbortSignal)
    }))
    expect(worker.prewarm).toHaveBeenCalledTimes(1)
    expect(worker.prepareProof).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'article:42',
      rootVersion: 'root-v1',
      metadataBytes: expect.any(Uint8Array),
      signal: expect.any(AbortSignal)
    }))
    expect(runtime.getUiState()).toBe('ready')
    expect(states).toContain('preparing')
    expect(states).toContain('ready')

    const ticket = runtime.consumePreparedTicket('article:42')
    expect(ticket?.credentialEpoch).toBe(20260618)
    expect([...(ticket?.ticket ?? [])]).toEqual([9, 8, 7])
    expect(runtime.consumePreparedTicket('article:42')).toBeNull()

    now += 30_001
    await runtime.prepareAnonymousTicket('article:42')
    now += 30_001
    expect(runtime.consumePreparedTicket('article:42')).toBeNull()
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
            issuerSignature: new Uint8Array([21, 22, 23]),
            revocationWitness: new Uint8Array([31, 32, 33])
          }
        })
      }),
      workerClient: worker
    })

    await runtime.prepareAnonymousTicket('article:42')

    expect(worker.prepareProof).toHaveBeenCalledWith(expect.objectContaining({
      credentialSecret: new Uint8Array([11, 12, 13]),
      issuerSignature: new Uint8Array([21, 22, 23]),
      revocationWitness: new Uint8Array([31, 32, 33])
    }))
  })

  it('cancels stale article metadata preloads when articles switch quickly', async () => {
    const signals: AbortSignal[] = []
    const adapter = createAdapter({
      metadata: async ({ scope, signal }) => {
        signals.push(signal)
        if (scope === 'article:1') {
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
    expect(signals[0].aborted).toBe(true)
    expect(runtime.getUiState()).toBe('preparing')
    await runtime.prepareAnonymousTicket('article:2')
    expect(runtime.getUiState()).toBe('ready')
  })
})

function createWorker(): CommentPrivacyWorkerClient {
  return {
    prewarm: vi.fn().mockResolvedValue(undefined),
    prepareProof: vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([9, 8, 7]),
      publicInputs: new Uint8Array([6, 5, 4]),
      nullifierHash: new Uint8Array([3, 2, 1])
    }),
    dispose: vi.fn()
  }
}

function createAdapter(overrides: {
  credential?: CommentPrivacyAdapter['ensureCredentialPrepared']
  metadata?: CommentPrivacyAdapter['loadPrivacyMetadata']
  ticket?: CommentPrivacyAdapter['issueAnonymousTicket']
} = {}): CommentPrivacyAdapter {
  return {
    ensureCredentialPrepared: vi.fn(overrides.credential ?? (async () => ({ ok: true }))),
    loadPrivacyMetadata: vi.fn(overrides.metadata ?? (async ({ scope }) => ({
      ok: true,
      metadata: createMetadata(scope)
    }))),
    issueAnonymousTicket: vi.fn(overrides.ticket ?? (async ({ scope, proofBytes }) => ({
      ok: true,
      ticket: {
        scope,
        credentialEpoch: 20260618,
        ticket: proofBytes,
        expiresAtUnixMs: Date.now() + 30_000
      }
    })))
  }
}

function createMetadata(scope: string): CommentPrivacyMetadata {
  return {
    scope,
    rootVersion: 'root',
    metadataBytes: new Uint8Array([1])
  }
}
