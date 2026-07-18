import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateCommentPrivacyCredentialVault,
  validateCommentPrivacyCredentialVaultSources
} from '../../tools/security/check-comment-privacy-credential-vault.mjs'

test('comment privacy credential release gate accepts the memory-only production boundary', () => {
  const validation = validateCommentPrivacyCredentialVault()
  assert.deepEqual(validation.errors, [])
})

test('comment privacy credential release gate rejects plaintext IndexedDB regression', () => {
  const validation = validateCommentPrivacyCredentialVault()
  const sources = { ...validation.sources }
  const vaultFile = 'src/frontend/src/privacy/commentPrivacyCredentialVault.ts'
  sources[vaultFile] = sources[vaultFile]
    .replace("COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE = 'disabled'", "COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE = 'plaintext'")
    .concat('\nindexedDB.open("credential").result.createObjectStore("credentials")\n')

  const regressed = validateCommentPrivacyCredentialVaultSources(sources)
  assert.ok(regressed.errors.some(error => /persistence is explicitly disabled|must not open or write|IndexedDB open\/put/.test(error)))
})

test('comment privacy credential release gate rejects missing production behavior evidence', () => {
  const validation = validateCommentPrivacyCredentialVault()
  const sources = { ...validation.sources }
  const planFile = 'security/evidence-contracts/comment-privacy-credential-vault.release-plan.json'
  const plan = JSON.parse(sources[planFile])
  plan.requiredEvidence = plan.requiredEvidence.filter(
    evidence => evidence.id !== 'credential-vault-two-tab-purge'
  )
  sources[planFile] = JSON.stringify(plan)

  const regressed = validateCommentPrivacyCredentialVaultSources(sources)
  assert.ok(regressed.errors.some(error => /must declare the cross-account, fake-IndexedDB dump, two-tab purge, and Trusted Types behavior evidence IDs/.test(error)))
})
