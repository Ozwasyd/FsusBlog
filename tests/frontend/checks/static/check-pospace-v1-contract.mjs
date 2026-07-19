import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const source = JSON.parse(read('contracts/security/pospace-v1-contract.json'))
const vector = JSON.parse(read('tests/fixtures/security/pospace-v1-vector.json'))
const provider = read('src/backend/Services/Security/Argon2idPoSpaceV1ChallengeProvider.cs')
const runtime = read('src/frontend/src/services/securityPoSpaceRuntime.ts')
const reissue = read('src/backend/Services/Security/PoSpaceUnsupportedReissueService.cs')
const endpoint = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.SecurityChallenge.cs')
const backendCapabilities = read('src/shared/Contracts/Security/SecurityChallengeCapabilityCatalog.cs')
const frontendCapabilities = read('src/frontend/src/security/challenge-capability-registry.ts')
const backendTests = read('tests/backend/Unit/Argon2idPoSpaceV1ChallengeProviderTests.cs')
const frontendTests = read('tests/frontend/unit/wasm/securityPoSpace.test.ts')
const workerTests = read('tests/frontend/e2e/security/pospace-worker.spec.ts')

assert.equal(source.algorithm, 'fsu.pospace/argon2id@v1')
assert.deepEqual(source.memoryKib, { min: 19456, max: 65536, default: 19456 })
assert.deepEqual(source.iterations, { min: 2, max: 6, default: 2 })
assert.deepEqual(source.lanes, { min: 1, max: 4, default: 1 })
assert.deepEqual(source.targetDurationMs, { min: 100, max: 5000, default: 750 })
assert.equal(source.maxUnsupportedReissues, 2)
assert.equal(vector.providerPayload.memoryKib, String(source.memoryKib.min))
assert.equal(vector.providerPayload.iterations, String(source.iterations.min))
assert.equal(vector.verifyPayload.proofHex, vector.expectedProofHex)
assert.equal(vector.verifyPayload.nonceHex, vector.nonceHex)

assert.match(provider, /PoSpaceV1Contract\.MinMemoryKib/)
assert.match(provider, /TryParseCanonicalDecimal/)
assert.doesNotMatch(provider, /MobileMaxMemory|8_192|8192/)
assert.match(runtime, /poSpaceV1Contract\.memoryKib\.min/)
assert.match(runtime, /maxAllowedMemoryKib = mobileHint\s*\? 0/)
assert.match(runtime, /createPoSpaceUnsupportedReissueAttributes/)
assert.match(reissue, /MaxUnsupportedReissues/)
assert.match(reissue, /RevokeOriginalAsync/)
assert.match(reissue, /TryRevokeIssuedAsync/)
assert.match(endpoint, /PoSpaceUnsupportedReissueParser\.TryParse/)
assert.match(endpoint, /IPoSpaceUnsupportedReissueService/)
assert.match(backendCapabilities, /Entry\(SecurityChallengeKind\.Argon2IdPoSpaceV1, true, true, false, false, false, false, false\)/)
assert.match(frontendCapabilities, /registration\(SecurityChallengeKind\.Argon2IdPoSpaceV1, 'pospace', true, true, null, null, null, false, \[\]\)/)

for (const forbidden of ["memoryKib: '1024'", "memoryKib: '8192'", "iterations: '1'"]) {
  assert.doesNotMatch(frontendTests, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}
assert.match(backendTests, /19_455/)
assert.match(frontendTests, /019456/)
assert.match(frontendTests, /pospace-v1-vector\.json/)
assert.match(workerTests, /pospace-v1-vector\.json/)

console.log('PoSpace v1 source, generated consumers, strict parsing and server-authoritative fallback are aligned')
