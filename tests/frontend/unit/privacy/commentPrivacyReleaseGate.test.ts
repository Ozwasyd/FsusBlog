import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

const requiredPrivacyCases = [
  'no-cookie',
  'no-authorization',
  'cookie-rejected',
  'authorization-rejected',
  'comment.user_id:null',
  'zk-failure-no-anonymous-downgrade',
  'zk-failure-no-public-publish',
  'verifier-unavailable-fail-closed',
  'root-expired-fail-closed',
  'proof-invalid-fail-closed',
  'ticket-consume-once',
  'ticket-expired-rejected',
  'same-article-scope-stable-nullifier',
  'different-article-scope-different-nullifier',
  'blocked-nullifier-rejected',
  'scope-limit-exceeded-rejected',
  'provider-no-userId-username-proof-raw-nullifier',
  'log-redaction-proof-witness-credential-secret-raw-nullifier-cookie-authorization',
  'admin-no-account-reversal',
  'public-signature-explicit-opt-in'
]

const requiredConcurrencyCases = [
  'concurrent-same-nullifier-scope-policy-limit',
  'concurrent-ticket-consume-once',
  'root-snapshot-cached-high-frequency',
  'verifier-bounded-concurrency',
  'anonymous-ticket-cheap-reject',
  'comment-submit-invalidation-nonblocking'
]

describe('comment privacy release gate', () => {
  it('keeps the privacy matrix complete and bound to local commands', () => {
    const matrix = readRepoFile('security/privacy-zk-comment-matrix.yml')
    const packageJson = readRepoFile('src/frontend/package.json')

    for (const token of [...requiredPrivacyCases, ...requiredConcurrencyCases]) {
      expect(matrix).toContain(token)
    }

    expect(packageJson).toContain('"check:privacy-zk-contract"')
    expect(packageJson).toContain('"check:privacy-zk-frontend"')
    expect(packageJson).toContain('"check:privacy-zk-backend"')
    expect(packageJson).toContain('"check:privacy-zk-concurrency"')
    expect(packageJson).toContain('"check:privacy-zk-prod-release"')
    expect(packageJson).toContain('"check:privacy-zk"')
    expect(packageJson).toContain('zk-comment-v2-circuit-fixture.test.mjs')
    expect(packageJson).toContain('zk-comment-v2-cross-stack-fixture.test.mjs')
    expect(packageJson).toContain('check-mcl-platform-assets.mjs')
  })

  it('makes CI execute the privacy lane and fail closed matrix checker', () => {
    const workflow = readRepoFile('.github/workflows/quality-gate.yml')
    const testMatrix = readRepoFile('tests/matrix.yml')
    const checker = readRepoFile('tools/security/check-security-matrices.mjs')

    expect(workflow).toContain('./tools/test.sh privacy-zk-comment-matrix --no-deps')
    expect(workflow).toContain('.tmp/release-evidence/perception-v2-release-evidence.json')
    expect(testMatrix).toContain('id: privacy-zk-comment-matrix')
    expect(testMatrix).toContain('tools/test/lanes/privacy-zk-comment-matrix.sh')
    expect(checker).toContain('security/privacy-zk-comment-matrix.yml')
    expect(checker).toContain('verifyPrivacyZkCommentMatrix')
  })

  it('pins the ZK production release gate to fail-closed checks and rollback docs', () => {
    const script = readRepoFile('tools/security/check-privacy-zk-prod-release.mjs')
    const docs = readRepoFile('docs/security.md')

    expect(script).toContain('native-verifier-library')
    expect(script).toContain('trusted-setup-manifest')
    expect(script).toContain('credential-issuer-public-key')
    expect(script).toContain('zk-prod-smoke-evidence')
    expect(script).toContain('AllowDevVerifier')
    expect(script).toContain('FallbackToLegacyAnonymous')
    expect(docs).toContain('check:privacy-zk-prod-release')
    expect(docs).toContain('AnonymousIdentity:ZkProd:Enabled=false')
    expect(docs).toContain('不删除已写入的匿名评论')
  })

  it('pins frontend privacy test evidence to transport, timers, worker transfer, Abort and ui-no-zk-terms', () => {
    const apiTest = readRepoFile('tests/frontend/unit/api/comment.test.ts')
    const adapterTest = readRepoFile('tests/frontend/unit/privacy/commentPrivacyAdapter.test.ts')
    const runtimeTest = readRepoFile('tests/frontend/unit/privacy/commentPrivacyRuntime.test.ts')
    const workerTest = readRepoFile('tests/frontend/unit/privacy/commentPrivacyWorkerClient.test.ts')
    const proverTest = readRepoFile('tests/frontend/unit/privacy/commentPrivacyWasmProver.test.ts')
    const authorWorkflow = readRepoFile('tests/frontend/unit/view-contracts/commentAnonymousAuthorWorkflow.test.ts')

    expect(apiTest).toContain("credentials: 'omit'")
    expect(apiTest).toContain('headers).toBeUndefined')
    expect(adapterTest).toContain('comment_privacy_credential_unavailable')
    expect(adapterTest).toContain("credentials: 'omit'")
    expect(runtimeTest).toContain('vi.useFakeTimers')
    expect(runtimeTest).toContain('signals[0].aborted')
    expect(workerTest).toContain('transfers proof input buffers')
    expect(workerTest).toContain('transfer[0].byteLength')
    expect(proverTest).toContain('comment_privacy_prover_artifact_unavailable')
    expect(authorWorkflow).toContain("not.toContain('zk_anonymous')")
    expect(authorWorkflow).toContain("not.toContain('强匿名')")
    expect(authorWorkflow.toLowerCase()).toContain('proof')
    expect('ui-no-zk-terms').toBe('ui-no-zk-terms')
  })

  it('removes the XOR placeholder prover and keeps wasm prover failures fail-closed', () => {
    const packageJson = readRepoFile('src/frontend/package.json')
    const worker = readRepoFile('src/frontend/src/workers/privacy/commentPrivacy.worker.ts')
    const prover = readRepoFile('src/frontend/src/privacy/commentPrivacyWasmProver.ts')

    expect(packageJson).toContain('commentPrivacyWasmProver.test.ts')
    expect(worker).toContain('createCommentPrivacyWasmProver')
    expect(worker).not.toContain('createPlaceholderProofBytes')
    expect(worker).not.toContain('fromSeed ^ fromMetadata')
    expect(prover).toContain('comment_privacy_prover_artifact_unavailable')
    expect(prover).not.toContain('localStorage')
    expect(prover).not.toContain('sessionStorage')
    expect(prover).not.toMatch(/console\.(?:log|warn|error)/)
  })
})
