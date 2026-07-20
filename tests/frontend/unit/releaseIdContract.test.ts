import { describe, expect, it } from 'vitest'

import cases from '../../fixtures/release/release-id-cases.json'
import {
  isCanonicalReleaseId,
  LOCAL_UNVERSIONED_RELEASE_ID,
  parseReleaseId
} from '../../../src/frontend/src/generated/releaseIdContract'

describe('generated release id contract', () => {
  it('matches the shared valid and invalid fixture', () => {
    for (const releaseId of cases.valid) {
      expect(isCanonicalReleaseId(releaseId), releaseId).toBe(true)
      expect(parseReleaseId(releaseId)?.releaseId).toBe(releaseId)
    }
    for (const releaseId of cases.invalid) {
      expect(isCanonicalReleaseId(releaseId), releaseId).toBe(false)
      expect(parseReleaseId(releaseId)).toBeNull()
    }
    expect(parseReleaseId(cases.identity.releaseId)).toEqual(cases.expectedParsedIdentity)
  })

  it('keeps the local sentinel outside deployable identities', () => {
    expect(LOCAL_UNVERSIONED_RELEASE_ID).toBe('local-unversioned')
    expect(isCanonicalReleaseId(LOCAL_UNVERSIONED_RELEASE_ID)).toBe(false)
  })
})
