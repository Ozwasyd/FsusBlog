// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import FsusSecurityChallenge from '@/components/security/FsusSecurityChallenge.vue'
import { SecurityChallengeKind, type SecurityChallengeAssignment } from '@/api/security'
import { resolveChallengeCapability } from '@/security/challenge-capability-registry'
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
    const kind = SecurityChallengeKind.Argon2IdPoSpaceV1
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
