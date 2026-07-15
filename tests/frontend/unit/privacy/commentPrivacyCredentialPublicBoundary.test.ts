import { afterEach, describe, expect, it } from 'vitest'
import { getCommentPrivacyRuntime, resetCommentPrivacyRuntimeForTests } from '@/privacy/commentPrivacyRuntime'
import { resetCommentPrivacyCredentialVaultForTests } from '@/privacy/commentPrivacyCredentialVault'
import { resetCommentPrivacyCredentialLifecycleForTests } from '@/privacy/commentPrivacyCredentialLifecycle'

describe('comment privacy credential public boundary', () => {
  afterEach(() => {
    resetCommentPrivacyRuntimeForTests()
    resetCommentPrivacyCredentialVaultForTests()
    resetCommentPrivacyCredentialLifecycleForTests()
  })

  it('does not expose a vault, generation, enumeration, or secret export on window/globalThis', () => {
    getCommentPrivacyRuntime()

    const exportedGlobals = Object.getOwnPropertyNames(globalThis).filter(name =>
      /commentPrivacy|credentialVault|credentialSecret|vaultGeneration/i.test(name)
    )
    expect(exportedGlobals).toEqual([])
    expect(globalThis).not.toHaveProperty('__FSUSBLOG_COMMENT_PRIVACY_VAULT__')
  })
})
