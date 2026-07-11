import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getIntegrityAdminConsole,
  retryIntegrityProof,
  type IntegrityAdminConsoleResponse
} from '@/api/integrityConsole'
import { AppErrorCode } from '@/utils/appError'

const fetchMock = vi.fn<typeof fetch>()

const emptyConsole = (): IntegrityAdminConsoleResponse => ({
  checkedAtUtc: '2026-07-11T08:00:00.000Z',
  proofs: {
    total: 0,
    pending: 0,
    ready: 0,
    failed: 0,
    retrying: 0,
    superseded: 0,
    notPublic: 0
  },
  transparencyLog: {
    status: 'missing',
    headSeq: null,
    headHash: null,
    errorCode: null,
    failedSeq: null
  },
  checkpoint: {
    status: 'missing',
    checkpointKind: null,
    scopeKey: null,
    logHeadSeq: null,
    logHeadHash: null,
    createdAtUtc: null
  },
  keyRegistry: {
    currentKeyId: null,
    keys: []
  },
  recentProofs: [],
  failedOrRetryingProofs: []
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('integrity admin console API', () => {
  it('binds positive filters and preserves the empty console response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(emptyConsole()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))

    const result = await getIntegrityAdminConsole({
      articleId: 17,
      articleRevisionId: 82,
      revisionNo: 3
    })

    expect(result.recentProofs).toEqual([])
    expect(result.failedOrRetryingProofs).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/integrity/console?articleId=17&articleRevisionId=82&revisionNo=3',
      expect.objectContaining({
        credentials: 'include',
        method: 'GET'
      })
    )
  })

  it('submits retry with the selected proof id and one-use admin step-up token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      proofId: 91,
      proofStatus: 'retrying',
      retriedAtUtc: '2026-07-11T08:01:00.000Z'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))

    await expect(retryIntegrityProof(91, 'proof-91')).resolves.toMatchObject({
      proofId: 91,
      proofStatus: 'retrying'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/admin/integrity/console/proofs/91/retry')
    expect(init).toMatchObject({ credentials: 'include', method: 'POST' })
    expect((init?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-91')
  })

  it('turns a missing or rejected step-up response into a recoverable precondition error', async () => {
    fetchMock.mockResolvedValue(new Response('Admin step-up proof is required.', { status: 428 }))

    await expect(retryIntegrityProof(91, 'expired-proof')).rejects.toMatchObject({
      code: AppErrorCode.PreconditionRequired,
      status: 428,
      message: 'Admin step-up proof is required.'
    })
  })
})
