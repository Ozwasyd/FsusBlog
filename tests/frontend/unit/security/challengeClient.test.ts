import { describe, expect, it, vi } from 'vitest'
import {
  SecurityChallengeKind,
  type SecurityChallengeIssueResponse,
  type SecurityChallengeVerifyResponse
} from '@/api/security'
import {
  createSecurityChallengeClient,
  getChallengeKindGroup,
  type SecurityChallengeContext
} from '@/security/challenge-client'
import { createChallengeProofStore } from '@/security/challenge-proof-store'

const context: SecurityChallengeContext = {
  action: 'comment.create',
  routeKey: 'article:42',
  attributes: { surface: 'comment' }
}

describe('security challenge client and proof store', () => {
  it('keeps proof tokens in memory and evicts them after expiry', () => {
    let now = 1_770_000_000_000
    const store = createChallengeProofStore({ now: () => now })
    store.set({
      action: context.action,
      routeKey: context.routeKey,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      proofToken: 'proof-1',
      policyVersion: 'risk-v1',
      verifiedAtUnixMs: now,
      expiresAtUnixMs: now + 5000
    })

    expect(store.get(context.action, context.routeKey)?.proofToken).toBe('proof-1')
    now += 6000
    expect(store.get(context.action, context.routeKey)).toBeNull()
  })

  it('uses a cached proof without issuing a new challenge', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    store.set({
      action: context.action,
      routeKey: context.routeKey,
      challengeId: 'cached-1',
      kind: SecurityChallengeKind.CaptchaV1,
      proofToken: 'proof-cached',
      policyVersion: 'risk-v1',
      verifiedAtUnixMs: 900,
      expiresAtUnixMs: 10_000
    })
    const issueChallenge = vi.fn()
    const client = createSecurityChallengeClient({ proofStore: store, issueChallenge, now: () => 1000 })

    const result = await client.issue(context)

    expect(result.status).toBe('verified')
    expect(result.proof?.proofToken).toBe('proof-cached')
    expect(issueChallenge).not.toHaveBeenCalled()
  })

  it('refresh clears expired proof and requests a new challenge', async () => {
    let now = 1000
    const store = createChallengeProofStore({ now: () => now })
    store.set({
      action: context.action,
      routeKey: context.routeKey,
      challengeId: 'expired-1',
      kind: SecurityChallengeKind.CaptchaV1,
      proofToken: 'proof-expired',
      policyVersion: 'risk-v1',
      verifiedAtUnixMs: 500,
      expiresAtUnixMs: 900
    })
    const issueChallenge = vi.fn().mockResolvedValue(captchaIssueResponse())
    const verifyChallenge = vi.fn().mockResolvedValue({
      verified: true,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      policyVersion: 'risk-v1',
      proofToken: 'proof-verified',
      reason: '',
      retryAfterMs: 0
    } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({ proofStore: store, issueChallenge, verifyChallenge, now: () => now })

    const result = await client.issue(context)

    expect(result.status).toBe('challenge')
    expect(result.assignment?.kind).toBe(SecurityChallengeKind.CaptchaV1)
    expect(issueChallenge).toHaveBeenCalledTimes(1)
    expect(store.get(context.action, context.routeKey)).toBeNull()

    now = 2000
    await client.verify(context, {
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { answerText: 'AEF2' }
    })
    expect(store.get(context.action, context.routeKey)?.proofToken).toBe('proof-verified')
  })

  it('returns standard unsupported status for unknown challenge kind', async () => {
    const issueChallenge = vi.fn().mockResolvedValue(captchaIssueResponse(SecurityChallengeKind.Unknown))
    const client = createSecurityChallengeClient({ issueChallenge, now: () => 1000 })

    const result = await client.issue(context)

    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('security_challenge_kind_unsupported')
    expect(getChallengeKindGroup(SecurityChallengeKind.Argon2IdPoSpaceV1)).toBe('pospace')
    expect(getChallengeKindGroup(SecurityChallengeKind.PasskeyStepUpV1)).toBe('passkey')
  })

  it('normalizes failed verification without caching proof', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const verifyChallenge = vi.fn().mockResolvedValue({
      verified: false,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      policyVersion: 'risk-v1',
      proofToken: '',
      reason: 'captcha_invalid',
      retryAfterMs: 2000
    } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({ proofStore: store, verifyChallenge, now: () => 1000 })

    const result = await client.verify(context, {
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { answerText: 'BAD' }
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('captcha_invalid')
    expect(store.get(context.action, context.routeKey)).toBeNull()
  })
})

function captchaIssueResponse(kind: SecurityChallengeKind = SecurityChallengeKind.CaptchaV1): SecurityChallengeIssueResponse {
  return {
    decision: 'challenge',
    riskScore: 30,
    effectiveRiskScore: 30,
    escalationLevel: 2,
    policyVersion: 'risk-v1',
    retryAfterMs: 0,
    envelope: {
      envelopeId: 'env-1',
      policyVersion: 'risk-v1',
      assignments: [{
        challengeId: 'captcha-1',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        tenantId: 'tenant-main',
        kind,
        escalationLevel: 2,
        action: context.action,
        routeKey: context.routeKey,
        subjectHash: 'a'.repeat(64),
        clientIpHash: 'b'.repeat(64),
        deviceFpHash: 'c'.repeat(64),
        issuedAtUnixMs: 1000,
        expiresAtUnixMs: 300_000
      }]
    },
    providerPayloads: [{
      challengeId: 'captcha-1',
      payload: { algorithm: 'fsus.captcha/chebyshev-noise@v1' }
    }]
  }
}
