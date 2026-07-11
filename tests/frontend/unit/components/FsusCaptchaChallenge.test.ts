import { describe, expect, it } from 'vitest'
import { SecurityChallengeKind, type SecurityChallengeIssueResponse } from '@/api/security'
import {
  buildCaptchaVerifyProviderPayload,
  mapCaptchaErrorMessage,
  selectCaptchaChallenge
} from '@/components/security/captchaChallengeModel'

const providerPayload = {
  algorithm: 'fsu.captcha/chebyshev-noise@v1',
  polynomialSeedHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  noiseSeedHex: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  seedPayloadBase64: 'dj0x',
  signatureHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  gridWidth: '64',
  gridHeight: '24',
  distortionLevel: '18',
  powDifficultyBits: '8',
  issuedAtUnixMs: '1770000000000',
  expiresAtUnixMs: '1770000300000'
}

const issueResponse: SecurityChallengeIssueResponse = {
  decision: 'challenge',
  riskScore: 30,
  effectiveRiskScore: 30,
  escalationLevel: 2,
  policyVersion: 'risk-policy-v2',
  retryAfterMs: 0,
  envelope: {
    envelopeId: 'env-1',
    policyVersion: 'risk-policy-v2',
    assignments: [{
      challengeId: '01900000-0000-7000-8000-000000000000',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tenantId: 'tenant-main',
      kind: SecurityChallengeKind.CaptchaV1,
      escalationLevel: 2,
      action: 'comment.create',
      routeKey: 'article:42',
      subjectHash: 'a'.repeat(64),
      clientIpHash: 'b'.repeat(64),
      deviceFpHash: 'c'.repeat(64),
      issuedAtUnixMs: 1770000000000,
      expiresAtUnixMs: 1770000300000
    }]
  },
  providerPayloads: [{
    challengeId: '01900000-0000-7000-8000-000000000000',
    payload: providerPayload
  }]
}

describe('FsusCaptchaChallenge', () => {
  it('selects the CaptchaV1 assignment and builds the provider verify payload', () => {
    const selected = selectCaptchaChallenge(issueResponse)
    const verifyPayload = buildCaptchaVerifyProviderPayload(providerPayload, 'aef2', {
      nonceHex: '01000000',
      responseTokenHex: '00' + 'a'.repeat(62),
      durationMs: 12
    }, 2500)

    expect(selected.assignment.challengeId).toBe('01900000-0000-7000-8000-000000000000')
    expect(selected.payload).toEqual(providerPayload)
    expect(verifyPayload).toMatchObject({
      answerText: 'AEF2',
      nonceHex: '01000000',
      solveDurationMs: '2500'
    })
  })

  it('shows a recoverable error when captcha runtime loading fails', async () => {
    expect(mapCaptchaErrorMessage(new Error('captcha_wasm_load_failed'))).toBe('图形校验引擎加载失败，请刷新重试。')
  })

})
