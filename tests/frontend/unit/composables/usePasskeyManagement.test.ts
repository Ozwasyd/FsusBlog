import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
  listPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
  renamePasskey: vi.fn(),
  getPasskeySignalState: vi.fn(),
  commitAndReconcile: vi.fn()
}))

vi.mock('@simplewebauthn/browser', () => ({ startRegistration: mocks.startRegistration }))
vi.mock('@/api/auth', () => ({
  passkeyRegisterBegin: mocks.passkeyRegisterBegin,
  passkeyRegisterComplete: mocks.passkeyRegisterComplete,
  listPasskeys: mocks.listPasskeys,
  deletePasskey: mocks.deletePasskey,
  renamePasskey: mocks.renamePasskey,
  getPasskeySignalState: mocks.getPasskeySignalState
}))
vi.mock('@/services/webauthnSignal', () => ({
  webauthnSignalService: { commitAndReconcile: mocks.commitAndReconcile }
}))

describe('usePasskeyManagement WebAuthn Signal integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.commitAndReconcile.mockImplementation(async (commit: () => Promise<unknown>) => await commit())
    mocks.passkeyRegisterBegin.mockResolvedValue({
      sessionKey: 'session-1',
      options: { rp: { id: 'example.test' }, challenge: 'challenge' }
    })
    mocks.startRegistration.mockResolvedValue({ id: 'credential-a' })
    mocks.passkeyRegisterComplete.mockResolvedValue({ revision: 2 })
    mocks.listPasskeys.mockResolvedValue([])
    mocks.deletePasskey.mockResolvedValue({ revision: 3 })
  })

  it('serializes registration commit and authoritative reconciliation', async () => {
    const { usePasskeyManagement } = await import('@/composables/usePasskeyManagement')
    const { addPasskey, error } = usePasskeyManagement(mocks.startRegistration)

    const result = await addPasskey('Laptop')
    expect(error.value).toBeNull()
    expect(result).toBe(true)
    expect(mocks.passkeyRegisterComplete).toHaveBeenCalledOnce()
    expect(mocks.commitAndReconcile).toHaveBeenCalledWith(
      expect.any(Function),
      mocks.getPasskeySignalState,
      expect.objectContaining({ currentUserDetails: true, revisionOf: expect.any(Function) })
    )
  })

  it('uses the server-authoritative remaining credential set after deletion', async () => {
    const { usePasskeyManagement } = await import('@/composables/usePasskeyManagement')
    const { credentials, removePasskey } = usePasskeyManagement()
    credentials.value = [{
      id: 7,
      deviceFriendlyName: 'Laptop',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastUsedAt: null,
      aaGuid: 'aaguid',
      backupEligible: false,
      backupState: false
    }]

    await expect(removePasskey(7)).resolves.toBe(true)
    expect(mocks.commitAndReconcile).toHaveBeenCalledWith(
      expect.any(Function),
      mocks.getPasskeySignalState,
      expect.objectContaining({ revisionOf: expect.any(Function) })
    )
    expect(credentials.value).toEqual([])
  })
})
