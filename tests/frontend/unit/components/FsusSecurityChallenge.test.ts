// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import FsusSecurityChallenge from '@/components/security/FsusSecurityChallenge.vue'
import { SecurityChallengeKind, type SecurityChallengeAssignment } from '@/api/security'
import {
  resolveChallengeCapability,
  type ChallengeCapabilityResolution
} from '@/security/challenge-capability-registry'
import type { SecurityChallengeClient, SecurityChallengeIssueResult } from '@/security/challenge-client'

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

  it('reaches the registered captcha production host', async () => {
    const kind = SecurityChallengeKind.CaptchaV1
    const capability = resolveChallengeCapability(kind, { action: 'comment.create', mode: 'ui' })
    const client = fakeClient({
      status: 'challenge',
      response: null,
      assignment: assignment(kind),
      providerPayload: null,
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

    expect(wrapper.find('[data-test="captcha-host"]').exists()).toBe(true)
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
    expect(host.props('context')).toEqual({ action: 'comment.create', routeKey: 'article:42' })
    expect(host.props('policyVersion')).toBe('policy-v1')
    expect(host.props('executorFactory')).toBe(executorFactory)

    const verified = { verified: true, challengeId: 'challenge-1' }
    const unsupported = {
      status: 'unsupported',
      reason: 'execution_unavailable',
      reissueAttributes: { executionMode: 'headless' }
    }
    host.vm.$emit('verified', verified)
    host.vm.$emit('error', 'verification_failed')
    host.vm.$emit('unsupported', unsupported)
    host.vm.$emit('expired')
    host.vm.$emit('cancel')
    await flushPromises()

    expect(wrapper.emitted('verified')).toEqual([[verified]])
    expect(wrapper.emitted('error')).toEqual([['verification_failed']])
    expect(wrapper.emitted('unsupported')).toEqual([[unsupported]])
    expect(wrapper.emitted('expired')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(client.clearProof).toHaveBeenCalledTimes(2)
  })
})

const componentStubs = {
  ElButton: { template: '<button><slot /></button>' },
  ElAlert: { template: '<div data-test="alert" />' },
  FsusCaptchaChallenge: {
    props: ['action', 'routeKey', 'attributes', 'disabled', 'issueChallenge', 'verifyChallenge'],
    template: '<div data-test="captcha-host" />'
  },
  FsusPerceptionChallenge: {
    props: ['challenge', 'renderer', 'client', 'title', 'eyebrow', 'refreshLabel', 'retryLabel', 'cancelLabel', 'loadingText', 'failedText', 'expiredText'],
    template: '<div data-test="perception-host" />'
  },
  FsusPoSpaceChallenge: {
    name: 'FsusPoSpaceChallenge',
    props: ['assignment', 'providerPayload', 'context', 'policyVersion', 'refresh', 'disabled', 'executorFactory'],
    emits: ['verified', 'error', 'unsupported', 'expired', 'cancel'],
    template: '<div data-test="pospace-host" />'
  }
}

function fakeClient(issueResult: SecurityChallengeIssueResult): SecurityChallengeClient {
  return {
    issue: vi.fn().mockResolvedValue(issueResult),
    refresh: vi.fn().mockResolvedValue(issueResult),
    verify: vi.fn(),
    reserveProof: vi.fn().mockReturnValue(null),
    clearProof: vi.fn()
  }
}
