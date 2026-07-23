// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FsusSecurityChallenge from '@/components/security/FsusSecurityChallenge.vue'
import { SecurityChallengeKind, type SecurityChallengeAssignment } from '@/api/security'
import { PerceptionCharacterV3Representation } from '@/contracts/binaryApi'
import { canonicalPerceptionCharacterV3Png } from '../../helpers/perceptionCharacterV3Media'
import {
  SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  resolveChallengeCapability,
  type ChallengeCapabilityResolution
} from '@/security/challenge-capability-registry'
import type { SecurityChallengeClient, SecurityChallengeIssueResult } from '@/security/challenge-client'
import { setLocale } from '@/locales'

vi.mock('@/fsusui/perceptionCharacterChallenge', async () => {
  const { defineComponent, h } = await import('vue')
  const character = defineComponent({
    name: 'FsusPerceptionCharacterChallenge',
    props: ['challengeId', 'state', 'media', 'modelValue'],
    emits: ['update:modelValue', 'submit', 'refresh', 'retry', 'reissue'],
    setup: () => () => h('div', { 'data-test': 'perception-character-host', role: 'status' })
  })
  return {
    FsusUiPerceptionCharacterChallenge: character,
    FsusPerceptionChallenge: defineComponent({
      name: 'FsusPerceptionChallenge',
      setup: () => () => h('div', { 'data-test': 'perception-host' })
    })
  }
})

afterEach(() => setLocale('zh-CN'))

const assignment = (kind: SecurityChallengeKind): SecurityChallengeAssignment => ({
  challengeId: 'challenge-1',
  traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
  tenantId: 'tenant-main',
  kind,
  escalationLevel: 1,
  action: 'comment.create',
  routeKey: 'article:42',
  subjectHash: 'a'.repeat(64),
  clientIpHash: 'b'.repeat(64),
  deviceFpHash: 'c'.repeat(64),
  issuedAtUnixMs: 1_000,
  expiresAtUnixMs: 10_000
})

describe('FsusSecurityChallenge capability dispatch', () => {
  it('shows the capability-update action instead of offering a legacy fallback', async () => {
    const client = fakeClient({
      ...unsupportedIssueResult('security_challenge_capability_reload_requested'),
      status: 'failed'
    })
    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', client },
      global: { stubs: componentStubs }
    })

    await flushPromises()

    expect(wrapper.find('[data-test="alert"]').text()).toBe('验证能力已更新，正在重新载入当前页面。')
    expect(wrapper.find('[data-test="security-challenge-unsupported"]').exists()).toBe(false)
    expect(wrapper.emitted('error')).toEqual([['security_challenge_capability_reload_requested']])
    expect(client.refresh).not.toHaveBeenCalled()
  })

  it('renders all shared challenge copy from the active English locale', async () => {
    setLocale('en-US')
    const wrapper = mount(FsusSecurityChallenge, {
      props: {
        action: 'comment.create',
        routeKey: 'article:42',
        client: fakeClient(unsupportedIssueResult('raw_backend_detail'))
      },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Complete security verification')
    expect(wrapper.text()).toContain('This verification method is not supported.')
    expect(wrapper.text()).not.toContain('raw_backend_detail')
    expect(wrapper.emitted('error')).toEqual([['security_challenge_unsupported']])
  })

  it('renders a controlled unavailable state instead of placeholder or permanent pending UI', async () => {
    const kind = SecurityChallengeKind.PasskeyStepUpV1
    const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
    const client = fakeClient({
      status: 'unsupported',
      response: null,
      assignment: assignment(kind),
      providerPayload: null,
      proof: null,
      kindGroup: capability.group,
      capability,
      reason: 'security_challenge_executor_unavailable',
      retryAfterMs: 0
    })

    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', client },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    expect(wrapper.find('[data-test="security-challenge-unsupported"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('正在准备')
    expect(wrapper.find('[data-fsus-pow-challenge]').exists()).toBe(false)
    expect(wrapper.find('[data-fsus-pospace-challenge]').exists()).toBe(false)
    expect(wrapper.find('[data-fsus-passkey-step-up-challenge]').exists()).toBe(false)
  })

  it('reaches the registered localization production host', async () => {
    const kind = SecurityChallengeKind.PerceptionLocalizationV2
    const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
    const client = fakeClient({
      status: 'challenge',
      response: {
        decision: 'challenge', riskScore: 0, effectiveRiskScore: 0, escalationLevel: 1,
        policyVersion: 'policy-v2', retryAfterMs: 0,
        envelope: { envelopeId: '01900000-0000-7000-8000-000000000001', policyVersion: 'policy-v2', assignments: [assignment(kind)] },
        providerPayloads: []
      },
      assignment: assignment(kind),
      providerPayload: {
        challengeId: 'challenge-1',
        payload: {
          algorithm: 'fsu.challenge/perception-sealed@v2',
          taskKind: 'localization',
          recipeJson: JSON.stringify({ schema: 'fsus.challenge.render-recipe@v2', taskKind: 'localization', layers: [] }),
          recipeHashHex: 'd'.repeat(64),
          sealedToken: 'sealed-token',
          signatureHex: 'e'.repeat(64)
        }
      },
      proof: null,
      kindGroup: capability.group,
      capability,
      reason: null,
      retryAfterMs: 0
    })

    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', client },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    expect(wrapper.find('[data-test="perception-host"]').exists()).toBe(true)
  })

  it('renders the PoSpace host and forwards all terminal events', async () => {
    const kind = SecurityChallengeKind.Argon2IdPoSpaceV1
    const capability = {
      ...resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' }),
      uiHost: 'pospace',
      executorAvailable: true,
      hostAvailable: true,
      policyEligible: true,
      unavailableReason: null
    } as unknown as ChallengeCapabilityResolution
    const issueResult: SecurityChallengeIssueResult = {
      status: 'challenge',
      response: {
        decision: 'challenge',
        riskScore: 0,
        effectiveRiskScore: 0,
        escalationLevel: 1,
        policyVersion: 'policy-v1',
        retryAfterMs: 0,
        envelope: null,
        providerPayloads: []
      },
      assignment: assignment(kind),
      providerPayload: { challengeId: 'challenge-1', payload: {} },
      proof: null,
      kindGroup: capability.group,
      capability,
      reason: null,
      retryAfterMs: 0
    }
    const client = fakeClient(issueResult)
    const executorFactory = vi.fn()
    const wrapper = mount(FsusSecurityChallenge, {
      props: {
        action: 'comment.create',
        routeKey: 'article:42',
        client,
        executorFactory
      },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    const host = wrapper.findComponent({ name: 'FsusPoSpaceChallenge' })
    expect(host.exists()).toBe(true)
    expect(host.props('context')).toEqual({
      action: 'comment.create',
      routeKey: 'article:42',
      capabilityManifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
      identity: undefined
    })
    expect(host.props('policyVersion')).toBe('policy-v1')
    expect(host.props('executorFactory')).toBe(executorFactory)

    const nextAssignment = { ...assignment(kind), challengeId: 'challenge-2' }
    host.vm.$emit('continued', {
      ...issueResult,
      assignment: nextAssignment,
      providerPayload: { challengeId: 'challenge-2', payload: {} }
    })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'FsusPoSpaceChallenge' }).props('assignment')).toEqual(nextAssignment)

    const verified = { verified: true, challengeId: 'challenge-1' }
    const unsupported = {
      status: 'unsupported',
      reason: 'execution_unavailable',
      reissueAttributes: { executionMode: 'headless' }
    }
    const continuedHost = wrapper.findComponent({ name: 'FsusPoSpaceChallenge' })
    continuedHost.vm.$emit('verified', verified)
    continuedHost.vm.$emit('error', 'verification_failed')
    continuedHost.vm.$emit('unsupported', unsupported)
    continuedHost.vm.$emit('expired')
    continuedHost.vm.$emit('cancel')
    await flushPromises()

    expect(wrapper.emitted('verified')).toEqual([[verified]])
    expect(wrapper.emitted('error')).toEqual([['security_challenge_verify_failed']])
    expect(wrapper.emitted('unsupported')).toEqual([[unsupported]])
    expect(wrapper.emitted('expired')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(client.clearProof).toHaveBeenCalledTimes(2)
  })

  it('dispatches sha256PowV1 to the registered UI host and continues the ordered envelope', async () => {
    const kind = SecurityChallengeKind.Sha256PowV1
    const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
    const issueResult: SecurityChallengeIssueResult = {
      status: 'challenge',
      response: {
        decision: 'challenge',
        riskScore: 50,
        effectiveRiskScore: 50,
        escalationLevel: 2,
        policyVersion: 'policy-v1',
        retryAfterMs: 0,
        envelope: null,
        providerPayloads: []
      },
      assignment: assignment(kind),
      providerPayload: {
        challengeId: 'challenge-1',
        payload: { salt: 'salt', difficulty: '4', timestamp: '1', signature: 'signature' }
      },
      proof: null,
      kindGroup: capability.group,
      capability,
      reason: null,
      retryAfterMs: 0
    }
    const client = fakeClient(issueResult)
    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', client },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    const host = wrapper.findComponent({ name: 'FsusPowChallenge' })
    expect(host.exists()).toBe(true)
    expect(host.props('client')).toMatchObject({ verify: client.verify, cancelEnvelope: client.cancelEnvelope })
    expect(host.props('context')).toMatchObject({
      action: 'comment.create',
      routeKey: 'article:42',
      capabilityManifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
    })

    const next = {
      ...issueResult,
      assignment: { ...assignment(SecurityChallengeKind.PerceptionLocalizationV2), challengeId: 'challenge-2' },
      providerPayload: {
        challengeId: 'challenge-2',
        payload: { algorithm: 'fsu.challenge/perception-sealed@v2', taskKind: 'localization', recipeJson: '{}' }
      },
      capability: resolveChallengeCapability(SecurityChallengeKind.PerceptionLocalizationV2, { action: 'comment.create', mode: 'ui' })
    }
    host.vm.$emit('continued', next)
    await flushPromises()
    expect(wrapper.find('[data-test="perception-host"]').exists()).toBe(true)
  })

  it('invalidates late issue responses after identity or route changes and unmount', async () => {
    const late = deferred<SecurityChallengeIssueResult>()
    const current = unsupportedIssueResult('current')
    const client = fakeClient(current)
    vi.mocked(client.issue)
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', identity: 'mutation-a', client },
      global: { stubs: componentStubs }
    })

    await wrapper.setProps({ identity: 'mutation-b' })
    await flushPromises()
    expect(client.cancelEnvelope).toHaveBeenCalledWith({
      action: 'comment.create',
      routeKey: 'article:42',
      identity: 'mutation-a'
    })

    await wrapper.setProps({ routeKey: 'article:43' })
    await flushPromises()
    expect(client.cancelEnvelope).toHaveBeenCalledWith({
      action: 'comment.create',
      routeKey: 'article:42',
      identity: 'mutation-b'
    })

    late.resolve(unsupportedIssueResult('stale'))
    await flushPromises()
    expect(wrapper.emitted('error')).toEqual([
      ['security_challenge_unsupported'],
      ['security_challenge_unsupported']
    ])

    wrapper.unmount()
    expect(client.cancelEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      routeKey: 'article:43',
      identity: 'mutation-b'
    }))
  })

  it('renders typed V3 media through the FsusUI character adapter and keeps retryable state local', async () => {
    const kind = SecurityChallengeKind.PerceptionCharacterV3
    const currentAssignment = {
      ...assignment(kind),
      issuedAtUnixMs: Date.now() - 1_000,
      expiresAtUnixMs: Date.now() + 60_000
    }
    const payload = {
      algorithm: 'fsu.challenge/perception-character-artifact@v3' as const,
      challengeId: currentAssignment.challengeId,
      envelopeId: '01900000-0000-7000-8000-000000000001',
      representation: PerceptionCharacterV3Representation.Visual,
      mediaType: 'image/png' as const,
      mediaBytes: canonicalPerceptionCharacterV3Png(),
      physicalWidth: 384,
      physicalHeight: 144,
      displayWidth: 320,
      displayHeight: 120,
      attemptBudget: 2 as const,
      policyVersion: 'policy-v3',
      issuedAtUnixMs: currentAssignment.issuedAtUnixMs,
      expiresAtUnixMs: currentAssignment.expiresAtUnixMs,
      stateToken: 'opaque-state'
    }
    const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
    const issueResult: SecurityChallengeIssueResult = {
      status: 'challenge',
      response: {
        decision: 'challenge', riskScore: 0, effectiveRiskScore: 0, escalationLevel: 1,
        policyVersion: 'policy-v3', retryAfterMs: 0,
        envelope: { envelopeId: payload.envelopeId, policyVersion: 'policy-v3', assignments: [currentAssignment] },
        providerPayloads: []
      },
      assignment: currentAssignment,
      providerPayload: { challengeId: currentAssignment.challengeId, payload: {}, perceptionCharacterV3: payload },
      proof: null,
      kindGroup: 'perception',
      capability,
      reason: null,
      retryAfterMs: 0
    }
    const client = fakeClient(issueResult)
    vi.mocked(client.verify).mockResolvedValue({
      status: 'failed', proof: null, next: null, reason: 'retryable', retryAfterMs: 0,
      response: {
        verified: false, envelopeId: payload.envelopeId, challengeId: currentAssignment.challengeId,
        kind, policyVersion: 'policy-v3', completedCount: 0, memberCount: 1,
        envelopeCompleted: false, proofToken: '', expiresAtUnixMs: 0, reason: 'retryable', retryAfterMs: 0
      }
    })

    const wrapper = mount(FsusSecurityChallenge, {
      props: { action: 'comment.create', routeKey: 'article:42', client, dialogComposition: true },
      global: { stubs: componentStubs }
    })
    await flushPromises()

    const host = wrapper.findComponent({ name: 'FsusPerceptionCharacterChallenge' })
    expect(host.exists()).toBe(true)
    expect(host.props('state')).toBe('ready')
    expect(host.props('media').raster).toMatchObject({ kind: 'image-url', width: 320, height: 120 })
    host.vm.$emit('submit', { kind: 'character', value: 'AB12', challengeId: currentAssignment.challengeId })
    await flushPromises()
    expect(host.props('state')).toBe('retryable')
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0)
    expect(wrapper.find('.fsus-security-challenge__header').exists()).toBe(false)
  })
})

const componentStubs = {
  ElButton: { template: '<button><slot /></button>' },
  ElAlert: { props: ['title'], template: '<div data-test="alert">{{ title }}</div>' },
  FsusPerceptionChallenge: {
    props: ['challenge', 'renderer', 'client', 'title', 'eyebrow', 'refreshLabel', 'retryLabel', 'cancelLabel', 'loadingText', 'failedText', 'expiredText'],
    template: '<div data-test="perception-host" />'
  },
  FsusPerceptionCharacterChallenge: {
    name: 'FsusPerceptionCharacterChallenge',
    props: ['challengeId', 'state', 'media', 'modelValue'],
    emits: ['update:modelValue', 'submit', 'refresh', 'retry', 'reissue'],
    template: '<div data-test="perception-character-host" role="status" />'
  },
  FsusPoSpaceChallenge: {
    name: 'FsusPoSpaceChallenge',
    props: ['assignment', 'providerPayload', 'context', 'policyVersion', 'refresh', 'disabled', 'executorFactory'],
    emits: ['verified', 'continued', 'error', 'unsupported', 'expired', 'cancel'],
    template: '<div data-test="pospace-host" />'
  },
  FsusPowChallenge: {
    name: 'FsusPowChallenge',
    props: ['assignment', 'providerPayload', 'context', 'client', 'refresh', 'disabled'],
    emits: ['verified', 'continued', 'error', 'expired', 'cancel'],
    template: '<div data-test="pow-host" />'
  }
}

function fakeClient(issueResult: SecurityChallengeIssueResult): SecurityChallengeClient {
  return {
    issue: vi.fn().mockResolvedValue(issueResult),
    refresh: vi.fn().mockResolvedValue(issueResult),
    replace: vi.fn().mockResolvedValue(issueResult),
    verify: vi.fn(),
    reserveProof: vi.fn().mockReturnValue(null),
    cancelEnvelope: vi.fn(),
    clearProof: vi.fn()
  }
}

function unsupportedIssueResult(reason: string): SecurityChallengeIssueResult {
  const kind = SecurityChallengeKind.PasskeyStepUpV1
  const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
  return {
    status: 'unsupported',
    response: null,
    assignment: assignment(kind),
    providerPayload: null,
    proof: null,
    kindGroup: capability.group,
    capability,
    reason,
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
