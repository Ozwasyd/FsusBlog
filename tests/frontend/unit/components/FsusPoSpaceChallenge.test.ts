// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FsusPoSpaceChallenge, {
  type PoSpaceChallengeExecutorFactory,
  type PoSpaceChallengeExecutorLike,
  type PoSpaceExecutorResult
} from '@/components/security/FsusPoSpaceChallenge.vue'
import {
  SecurityChallengeKind,
  type SecurityChallengeAssignment,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse
} from '@/api/security'

const context = {
  action: 'comment.create',
  routeKey: 'article:42'
}

describe('FsusPoSpaceChallenge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the executor through low-information states and emits only the verified result', async () => {
    const response = verifiedResponse('challenge-1')
    const executor = fakeExecutor(async (input) => {
      input.onState?.('solving')
      input.onState?.({ status: 'verifying' })
      return { status: 'verified', response }
    })
    const wrapper = mountChallenge(executor, {
      providerPayload: payload('challenge-1', {
        salt: 'raw-salt-must-stay-hidden',
        hash: 'raw-hash-must-stay-hidden',
        memoryKiB: '262144'
      })
    })

    expect(wrapper.get('[data-test="pospace-status"]').text()).toBe('正在确认验证结果。')
    await flushPromises()

    expect(wrapper.emitted('verified')).toEqual([[response]])
    expect(wrapper.get('[data-test="pospace-status"]').text()).toBe('验证已完成。')
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ policyVersion: 'policy-v1' }))
    expect(executor.dispose).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('raw-salt-must-stay-hidden')
    expect(wrapper.text()).not.toContain('raw-hash-must-stay-hidden')
    expect(wrapper.text()).not.toContain('262144')
    expect(wrapper.text()).not.toContain(response.proofToken)
  })

  it('shows a controlled unsupported state and preserves reissue attributes for the host', async () => {
    const unsupported = {
      status: 'unsupported' as const,
      reason: 'raw-provider-diagnostic',
      reissueAttributes: { executionMode: 'headless' }
    }
    const executor = fakeExecutor(async () => unsupported)
    const wrapper = mountChallenge(executor)
    await flushPromises()

    expect(wrapper.get('[data-test="pospace-status"]').text()).toBe('当前设备无法完成此验证。')
    expect(wrapper.text()).not.toContain('raw-provider-diagnostic')
    expect(wrapper.emitted('unsupported')).toEqual([[unsupported]])
    expect(executor.dispose).toHaveBeenCalledOnce()
  })

  it('disposes replaced work and rejects stale state and verification emissions', async () => {
    const first = deferred<PoSpaceExecutorResult>()
    const second = deferred<PoSpaceExecutorResult>()
    const firstExecutor = fakeExecutor(() => first.promise)
    const secondExecutor = fakeExecutor(() => second.promise)
    const factory = vi.fn<PoSpaceChallengeExecutorFactory>()
      .mockReturnValueOnce(firstExecutor)
      .mockReturnValueOnce(secondExecutor)
    const wrapper = mount(FsusPoSpaceChallenge, {
      props: challengeProps({ executorFactory: factory }),
      global: { stubs: componentStubs }
    })

    await wrapper.setProps({
      assignment: assignment('challenge-2'),
      providerPayload: payload('challenge-2')
    })
    expect(firstExecutor.dispose).toHaveBeenCalledOnce()

    first.resolve({ status: 'verified', response: verifiedResponse('challenge-1') })
    await flushPromises()
    expect(wrapper.emitted('verified')).toBeUndefined()

    const currentResponse = verifiedResponse('challenge-2')
    second.resolve({ status: 'verified', response: currentResponse })
    await flushPromises()
    expect(wrapper.emitted('verified')).toEqual([[currentResponse]])
    expect(secondExecutor.dispose).toHaveBeenCalledOnce()
  })

  it('disposes active work on refresh, cancel, expiry, and unmount', async () => {
    const refreshExecutor = pendingExecutor()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const refreshWrapper = mountChallenge(refreshExecutor, { refresh })
    await refreshWrapper.get('[data-test="pospace-refresh"]').trigger('click')
    expect(refreshExecutor.dispose).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()

    const cancelExecutor = pendingExecutor()
    const cancelWrapper = mountChallenge(cancelExecutor)
    await cancelWrapper.get('[data-test="pospace-cancel"]').trigger('click')
    expect(cancelExecutor.cancel).toHaveBeenCalledOnce()
    expect(cancelExecutor.dispose).toHaveBeenCalledOnce()
    expect(cancelWrapper.emitted('cancel')).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const expiryExecutor = pendingExecutor()
    const expiryWrapper = mountChallenge(expiryExecutor, {
      assignment: assignment('challenge-expiring', 1_050),
      providerPayload: payload('challenge-expiring')
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(expiryExecutor.dispose).toHaveBeenCalledOnce()
    expect(expiryWrapper.emitted('expired')).toHaveLength(1)

    const unmountExecutor = pendingExecutor()
    const unmountWrapper = mountChallenge(unmountExecutor, {
      assignment: assignment('challenge-unmount', 10_000),
      providerPayload: payload('challenge-unmount')
    })
    unmountWrapper.unmount()
    expect(unmountExecutor.dispose).toHaveBeenCalledOnce()
  })
})

const componentStubs = {
  ElButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
  }
}

function mountChallenge(
  executor: PoSpaceChallengeExecutorLike,
  overrides: Partial<ReturnType<typeof challengeProps>> = {}
) {
  return mount(FsusPoSpaceChallenge, {
    props: challengeProps({
      executorFactory: () => executor,
      ...overrides
    }),
    global: { stubs: componentStubs }
  })
}

function challengeProps(overrides: Record<string, unknown> = {}) {
  return {
    assignment: assignment('challenge-1'),
    providerPayload: payload('challenge-1'),
    context,
    policyVersion: 'policy-v1',
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function assignment(challengeId: string, expiresAtUnixMs = Date.now() + 60_000): SecurityChallengeAssignment {
  return {
    challengeId,
    traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    tenantId: 'tenant-main',
    kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
    escalationLevel: 1,
    action: context.action,
    routeKey: context.routeKey,
    subjectHash: 'a'.repeat(64),
    clientIpHash: 'b'.repeat(64),
    deviceFpHash: 'c'.repeat(64),
    issuedAtUnixMs: Date.now(),
    expiresAtUnixMs
  }
}

function payload(challengeId: string, values: Record<string, string> = {}): SecurityChallengeProviderPayload {
  return { challengeId, payload: values }
}

function verifiedResponse(challengeId: string): SecurityChallengeVerifyResponse {
  return {
    verified: true,
    envelopeId: challengeId,
    completedCount: 1,
    memberCount: 1,
    envelopeCompleted: true,
    challengeId,
    kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
    policyVersion: 'policy-v1',
    proofToken: `opaque-proof-${challengeId}`,
    expiresAtUnixMs: Date.now() + 60_000,
    reason: '',
    retryAfterMs: 0
  }
}

function fakeExecutor(
  execute: PoSpaceChallengeExecutorLike['execute']
): PoSpaceChallengeExecutorLike {
  return {
    execute: vi.fn(execute),
    cancel: vi.fn(),
    dispose: vi.fn()
  }
}

function pendingExecutor(): PoSpaceChallengeExecutorLike {
  return fakeExecutor(() => new Promise<PoSpaceExecutorResult>(() => undefined))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => { resolve = resolver })
  return { promise, resolve }
}
