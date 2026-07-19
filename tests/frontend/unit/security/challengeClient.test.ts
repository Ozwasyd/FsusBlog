import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
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
import {
  SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  resolveChallengeCapability,
  securityChallengeCapabilityManifest
} from '@/security/challenge-capability-registry'

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

    expect(store.peek(context.action, context.routeKey)?.proofToken).toBe('proof-1')
    now += 6000
    expect(store.peek(context.action, context.routeKey)).toBeNull()
    expect(store.inspect(context.action, context.routeKey)?.state).toBe('expired')
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

  it('treats a server proof inside the conservative clock-skew window as expired', () => {
    const store = createChallengeProofStore({ now: () => 1_000, expirySkewMs: 1_000 })
    store.set({ ...proof('proof-near-expiry'), expiresAtUnixMs: 1_999 })

    expect(store.reserve(context.action, context.routeKey)).toBeNull()
    expect(store.inspect(context.action, context.routeKey)?.state).toBe('expired')
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
      envelopeId: ENVELOPE_ID,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      policyVersion: 'risk-v1',
      completedCount: 1,
      memberCount: 1,
      envelopeCompleted: true,
      proofToken: 'proof-verified',
      expiresAtUnixMs: 8_000,
      reason: '',
      retryAfterMs: 0
    } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({ proofStore: store, issueChallenge, verifyChallenge, now: () => now })

    const result = await client.issue(context)

    expect(result.status).toBe('challenge')
    expect(result.assignment?.kind).toBe(SecurityChallengeKind.CaptchaV1)
    expect(issueChallenge).toHaveBeenCalledTimes(1)
    expect(store.peek(context.action, context.routeKey)).toBeNull()

    now = 2000
    await client.verify(context, {
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { answerText: 'AEF2' }
    })
    expect(store.peek(context.action, context.routeKey)?.proofToken).toBe('proof-verified')
  })

  it('rejects unknown and executor-free challenge kinds without entering pending UI', async () => {
    const issueChallenge = vi.fn().mockResolvedValue(captchaIssueResponse(SecurityChallengeKind.Unknown))
    const client = createSecurityChallengeClient({ issueChallenge, now: () => 1000 })

    const result = await client.issue(context)

    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('security_challenge_kind_unknown')
    expect(getChallengeKindGroup(SecurityChallengeKind.Argon2IdPoSpaceV1)).toBe('pospace')
    expect(getChallengeKindGroup(SecurityChallengeKind.PasskeyStepUpV1)).toBe('passkey')
  })

  it('routes PoSpace and sha256PowV1 through UI executors while failing closed for incompatible manifests', async () => {
    const poSpace = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse(SecurityChallengeKind.Argon2IdPoSpaceV1)),
      now: () => 1000
    }).issue(context)
    expect(poSpace.status).toBe('challenge')
    expect(poSpace.capability?.executorFactory?.().mode).toBe('universal')
    expect(poSpace.capability?.uiHost).toBe('pospace')

    const sha256Pow = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse(SecurityChallengeKind.Sha256PowV1)),
      now: () => 1000
    }).issue(context)
    expect(sha256Pow.status).toBe('challenge')
    expect(sha256Pow.capability?.executorFactory?.().mode).toBe('universal')
    expect(sha256Pow.capability?.uiHost).toBe('sha256-pow')

    const incompatible = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse()),
      now: () => 1000
    }).issue({ ...context, capabilityManifestVersion: 'older-build' })
    expect(incompatible.status).toBe('unsupported')
    expect(incompatible.reason).toBe('security_challenge_version_incompatible')

    const executable = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse()),
      now: () => 1000
    }).issue(context)
    expect(executable.status).toBe('challenge')
    expect(executable.capability?.policyEligible).toBe(true)
  })

  it('covers known, provider, executor, host and policy state for every enum member', () => {
    const expected = [
      [SecurityChallengeKind.Unknown, false, false, false, false, false],
      [SecurityChallengeKind.Sha256PowV1, true, true, true, true, true],
      [SecurityChallengeKind.Argon2IdPoSpaceV1, true, true, true, true, true],
      [SecurityChallengeKind.CaptchaV1, true, true, true, true, true],
      [SecurityChallengeKind.HumanReadProofV1, true, true, false, false, false],
      [SecurityChallengeKind.PasskeyStepUpV1, true, true, false, false, false],
      [SecurityChallengeKind.AdminPasskeyStepUpV1, true, true, false, false, false],
      [SecurityChallengeKind.RecoveryKeyProofV1, true, false, false, false, false],
      [SecurityChallengeKind.AnonymousCredentialProofV1, true, false, false, false, false],
      [SecurityChallengeKind.ZkAnonymousCommentProofV1, true, false, false, false, false],
      [SecurityChallengeKind.PerceptionCharacterV2, true, false, true, true, false],
      [SecurityChallengeKind.PerceptionLocalizationV2, true, true, true, true, true],
      [SecurityChallengeKind.PerceptionMicroInteractionV2, true, true, true, true, true],
      [SecurityChallengeKind.PerceptionTextTaskV2, true, true, true, true, true]
    ] as const

    expect(securityChallengeCapabilityManifest).toHaveLength(Object.keys(SecurityChallengeKind).length)
    for (const [kind, known, provider, executor, host, policy] of expected) {
      const state = resolveChallengeCapability(kind, {
        action: context.action,
        mode: 'ui',
        manifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
      })
      expect([
        state.kindKnown,
        state.providerAvailable,
        state.executorAvailable,
        state.hostAvailable,
        state.policyEligible
      ], state.wireName).toEqual([known, provider, executor, host, policy])
    }
  })

  it('normalizes failed verification without caching proof', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const verifyChallenge = vi.fn().mockResolvedValue({
      verified: false,
      envelopeId: ENVELOPE_ID,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      policyVersion: 'risk-v1',
      completedCount: 1,
      memberCount: 1,
      envelopeCompleted: false,
      proofToken: '',
      expiresAtUnixMs: 0,
      reason: 'captcha_invalid',
      retryAfterMs: 2000
    } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({
      proofStore: store,
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse()),
      verifyChallenge,
      now: () => 1000
    })

    await client.issue(context)

    const result = await client.verify(context, {
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { answerText: 'BAD' }
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('captcha_invalid')
    expect(store.peek(context.action, context.routeKey)).toBeNull()
  })

  it('runs envelope members in order and stores only the final aggregate proof', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const response = captchaIssueResponse()
    const second = {
      ...response.envelope!.assignments[0]!,
      challengeId: 'captcha-2'
    }
    response.envelope!.assignments.push(second)
    response.providerPayloads.push({ challengeId: 'captcha-2', payload: { algorithm: 'second' } })
    const verifyChallenge = vi.fn()
      .mockResolvedValueOnce({
        verified: true,
        envelopeId: ENVELOPE_ID,
        challengeId: 'captcha-1',
        kind: SecurityChallengeKind.CaptchaV1,
        policyVersion: 'risk-v1',
        completedCount: 1,
        memberCount: 2,
        envelopeCompleted: false,
        proofToken: '',
        expiresAtUnixMs: 0,
        reason: 'ok',
        retryAfterMs: 0
      } satisfies SecurityChallengeVerifyResponse)
      .mockResolvedValueOnce({
        verified: true,
        envelopeId: ENVELOPE_ID,
        challengeId: 'captcha-2',
        kind: SecurityChallengeKind.CaptchaV1,
        policyVersion: 'risk-v1',
        completedCount: 2,
        memberCount: 2,
        envelopeCompleted: true,
        proofToken: 'aggregate-proof',
        expiresAtUnixMs: 8_000,
        reason: 'ok',
        retryAfterMs: 0
      } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({
      proofStore: store,
      issueChallenge: vi.fn().mockResolvedValue(response),
      verifyChallenge,
      now: () => 1000
    })

    const issued = await client.issue(context)
    const first = await client.verify(context, memberRequest('captcha-1'))

    expect(issued.assignment?.challengeId).toBe('captcha-1')
    expect(first.status).toBe('continue')
    expect(first.next?.assignment?.challengeId).toBe('captcha-2')
    expect(first.proof).toBeNull()
    expect(store.peek(context.action, context.routeKey)).toBeNull()

    const final = await client.verify(context, memberRequest('captcha-2'))
    expect(final.status).toBe('verified')
    expect(final.proof?.proofToken).toBe('aggregate-proof')
    expect(store.peek(context.action, context.routeKey)?.challengeId).toBe('captcha-2')
    expect(verifyChallenge.mock.calls.map(([request]) => request.envelopeId)).toEqual([ENVELOPE_ID, ENVELOPE_ID])
  })

  it('rejects out-of-order members and cancels a replaced envelope before transport', async () => {
    const firstIssue = captchaIssueResponse()
    firstIssue.envelope!.assignments.push({
      ...firstIssue.envelope!.assignments[0]!,
      challengeId: 'captcha-2'
    })
    const replacement = captchaIssueResponse()
    replacement.envelope = {
      ...replacement.envelope!,
      envelopeId: '01900000-0000-7000-8000-000000000002',
      assignments: [{ ...replacement.envelope!.assignments[0]!, challengeId: 'captcha-new' }]
    }
    replacement.providerPayloads = [{ challengeId: 'captcha-new', payload: { algorithm: 'replacement' } }]
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(firstIssue)
      .mockResolvedValueOnce(replacement)
    const verifyChallenge = vi.fn()
    const client = createSecurityChallengeClient({ issueChallenge, verifyChallenge, now: () => 1000 })

    await client.issue(context)
    const outOfOrder = await client.verify(context, memberRequest('captcha-2'))
    expect(outOfOrder.reason).toBe('security_challenge_member_mismatch')
    expect(verifyChallenge).not.toHaveBeenCalled()

    await client.refresh(context)
    const stale = await client.verify(context, memberRequest('captcha-1'))
    expect(stale.reason).toBe('security_challenge_member_mismatch')
    expect(verifyChallenge).not.toHaveBeenCalled()

    client.cancelEnvelope(context)
    const cancelled = await client.verify(context, memberRequest('captcha-new'))
    expect(cancelled.reason).toBe('security_challenge_envelope_missing')
    expect(verifyChallenge).not.toHaveBeenCalled()
  })

  it('aborts and tombstones an out-of-order issue response after refresh', async () => {
    const first = deferred<SecurityChallengeIssueResponse>()
    const second = deferred<SecurityChallengeIssueResponse>()
    let firstSignal: AbortSignal | undefined
    const replacement = captchaIssueResponse()
    replacement.envelope = {
      ...replacement.envelope!,
      envelopeId: '01900000-0000-7000-8000-000000000002',
      assignments: [{ ...replacement.envelope!.assignments[0]!, challengeId: 'captcha-new' }]
    }
    replacement.providerPayloads = [{ challengeId: 'captcha-new', payload: { algorithm: 'replacement' } }]
    const issueChallenge = vi.fn()
      .mockImplementationOnce((_request, config) => {
        firstSignal = config?.signal
        return first.promise
      })
      .mockImplementationOnce(() => second.promise)
    const client = createSecurityChallengeClient({ issueChallenge, now: () => 1000 })

    const staleRun = client.issue(context)
    const currentRun = client.refresh(context)
    expect(firstSignal?.aborted).toBe(true)

    second.resolve(replacement)
    await expect(currentRun).resolves.toMatchObject({ status: 'challenge', assignment: { challengeId: 'captcha-new' } })
    first.resolve(captchaIssueResponse())
    await expect(staleRun).resolves.toMatchObject({ status: 'failed', reason: 'security_challenge_request_cancelled' })

    const staleVerify = await client.verify(context, memberRequest('captcha-1'))
    expect(staleVerify.reason).toBe('security_challenge_member_mismatch')
  })

  it('does not store a late verify response after cancel or route generation change', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const verification = deferred<SecurityChallengeVerifyResponse>()
    let verifySignal: AbortSignal | undefined
    const client = createSecurityChallengeClient({
      proofStore: store,
      issueChallenge: vi.fn().mockResolvedValue(captchaIssueResponse()),
      verifyChallenge: vi.fn().mockImplementation((_request, config) => {
        verifySignal = config?.signal
        return verification.promise
      }),
      now: () => 1000
    })
    await client.issue(context)

    const pending = client.verify(context, memberRequest('captcha-1'))
    client.cancelEnvelope(context)
    expect(verifySignal?.aborted).toBe(true)
    verification.resolve({
      verified: true,
      envelopeId: ENVELOPE_ID,
      challengeId: 'captcha-1',
      kind: SecurityChallengeKind.CaptchaV1,
      policyVersion: 'risk-v1',
      completedCount: 1,
      memberCount: 1,
      envelopeCompleted: true,
      proofToken: 'late-proof',
      expiresAtUnixMs: 8_000,
      reason: 'ok',
      retryAfterMs: 0
    })

    await expect(pending).resolves.toMatchObject({ status: 'failed', reason: 'security_challenge_request_cancelled' })
    expect(store.peek(context.action, context.routeKey)).toBeNull()
  })

  it('sends the current capability manifest with every generic issue request', async () => {
    const issueChallenge = vi.fn().mockResolvedValue(captchaIssueResponse())
    const client = createSecurityChallengeClient({ issueChallenge, now: () => 1000 })

    await client.issue(context)

    expect(issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityManifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('allows only one concurrent reservation and restores only before send', () => {
    const store = createChallengeProofStore({ now: () => 1000, expirySkewMs: 100 })
    store.set(proof('proof-race'))

    const first = store.reserve(context.action, context.routeKey)
    const second = store.reserve(context.action, context.routeKey)

    expect(first?.proof.proofToken).toBe('proof-race')
    expect(second).toBeNull()
    expect(store.settle(first!.reservationId, 'before_send_cancelled')).toBe(true)
    const restored = store.reserve(context.action, context.routeKey)
    expect(restored).not.toBeNull()
    expect(store.markInFlight(restored!.reservationId)).toBe(true)
    expect(store.settle(restored!.reservationId, 'before_send_cancelled')).toBe(true)
    expect(store.inspect(context.action, context.routeKey)?.state).toBe('consumed')
    expect(store.reserve(context.action, context.routeKey)).toBeNull()
  })

  it.each([
    ['accepted', 'consumed'],
    ['business_rejected', 'consumed'],
    ['unknown_network', 'consumed'],
    ['replayed', 'replayed'],
    ['expired', 'expired'],
    ['binding_mismatch', 'rejected'],
    ['revoked', 'rejected']
  ] as const)('terminates an in-flight proof after %s', (outcome, expectedState) => {
    const store = createChallengeProofStore({ now: () => 1000 })
    store.set(proof(`proof-${outcome}`))
    const reservation = store.reserve(context.action, context.routeKey)!
    store.markInFlight(reservation.reservationId)

    store.settle(reservation.reservationId, outcome)

    expect(store.inspect(context.action, context.routeKey)?.state).toBe(expectedState)
    expect(store.peek(context.action, context.routeKey)).toBeNull()
  })

  it('keeps proof storage free of persistence, URL, broadcast, and logging APIs', () => {
    const source = readFileSync(
      new URL('../../../../src/frontend/src/security/challenge-proof-store.ts', import.meta.url),
      'utf8'
    )

    expect(source).not.toMatch(/localStorage|sessionStorage|BroadcastChannel|URLSearchParams|console\./)
  })
})

function proof(proofToken: string) {
  return {
    action: context.action,
    routeKey: context.routeKey,
    challengeId: 'captcha-race',
    kind: SecurityChallengeKind.CaptchaV1,
    proofToken,
    policyVersion: 'risk-v1',
    verifiedAtUnixMs: 1000,
    expiresAtUnixMs: 10_000
  }
}

function captchaIssueResponse(kind: SecurityChallengeKind = SecurityChallengeKind.CaptchaV1): SecurityChallengeIssueResponse {
  return {
    decision: 'challenge',
    riskScore: 30,
    effectiveRiskScore: 30,
    escalationLevel: 2,
    policyVersion: 'risk-v1',
    retryAfterMs: 0,
    envelope: {
      envelopeId: ENVELOPE_ID,
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

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001'

function memberRequest(challengeId: string) {
  return {
    challengeId,
    kind: SecurityChallengeKind.CaptchaV1,
    action: context.action,
    routeKey: context.routeKey,
    providerPayload: { answerText: 'AEF2' }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
