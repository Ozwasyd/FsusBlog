import { describe, expect, it } from 'vitest'
import type { AnonymousCredentialRevocationArtifact } from '@/api/comment'
import { buildCommentPrivacyRevocationWitnessLocally } from '@/privacy/commentPrivacyRevocationLocal'

describe('commentPrivacyRevocationLocal', () => {
  it('fails closed on stale, rollback, and tampered public artifacts', async () => {
    const current = artifact()
    await expect(build(current, Date.now() + 60_000)).rejects.toThrow('comment_privacy_revocation_artifact_invalid')

    await expect(build({ ...current, kind: 2, baseVersion: 1 })).rejects.toThrow('comment_privacy_revocation_rollback_detected')

    await expect(build({ ...current, contentHash: new Uint8Array(32).fill(9) }))
      .rejects.toThrow('comment_privacy_revocation_content_hash_invalid')
  })
})

function artifact(): AnonymousCredentialRevocationArtifact {
  return {
    credentialEpoch: 42,
    version: 0,
    baseVersion: 0,
    expiresAtUnixMs: Date.now() + 60_000,
    kind: 1,
    algorithmId: 'circuit-friendly-non-membership.v1',
    pathDepth: 128,
    issuerPublicKeyHash: 'ff'.repeat(32),
    revocationRoot: new Uint8Array(32),
    contentHash: new Uint8Array(32),
    signature: new Uint8Array(32),
    entryHashes: new Uint8Array()
  }
}

function build(artifact: AnonymousCredentialRevocationArtifact, nowUnixMs = Date.now()) {
  return buildCommentPrivacyRevocationWitnessLocally({
    artifact,
    revocationHandleHash: new Uint8Array(32).fill(1),
    expectedEpoch: 42,
    expectedVersion: 0,
    expectedIssuerPublicKeyHash: 'ff'.repeat(32),
    expectedRevocationRoot: new Uint8Array(32),
    nowUnixMs,
    maxCpuMs: 2_000
  })
}
