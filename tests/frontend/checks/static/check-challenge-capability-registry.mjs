import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const binaryApi = read('src/frontend/src/contracts/binaryApi.ts')
const frontendRegistry = read('src/frontend/src/security/challenge-capability-registry.ts')
const backendRegistry = read('src/shared/Contracts/Security/SecurityChallengeCapabilityCatalog.cs')
const challengeHost = read('src/frontend/src/components/security/FsusSecurityChallenge.vue')
const notificationHost = read('src/frontend/src/composables/useNotification.ts')
const adminReadiness = read('src/frontend/src/views/admin/security/SecurityChallenges.vue')
const capabilityTests = read('tests/frontend/unit/security/challengeClient.test.ts')
const providerRegistration = read('src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs')

const enumBlock = binaryApi.match(/export const SecurityChallengeKind = \{([\s\S]*?)\n\} as const/)
assert.ok(enumBlock, 'SecurityChallengeKind enum block must remain machine readable')
const enumNames = [...enumBlock[1].matchAll(/^\s*([A-Za-z0-9]+):\s*\d+,?$/gm)].map((match) => match[1])
assert.ok(enumNames.length > 0, 'SecurityChallengeKind must contain entries')

for (const name of enumNames) {
  assert.match(frontendRegistry, new RegExp(`registration\\(SecurityChallengeKind\\.${name},`), `frontend registry missing ${name}`)
  assert.match(backendRegistry, new RegExp(`Entry\\(SecurityChallengeKind\\.${name},`), `backend registry missing ${name}`)
}

const frontendVersion = frontendRegistry.match(/MANIFEST_VERSION = '([^']+)'/)?.[1]
const backendVersion = backendRegistry.match(/ManifestVersion = "([^"]+)"/)?.[1]
assert.ok(frontendVersion && backendVersion, 'both builds must declare a capability manifest version')
assert.equal(frontendVersion, backendVersion, 'frontend and backend capability manifest versions must match')

assert.doesNotMatch(frontendRegistry, /deviceFingerprint|proofToken|subjectHash|clientIpHash|userId|adminId/, 'capability manifest must stay low information')
assert.match(challengeHost, /capability\?\.uiHost === 'captcha'/, 'captcha UI must dispatch from registry capability')
assert.match(challengeHost, /capability\?\.uiHost === 'perception'/, 'perception UI must dispatch from registry capability')
assert.match(challengeHost, /capability\?\.uiHost === 'pospace'/, 'PoSpace UI must dispatch from registry capability')
assert.doesNotMatch(challengeHost, /FsusPowChallenge|FsusPasskeyStepUpChallenge/, 'placeholder hosts must not be production dispatch targets')
assert.match(notificationHost, /executionMode:\s*'headless'/, 'notification executor must resolve through the shared headless registry')
assert.match(notificationHost, /notification-sha256-pow/, 'notification PoW executor must dispatch from registry capability')
assert.match(notificationHost, /notification-pospace/, 'notification PoSpace executor must dispatch from registry capability')
assert.doesNotMatch(notificationHost, /SecurityChallengeKind\./, 'notification business flow must not shadow the server kind policy')
assert.match(frontendRegistry, /import\('@\/components\/security\/FsusCaptchaChallenge\.vue'\)/, 'captcha executor factory must load a production implementation')
assert.match(frontendRegistry, /import\('@\/services\/securityPerceptionChallengeFlow'\)/, 'perception executor factory must load a production implementation')
assert.match(frontendRegistry, /import\('@\/composables\/usePow'\)/, 'headless PoW executor factory must load a production implementation')
assert.match(frontendRegistry, /import\('@\/services\/securityPoSpaceChallengeExecutor'\)/, 'PoSpace executor factory must load the shared production implementation')
for (const column of ['Provider', 'Executor', 'UI Host', 'Headless Host', 'Policy']) {
  assert.match(adminReadiness, new RegExp(`>${column}<`), `admin readiness must show ${column} separately`)
}
assert.match(adminReadiness, /securityChallengeCapabilityManifest/, 'admin readiness must consume the canonical frontend manifest')
assert.match(capabilityTests, /covers known, provider, executor, host and policy state for every enum member/, 'all enum states need a table-driven test')

for (const provider of [
  'Sha256PowChallengeProvider',
  'CaptchaV1ChallengeProvider',
  'Argon2idPoSpaceV1ChallengeProvider',
  'HumanReadProofV1ChallengeProvider',
  'PasskeyStepUpV1ChallengeProvider',
  'AdminPasskeyStepUpV1ChallengeProvider',
  'PerceptionTextTaskV2Provider',
  'PerceptionLocalizationV2Provider',
  'PerceptionMicroInteractionV2Provider'
]) {
  assert.match(providerRegistration, new RegExp(`ISecurityChallengeProvider, ${provider}`), `provider ${provider} must remain explicitly registered`)
}

console.log(`challenge capability registry: ${enumNames.length} enum values, manifest ${frontendVersion}`)
