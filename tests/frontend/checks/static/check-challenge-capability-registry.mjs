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
const capabilityTests = read('tests/frontend/unit/security/challengeClient.test.ts');
const providerRegistration = read('src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs');
const challengeClient = read('src/frontend/src/security/challenge-client.ts');
const capabilityReload = read('src/frontend/src/security/challenge-capability-reload.ts');
const issueEncoder = read('src/frontend/src/codecs/binary/securityRequestEncoder.ts');
const issueEndpoint = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.SecurityChallenge.cs');

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
assert.match(challengeClient, /capabilityManifestVersion:\s*effectiveCapabilityManifestVersion\(context\)/, 'generic issue requests must carry the current capability manifest')
assert.match(challengeClient, /contextGenerations/, 'challenge client must tombstone stale async generations')
assert.match(challengeClient, /AbortController/, 'challenge client must abort replaced issue and verify requests');
assert.match(issueEncoder, /request\.capabilityManifestVersion[\s\S]*\],\s*40\)/, 'issue POD must encode the capability manifest in the current 40-byte header');
assert.match(issueEndpoint, /security_challenge_client_capability_incompatible/, 'server issue gate must return a stable incompatible result');
assert.match(issueEndpoint, /string\.Equals\(manifestVersion, SecurityChallengeCapabilityCatalog\.ManifestVersion/, 'server issue gate must require the exact active capability manifest');
assert.match(challengeClient, /isCapabilityManifestIncompatibleError\(error\)/, 'client must turn the stable incompatible response into an explicit action');
assert.match(challengeClient, /requestCapabilityReload\(effectiveCapabilityManifestVersion\(context\)\)/, 'client must request a full reload for its exact stale build manifest');
assert.match(capabilityReload, /window\.location\.reload\(\)/, 'capability cutover must use a normal full document reload');
assert.match(capabilityReload, /window\.sessionStorage/, 'capability reload must persist a session-scoped loop guard');
assert.match(capabilityReload, /storage\.setItem\(key, 'requested'\)[\s\S]*reload\(\)/, 'loop guard must be written before reload');
assert.doesNotMatch(capabilityReload, /location\.replace|location\.assign|fetch\(|XMLHttpRequest/, 'capability reload must not implement navigation or protocol fallback');

assert.doesNotMatch(frontendRegistry, /deviceFingerprint|proofToken|subjectHash|clientIpHash|userId|adminId/, 'capability manifest must stay low information');
assert.match(challengeHost, /capability\?\.uiHost === 'perception'/, 'perception UI must dispatch from registry capability');
assert.match(challengeHost, /capability\?\.uiHost === 'pospace'/, 'PoSpace UI must dispatch from registry capability');
assert.match(challengeHost, /capability\?\.uiHost === 'sha256-pow'/, 'sha256 PoW UI must dispatch from registry capability');
assert.match(challengeHost, /FsusPowChallenge/, 'sha256 PoW must use its production UI host')
assert.doesNotMatch(challengeHost, /FsusPasskeyStepUpChallenge/, 'placeholder passkey hosts must not be production dispatch targets')
assert.match(notificationHost, /executionMode:\s*'headless'/, 'notification executor must resolve through the shared headless registry');
assert.match(notificationHost, /notification-sha256-pow/, 'notification PoW executor must dispatch from registry capability');
assert.match(notificationHost, /notification-pospace/, 'notification PoSpace executor must dispatch from registry capability');
assert.doesNotMatch(notificationHost, /SecurityChallengeKind\./, 'notification business flow must not shadow the server kind policy');
assert.match(frontendRegistry, /import\('@\/services\/securityPerceptionChallengeFlow'\)/, 'perception executor factory must load a production implementation');
assert.match(frontendRegistry, /import\('@\/services\/securityPerceptionCharacterV3Flow'\)/, 'character v3 executor factory must load a production implementation');
assert.match(frontendRegistry, /import\('@\/composables\/usePow'\)/, 'headless PoW executor factory must load a production implementation');
assert.match(frontendRegistry, /import\('@\/services\/securityPoSpaceChallengeExecutor'\)/, 'PoSpace executor factory must load the shared production implementation');
for (const column of ['契约可表达', '当前客户端可执行', '策略可启用 \/ 模式', 'Provider'])
{
  assert.match(adminReadiness, new RegExp(`>${column}<`), `admin readiness must show ${column} separately`)
}
assert.match(adminReadiness, /contractLabel/, 'admin readiness must expose kindKnown independently')
assert.match(adminReadiness, /clientExecutionLabel/, 'admin readiness must expose executor, host, surface and manifest readiness')
assert.match(adminReadiness, /uiPolicy\.policyEligible/, 'admin readiness must expose policy eligibility independently by mode')
assert.match(adminReadiness, /securityChallengeCapabilityManifest/, 'admin readiness must consume the canonical frontend manifest')
assert.match(capabilityTests, /covers known, provider, executor, host and policy state for every enum member/, 'all enum states need a table-driven test');

for (const provider of [
    'Sha256PowChallengeProvider',
    'Argon2idPoSpaceV1ChallengeProvider',
    'HumanReadProofV1ChallengeProvider',
    'PasskeyStepUpV1ChallengeProvider',
    'AdminPasskeyStepUpV1ChallengeProvider',
    'PerceptionLocalizationV2Provider',
    'PerceptionMicroInteractionV2Provider',
    'PerceptionCharacterV3Provider'
])
{
    assert.match(providerRegistration, new RegExp(`ISecurityChallengeProvider, ${provider}`), `provider ${provider} must remain explicitly registered`);
}

console.log(`challenge capability registry: ${enumNames.length} enum values, manifest ${frontendVersion}`)
