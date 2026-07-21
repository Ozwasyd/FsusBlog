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
import { PerceptionCharacterV3Representation } from '@/contracts/binaryApi'
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
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      proofToken: 'proof-expired',
      policyVersion: 'risk-v1',
      verifiedAtUnixMs: 500,
      expiresAtUnixMs: 900
    })
    const issueChallenge = vi.fn().mockResolvedValue(localizationIssueResponse())
    const verifyChallenge = vi.fn().mockResolvedValue({
      verified: true,
      envelopeId: ENVELOPE_ID,
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
    expect(result.assignment?.kind).toBe(SecurityChallengeKind.PerceptionLocalizationV2)
    expect(issueChallenge).toHaveBeenCalledTimes(1)
    expect(store.peek(context.action, context.routeKey)).toBeNull()

    now = 2000
    await client.verify(context, {
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { x: '192', y: '99' }
    })
    expect(store.peek(context.action, context.routeKey)?.proofToken).toBe('proof-verified')
  })

  it('rejects unknown and executor-free challenge kinds without entering pending UI', async () => {
    const issueChallenge = vi.fn().mockResolvedValue(localizationIssueResponse(SecurityChallengeKind.Unknown))
    const client = createSecurityChallengeClient({ issueChallenge, now: () => 1000 })

    const result = await client.issue(context)

    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('security_challenge_kind_unknown')
    expect(getChallengeKindGroup(SecurityChallengeKind.Argon2IdPoSpaceV1)).toBe('pospace')
    expect(getChallengeKindGroup(SecurityChallengeKind.PasskeyStepUpV1)).toBe('passkey')
  })

  it('routes PoSpace and sha256PowV1 through UI executors while failing closed for incompatible manifests', async () => {
    const poSpace = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse(SecurityChallengeKind.Argon2IdPoSpaceV1)),
      now: () => 1000
    }).issue(context)
    expect(poSpace.status).toBe('challenge')
    expect(poSpace.capability?.executorFactory?.().mode).toBe('universal')
    expect(poSpace.capability?.uiHost).toBe('pospace')

    const sha256Pow = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse(SecurityChallengeKind.Sha256PowV1)),
      now: () => 1000
    }).issue(context)
    expect(sha256Pow.status).toBe('challenge')
    expect(sha256Pow.capability?.executorFactory?.().mode).toBe('universal')
    expect(sha256Pow.capability?.uiHost).toBe('sha256-pow')

    const requestCapabilityReload = vi.fn(() => 'reload_requested' as const)
    const incompatible = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse()),
      requestCapabilityReload,
      now: () => 1000
    }).issue({ ...context, capabilityManifestVersion: 'older-build' })
    expect(incompatible.status).toBe('failed')
    expect(incompatible.reason).toBe('security_challenge_capability_reload_requested')
    expect(requestCapabilityReload).toHaveBeenCalledWith('older-build')

    const executable = await createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse()),
      now: () => 1000
    }).issue(context)
    expect(executable.status).toBe('challenge')
    expect(executable.capability?.policyEligible).toBe(true)
  })

  it('turns the capability-manifest 409 into one explicit full reload action without retrying or fallback', async () => {
    const issueChallenge = vi.fn().mockRejectedValue(
      new Error('security_challenge_client_capability_incompatible')
    )
    const requestCapabilityReload = vi.fn(() => 'reload_requested' as const)
    const client = createSecurityChallengeClient({ issueChallenge, requestCapabilityReload })

    const result = await client.issue(context)

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('security_challenge_capability_reload_requested')
    expect(requestCapabilityReload).toHaveBeenCalledTimes(1)
    expect(requestCapabilityReload).toHaveBeenCalledWith(SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION)
    expect(issueChallenge).toHaveBeenCalledTimes(1)
  })

  it('fails closed after an old build already requested its reload', async () => {
    const issueChallenge = vi.fn().mockRejectedValue(
      new Error('security_challenge_client_capability_incompatible')
    )
    const requestCapabilityReload = vi.fn(() => 'already_requested' as const)

    const result = await createSecurityChallengeClient({ issueChallenge, requestCapabilityReload }).issue(context)

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('security_challenge_capability_reload_suppressed')
    expect(issueChallenge).toHaveBeenCalledTimes(1)
  })

  it('covers known, provider, executor, host and policy state for every enum member', () => {
    const expected = [
      [SecurityChallengeKind.Unknown, false, false, false, false, false],
      [SecurityChallengeKind.Sha256PowV1, true, true, true, true, true],
      [SecurityChallengeKind.Argon2IdPoSpaceV1, true, true, true, true, true],
      [SecurityChallengeKind.PerceptionLocalizationV2, true, true, true, true, true],
      [SecurityChallengeKind.HumanReadProofV1, true, true, false, false, false],
      [SecurityChallengeKind.PasskeyStepUpV1, true, true, false, false, false],
      [SecurityChallengeKind.AdminPasskeyStepUpV1, true, true, false, false, false],
      [SecurityChallengeKind.RecoveryKeyProofV1, true, false, false, false, false],
      [SecurityChallengeKind.AnonymousCredentialProofV1, true, false, false, false, false],
      [SecurityChallengeKind.ZkAnonymousCommentProofV1, true, false, false, false, false],
      [SecurityChallengeKind.PerceptionLocalizationV2, true, true, true, true, true],
      [SecurityChallengeKind.PerceptionMicroInteractionV2, true, true, true, true, true],
      [SecurityChallengeKind.PerceptionCharacterV3, true, true, true, true, true]
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

  it.each([3, 10, 13])('fails closed for retired numeric challenge kind %i', (retiredKind) => {
    const state = resolveChallengeCapability(retiredKind as SecurityChallengeKind, {
      action: context.action,
      mode: 'ui',
      manifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
    })

    expect(state.kind).toBe(SecurityChallengeKind.Unknown)
    expect(state.kindKnown).toBe(false)
    expect(state.policyEligible).toBe(false)
    expect(getChallengeKindGroup(retiredKind as SecurityChallengeKind)).toBe('unsupported')
  })

  it('normalizes failed verification without caching proof', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const verifyChallenge = vi.fn().mockResolvedValue({
      verified: false,
      envelopeId: ENVELOPE_ID,
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      policyVersion: 'risk-v1',
      completedCount: 1,
      memberCount: 1,
      envelopeCompleted: false,
      proofToken: '',
      expiresAtUnixMs: 0,
      reason: 'perception_invalid',
      retryAfterMs: 2000
    } satisfies SecurityChallengeVerifyResponse)
    const client = createSecurityChallengeClient({
      proofStore: store,
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse()),
      verifyChallenge,
      now: () => 1000
    })

    await client.issue(context)

    const result = await client.verify(context, {
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      action: context.action,
      routeKey: context.routeKey,
      providerPayload: { x: '-1', y: '-1' }
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('rejected')
    expect(store.peek(context.action, context.routeKey)).toBeNull()
  })

  it('runs envelope members in order and stores only the final aggregate proof', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const response = localizationIssueResponse()
    const second = {
      ...response.envelope!.assignments[0]!,
      challengeId: 'localization-2'
    }
    response.envelope!.assignments.push(second)
    response.providerPayloads.push({ challengeId: 'localization-2', payload: { algorithm: 'second' } })
    const verifyChallenge = vi.fn()
      .mockResolvedValueOnce({
        verified: true,
        envelopeId: ENVELOPE_ID,
        challengeId: 'localization-1',
        kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
        challengeId: 'localization-2',
        kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
    const first = await client.verify(context, memberRequest('localization-1'))

    expect(issued.assignment?.challengeId).toBe('localization-1')
    expect(first.status).toBe('continue')
    expect(first.next?.assignment?.challengeId).toBe('localization-2')
    expect(first.proof).toBeNull()
    expect(store.peek(context.action, context.routeKey)).toBeNull()

    const final = await client.verify(context, memberRequest('localization-2'))
    expect(final.status).toBe('verified')
    expect(final.proof?.proofToken).toBe('aggregate-proof')
    expect(store.peek(context.action, context.routeKey)?.challengeId).toBe('localization-2')
    expect(verifyChallenge.mock.calls.map(([request]) => request.envelopeId)).toEqual([ENVELOPE_ID, ENVELOPE_ID])
  })

  it('rejects out-of-order members and cancels a replaced envelope before transport', async () => {
    const firstIssue = localizationIssueResponse()
    firstIssue.envelope!.assignments.push({
      ...firstIssue.envelope!.assignments[0]!,
      challengeId: 'localization-2'
    })
    const replacement = localizationIssueResponse()
    replacement.envelope = {
      ...replacement.envelope!,
      envelopeId: '01900000-0000-7000-8000-000000000002',
      assignments: [{ ...replacement.envelope!.assignments[0]!, challengeId: 'localization-new' }]
    }
    replacement.providerPayloads = [{ challengeId: 'localization-new', payload: { algorithm: 'replacement' } }]
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(firstIssue)
      .mockResolvedValueOnce(replacement)
    const verifyChallenge = vi.fn()
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ cancelChallenge, issueChallenge, verifyChallenge, now: () => 1000 })

    await client.issue(context)
    const outOfOrder = await client.verify(context, memberRequest('localization-2'))
    expect(outOfOrder.reason).toBe('security_challenge_member_mismatch')
    expect(verifyChallenge).not.toHaveBeenCalled()

    await client.refresh(context)
    const stale = await client.verify(context, memberRequest('localization-1'))
    expect(stale.reason).toBe('security_challenge_member_mismatch')
    expect(verifyChallenge).not.toHaveBeenCalled()

    client.cancelEnvelope(context)
    const cancelled = await client.verify(context, memberRequest('localization-new'))
    expect(cancelled.reason).toBe('security_challenge_envelope_missing')
    expect(verifyChallenge).not.toHaveBeenCalled()
    expect(cancelChallenge).toHaveBeenNthCalledWith(1, expect.objectContaining({
      envelopeId: ENVELOPE_ID,
      action: context.action,
      routeKey: context.routeKey,
      policyVersion: 'risk-v1'
    }))
    expect(cancelChallenge).toHaveBeenNthCalledWith(2, expect.objectContaining({
      envelopeId: '01900000-0000-7000-8000-000000000002'
    }))
  })

  it('atomically switches V3 representation with the old opaque identity and no pre-cancel', async () => {
    const first = perceptionCharacterV3IssueResponse('visual', 1)
    const replacement = perceptionCharacterV3IssueResponse('audio', 2)
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ issueChallenge, cancelChallenge, now: () => 2_000 })

    await expect(client.issue(context)).resolves.toMatchObject({
      status: 'challenge', assignment: { challengeId: 'character-v3-1' }
    })
    await expect(client.replace(context, 'audio')).resolves.toMatchObject({
      status: 'challenge', assignment: { challengeId: 'character-v3-2' }
    })

    expect(cancelChallenge).not.toHaveBeenCalled()
    expect(issueChallenge).toHaveBeenNthCalledWith(2, expect.objectContaining({
      representation: 'audio',
      replacement: {
        challengeId: 'character-v3-1',
        envelopeId: ENVELOPE_ID,
        stateToken: 'opaque-state-1'
      }
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('revokes the old V3 envelope when atomic replacement fails', async () => {
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(perceptionCharacterV3IssueResponse('visual', 1))
      .mockRejectedValueOnce(new Error('raw upstream secret'))
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ issueChallenge, cancelChallenge, now: () => 2_000 })

    await client.issue(context)
    await expect(client.replace(context, 'audio')).resolves.toMatchObject({
      status: 'failed', reason: 'security_challenge_issue_failed'
    })

    expect(cancelChallenge).toHaveBeenCalledOnce()
    expect(cancelChallenge).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: ENVELOPE_ID }))
    client.cancelEnvelope(context)
    expect(cancelChallenge).toHaveBeenCalledOnce()
  })

  it('fails closed and revokes the old V3 envelope when replacement unexpectedly allows', async () => {
    const allow = { ...perceptionCharacterV3IssueResponse('visual', 2), decision: 'allow' as const }
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(perceptionCharacterV3IssueResponse('visual', 1))
      .mockResolvedValueOnce(allow)
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ issueChallenge, cancelChallenge, now: () => 2_000 })

    await client.issue(context)
    await expect(client.replace(context, 'audio')).resolves.toMatchObject({
      status: 'failed', reason: 'security_challenge_issue_failed'
    })
    expect(cancelChallenge).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: ENVELOPE_ID }))
  })

  it('keeps the old V3 run addressable until an aborted replacement revokes it', async () => {
    const replacement = deferred<SecurityChallengeIssueResponse>()
    let replacementSignal: AbortSignal | undefined
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(perceptionCharacterV3IssueResponse('visual', 1))
      .mockImplementationOnce((_request, config) => {
        replacementSignal = config?.signal
        return replacement.promise
      })
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ issueChallenge, cancelChallenge, now: () => 2_000 })

    await client.issue(context)
    const pendingReplacement = client.replace(context, 'audio')
    client.cancelEnvelope(context)
    expect(replacementSignal?.aborted).toBe(true)
    expect(cancelChallenge).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: ENVELOPE_ID }))

    replacement.resolve(perceptionCharacterV3IssueResponse('audio', 2))
    await expect(pendingReplacement).resolves.toMatchObject({
      status: 'failed', reason: 'security_challenge_request_cancelled'
    })
    expect(cancelChallenge).toHaveBeenCalledTimes(2)
    expect(cancelChallenge).toHaveBeenNthCalledWith(2, expect.objectContaining({
      envelopeId: '01900000-0000-7000-8000-000000000002'
    }))
  })

  it('maps transport and backend verification reasons to stable local codes', async () => {
    const issueFailureClient = createSecurityChallengeClient({
      issueChallenge: vi.fn().mockRejectedValue(new Error('database host and token'))
    })
    await expect(issueFailureClient.issue(context)).resolves.toMatchObject({
      status: 'failed', reason: 'security_challenge_issue_failed'
    })

    const responseClient = createSecurityChallengeClient({
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse()),
      verifyChallenge: vi.fn().mockResolvedValue({
        verified: false,
        envelopeId: ENVELOPE_ID,
        challengeId: 'localization-1',
        kind: SecurityChallengeKind.PerceptionLocalizationV2,
        policyVersion: 'risk-v1',
        completedCount: 1,
        memberCount: 1,
        envelopeCompleted: false,
        proofToken: '',
        expiresAtUnixMs: 0,
        reason: 'postgres_internal_reason',
        retryAfterMs: 0
      } satisfies SecurityChallengeVerifyResponse)
    })
    await responseClient.issue(context)
    await expect(responseClient.verify(context, memberRequest('localization-1'))).resolves.toMatchObject({
      status: 'failed', reason: 'rejected', response: { reason: 'rejected' }
    })
  })

  it('refreshes V3 in the same representation through the backend replacement contract', async () => {
    const issueChallenge = vi.fn()
      .mockResolvedValueOnce(perceptionCharacterV3IssueResponse('visual', 1))
      .mockResolvedValueOnce(perceptionCharacterV3IssueResponse('visual', 2))
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({ issueChallenge, cancelChallenge, now: () => 2_000 })

    await client.issue(context)
    await client.refresh(context, 'visual')

    expect(cancelChallenge).not.toHaveBeenCalled()
    expect(issueChallenge).toHaveBeenNthCalledWith(2, expect.objectContaining({
      representation: 'visual',
      replacement: {
        challengeId: 'character-v3-1',
        envelopeId: ENVELOPE_ID,
        stateToken: 'opaque-state-1'
      }
    }), expect.any(Object))
  })

  it('aborts and tombstones an out-of-order issue response after refresh', async () => {
    const first = deferred<SecurityChallengeIssueResponse>()
    const second = deferred<SecurityChallengeIssueResponse>()
    let firstSignal: AbortSignal | undefined
    const replacement = localizationIssueResponse()
    replacement.envelope = {
      ...replacement.envelope!,
      envelopeId: '01900000-0000-7000-8000-000000000002',
      assignments: [{ ...replacement.envelope!.assignments[0]!, challengeId: 'localization-new' }]
    }
    replacement.providerPayloads = [{ challengeId: 'localization-new', payload: { algorithm: 'replacement' } }]
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
    await expect(currentRun).resolves.toMatchObject({ status: 'challenge', assignment: { challengeId: 'localization-new' } })
    first.resolve(localizationIssueResponse())
    await expect(staleRun).resolves.toMatchObject({ status: 'failed', reason: 'security_challenge_request_cancelled' })

    const staleVerify = await client.verify(context, memberRequest('localization-1'))
    expect(staleVerify.reason).toBe('security_challenge_member_mismatch')
  })

  it('does not store a late verify response after cancel or route generation change', async () => {
    const store = createChallengeProofStore({ now: () => 1000 })
    const verification = deferred<SecurityChallengeVerifyResponse>()
    let verifySignal: AbortSignal | undefined
    const cancelChallenge = vi.fn().mockResolvedValue(null)
    const client = createSecurityChallengeClient({
      cancelChallenge,
      proofStore: store,
      issueChallenge: vi.fn().mockResolvedValue(localizationIssueResponse()),
      verifyChallenge: vi.fn().mockImplementation((_request, config) => {
        verifySignal = config?.signal
        return verification.promise
      }),
      now: () => 1000
    })
    await client.issue(context)

    const pending = client.verify(context, memberRequest('localization-1'))
    client.cancelEnvelope(context)
    expect(verifySignal?.aborted).toBe(true)
    verification.resolve({
      verified: true,
      envelopeId: ENVELOPE_ID,
      challengeId: 'localization-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
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
    expect(cancelChallenge).toHaveBeenCalledOnce()
  })

  it('sends the current capability manifest with every generic issue request', async () => {
    const issueChallenge = vi.fn().mockResolvedValue(localizationIssueResponse())
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

})

function proof(proofToken: string) {
  return {
    action: context.action,
    routeKey: context.routeKey,
    challengeId: 'localization-race',
    kind: SecurityChallengeKind.PerceptionLocalizationV2,
    proofToken,
    policyVersion: 'risk-v1',
    verifiedAtUnixMs: 1000,
    expiresAtUnixMs: 10_000
  }
}

function localizationIssueResponse(kind: SecurityChallengeKind = SecurityChallengeKind.PerceptionLocalizationV2): SecurityChallengeIssueResponse {
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
        challengeId: 'localization-1',
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
      challengeId: 'localization-1',
      payload: { algorithm: 'fsu.challenge/perception-sealed@v2', taskKind: 'localization', recipeJson: '{}', recipeHashHex: 'd'.repeat(64), sealedToken: 'sealed-token', signatureHex: 'e'.repeat(64) }
    }]
  }
}

function perceptionCharacterV3IssueResponse(
  representation: 'visual' | 'audio',
  identity: number
): SecurityChallengeIssueResponse {
  const challengeId = `character-v3-${identity}`
  const envelopeId = identity === 1
    ? ENVELOPE_ID
    : `01900000-0000-7000-8000-${String(identity).padStart(12, '0')}`
  const visual = representation === 'visual'
  return {
    decision: 'challenge',
    riskScore: 30,
    effectiveRiskScore: 30,
    escalationLevel: 2,
    policyVersion: 'risk-v1',
    retryAfterMs: 0,
    envelope: {
      envelopeId,
      policyVersion: 'risk-v1',
      assignments: [{
        challengeId,
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        tenantId: 'tenant-main',
        kind: SecurityChallengeKind.PerceptionCharacterV3,
        escalationLevel: 2,
        action: context.action,
        routeKey: context.routeKey,
        subjectHash: 'a'.repeat(64),
        clientIpHash: 'b'.repeat(64),
        deviceFpHash: 'c'.repeat(64),
        issuedAtUnixMs: 1_000,
        expiresAtUnixMs: 300_000
      }]
    },
    providerPayloads: [{
      challengeId,
      payload: {},
      perceptionCharacterV3: {
        algorithm: 'fsu.challenge/perception-character-raster@v3',
        challengeId,
        envelopeId,
        representation: visual
          ? PerceptionCharacterV3Representation.Visual
          : PerceptionCharacterV3Representation.Audio,
        mediaType: visual ? 'application/x-fsus-gray8' : 'audio/wav',
        mediaBytes: visual ? new Uint8Array(512 * 192) : new Uint8Array([1, 2, 3]),
        physicalWidth: visual ? 512 : 0,
        physicalHeight: visual ? 192 : 0,
        displayWidth: visual ? 320 : 0,
        displayHeight: visual ? 120 : 0,
        attemptBudget: 2,
        policyVersion: 'risk-v1',
        issuedAtUnixMs: 1_000,
        expiresAtUnixMs: 300_000,
        stateToken: `opaque-state-${identity}`
      }
    }]
  }
}

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001'

function memberRequest(challengeId: string) {
  return {
    challengeId,
    kind: SecurityChallengeKind.PerceptionLocalizationV2,
    action: context.action,
    routeKey: context.routeKey,
    providerPayload: { x: '192', y: '99' }
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
