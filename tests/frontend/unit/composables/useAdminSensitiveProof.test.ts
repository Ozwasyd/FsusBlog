import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adminStepUpPasskeyBegin: vi.fn(),
  adminStepUpPasskeyComplete: vi.fn(),
  startAuthentication: vi.fn()
}))

vi.mock('@/api/auth', () => ({
  adminStepUpPasskeyBegin: mocks.adminStepUpPasskeyBegin,
  adminStepUpPasskeyComplete: mocks.adminStepUpPasskeyComplete
}))

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: mocks.startAuthentication
}))

import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'

type AdminSensitiveProofWindow = Window & {
  __FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__?: string | (() => string | Promise<string>)
}

describe('useAdminSensitiveProof', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Reflect.deleteProperty(window as AdminSensitiveProofWindow, '__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__')
  })

  it('uses an injected non-production admin proof token before starting browser passkey step-up', async () => {
    ;(window as AdminSensitiveProofWindow).__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__ = () => ' proof-admin '

    await expect(useAdminSensitiveProof().ensureAdminSensitiveProof()).resolves.toBe('proof-admin')

    expect(mocks.adminStepUpPasskeyBegin).not.toHaveBeenCalled()
    expect(mocks.startAuthentication).not.toHaveBeenCalled()
    expect(mocks.adminStepUpPasskeyComplete).not.toHaveBeenCalled()
  })

  it('consumes a static injected proof token once', async () => {
    ;(window as AdminSensitiveProofWindow).__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__ = 'proof-once'

    await expect(useAdminSensitiveProof().ensureAdminSensitiveProof()).resolves.toBe('proof-once')

    expect((window as AdminSensitiveProofWindow).__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__).toBeUndefined()
  })
})
