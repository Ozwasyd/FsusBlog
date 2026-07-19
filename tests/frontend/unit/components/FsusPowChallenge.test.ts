// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FsusPowChallenge from '@/components/security/FsusPowChallenge.vue'
import { SecurityChallengeKind } from '@/api/security'
import type { SecurityChallengeClient, SecurityChallengeIssueResult } from '@/security/challenge-client'

const powMocks = vi.hoisted(() => ({
  calculate: vi.fn(),
  prewarm: vi.fn()
}))

vi.mock('@/composables/usePow', () => ({
  usePow: () => ({
    calculate: powMocks.calculate,
    prewarm: powMocks.prewarm
  })
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'browser-fp'
}))

describe('FsusPowChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('solves with the shared bounded worker and continues to the next envelope member', async () => {
    const calculation = deferred<{ nonce: string, duration: number }>()
    powMocks.calculate.mockReturnValue(calculation.promise)
    const next = issueResult(SecurityChallengeKind.CaptchaV1, 'captcha-next')
    const client = fakeClient()
    vi.mocked(client.verify).mockResolvedValue({
      status: 'continue',
      response: null,
      proof: null,
      next,
      reason: null,
      retryAfterMs: 0
    })
    const wrapper = mountChallenge(client)
    await flushPromises()

    expect(wrapper.find('[data-test="pow-status"]').text()).toContain('计算')
    expect(powMocks.prewarm).toHaveBeenCalledTimes(1)
    const signal = powMocks.calculate.mock.calls[0]?.[4] as AbortSignal
    expect(signal.aborted).toBe(false)

    calculation.resolve({ nonce: 'nonce-1', duration: 10 })
    await flushPromises()

    expect(client.verify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'comment.create', routeKey: 'article:42' }),
      expect.objectContaining({
        challengeId: 'pow-1',
        kind: SecurityChallengeKind.Sha256PowV1,
        providerPayload: { proof: expect.any(String) }
      })
    )
    expect(wrapper.emitted('continued')).toEqual([[next]])
    expect(wrapper.find('[data-test="pow-progress"]').attributes('percentage')).toBe('100')
  })

  it('aborts the active generation and ignores late worker completion after cancel', async () => {
    const calculation = deferred<{ nonce: string, duration: number }>()
    powMocks.calculate.mockReturnValue(calculation.promise)
    const client = fakeClient()
    const wrapper = mountChallenge(client)
    await flushPromises()
    const signal = powMocks.calculate.mock.calls[0]?.[4] as AbortSignal

    await wrapper.find('[data-test="pow-cancel"]').trigger('click')
    expect(signal.aborted).toBe(true)
    expect(wrapper.emitted('cancel')).toHaveLength(1)

    calculation.resolve({ nonce: 'late-nonce', duration: 10 })
    await flushPromises()
    expect(client.verify).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="pow-status"]').text()).toContain('取消')
  })
})

function mountChallenge(client: SecurityChallengeClient) {
  return mount(FsusPowChallenge, {
    props: {
      assignment: issueResult(SecurityChallengeKind.Sha256PowV1, 'pow-1').assignment!,
      providerPayload: {
        challengeId: 'pow-1',
        payload: {
          salt: 'salt-1',
          difficulty: '4',
          timestamp: '1770000000',
          signature: 'signature-1'
        }
      },
      context: {
        action: 'comment.create',
        routeKey: 'article:42',
        deviceFingerprint: 'browser-fp'
      },
      client,
      refresh: vi.fn()
    },
    global: {
      stubs: {
        ElButton: { template: '<button :disabled="$attrs.disabled"><slot /></button>' },
        ElProgress: { props: ['percentage', 'status'], template: '<div data-test="pow-progress" :percentage="percentage" />' }
      }
    }
  })
}

function fakeClient(): SecurityChallengeClient {
  return {
    issue: vi.fn(),
    refresh: vi.fn(),
    verify: vi.fn(),
    reserveProof: vi.fn().mockReturnValue(null),
    cancelEnvelope: vi.fn(),
    clearProof: vi.fn()
  }
}

function issueResult(kind: SecurityChallengeKind, challengeId: string): SecurityChallengeIssueResult {
  return {
    status: 'challenge',
    response: null,
    assignment: {
      challengeId,
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tenantId: 'tenant-main',
      kind,
      escalationLevel: 2,
      action: 'comment.create',
      routeKey: 'article:42',
      subjectHash: 'a'.repeat(64),
      clientIpHash: 'b'.repeat(64),
      deviceFpHash: 'c'.repeat(64),
      issuedAtUnixMs: Date.now(),
      expiresAtUnixMs: Date.now() + 60_000
    },
    providerPayload: null,
    proof: null,
    kindGroup: 'pow',
    capability: null,
    reason: null,
    retryAfterMs: 0
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
