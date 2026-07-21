import { describe, expect, it } from 'vitest'

import { shouldSuggestPasskeyRecovery } from '@/composables/passkeyRecoveryCapability'

describe('passkey recovery capability suggestion', () => {
  it('suggests recovery only for one non-backup credential without a recovery key', () => {
    expect(shouldSuggestPasskeyRecovery([{ backupEligible: false }], false)).toBe(true)
  })

  it.each([
    [[], false],
    [[{ backupEligible: true }], false],
    [[{ backupEligible: false }, { backupEligible: false }], false],
    [[{ backupEligible: false }], true]
  ])('does not repeat the suggestion when recovery capability exists (%j, recovery=%s)', (credentials, recoveryEnabled) => {
    expect(shouldSuggestPasskeyRecovery(credentials, recoveryEnabled)).toBe(false)
  })
})
