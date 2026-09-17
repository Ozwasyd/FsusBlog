import { afterEach, describe, expect, it } from 'vitest'
import {
  COMMENT_MANAGEMENT_CAPABILITY_LOSS_NOTICE,
  COMMENT_MANAGEMENT_CAPABILITY_PERSISTENCE_MODE,
  createMemoryOnlyCommentManagementCapabilityVault,
  getCommentManagementCapabilityVault,
  resetCommentManagementCapabilityVaultForTests
} from '@/privacy/commentManagementCapabilityVault'

afterEach(() => resetCommentManagementCapabilityVaultForTests())

describe('commentManagementCapabilityVault', () => {
  it('keeps management secrets only inside the vault instance', () => {
    const vault = createMemoryOnlyCommentManagementCapabilityVault()
    vault.put(' 123 ', ' secret-123 ')

    expect(vault.get('123')).toBe('secret-123')
    expect(createMemoryOnlyCommentManagementCapabilityVault().get('123')).toBeNull()
    expect(COMMENT_MANAGEMENT_CAPABILITY_PERSISTENCE_MODE).toBe('memory-only')
    expect(COMMENT_MANAGEMENT_CAPABILITY_LOSS_NOTICE).toContain('刷新或关闭页面后无法找回')
  })

  it('supports explicit removal and clear without accepting invalid capabilities', () => {
    const vault = createMemoryOnlyCommentManagementCapabilityVault()
    vault.put('123', 'secret-123')
    vault.put('456', 'secret-456')
    vault.remove('123')

    expect(vault.get('123')).toBeNull()
    expect(vault.get('456')).toBe('secret-456')
    vault.clear()
    expect(vault.get('456')).toBeNull()
    expect(() => vault.put('0', 'secret')).toThrow('comment_management_capability_invalid')
    expect(() => vault.put('123', '   ')).toThrow('comment_management_capability_invalid')
  })

  it('drops the default in-memory secret when the page-scoped vault is reset', () => {
    getCommentManagementCapabilityVault().put('123', 'secret-123')
    resetCommentManagementCapabilityVaultForTests()

    expect(getCommentManagementCapabilityVault().get('123')).toBeNull()
  })
})
