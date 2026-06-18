import { describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyRuntime,
  type CommentPrivacyAdapter,
  type CommentPrivacyMetadata,
  type CommentPrivacyWorkerClient
} from '@/privacy/commentPrivacyRuntime'

describe('CommentPrivacyRuntime', () => {
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
          proofToken: 'ticket-1',
          zkProof: proofBytes,
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
    expect(ticket?.proofToken).toBe('ticket-1')
    expect([...(ticket?.zkProof ?? [])]).toEqual([9, 8, 7])
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
    prepareProof: vi.fn().mockResolvedValue(new Uint8Array([9, 8, 7])),
    dispose: vi.fn()
  }
}

function createAdapter(overrides: {
  metadata?: CommentPrivacyAdapter['loadPrivacyMetadata']
  ticket?: CommentPrivacyAdapter['issueAnonymousTicket']
} = {}): CommentPrivacyAdapter {
  return {
    ensureCredentialPrepared: vi.fn().mockResolvedValue({ ok: true }),
    loadPrivacyMetadata: vi.fn(overrides.metadata ?? (async ({ scope }) => ({
      ok: true,
      metadata: createMetadata(scope)
    }))),
    issueAnonymousTicket: vi.fn(overrides.ticket ?? (async ({ scope, proofBytes }) => ({
      ok: true,
      ticket: {
        scope,
        proofToken: 'ticket',
        zkProof: proofBytes,
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
