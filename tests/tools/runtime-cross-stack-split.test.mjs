import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const legacy = fs.readFileSync(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')
const bundle = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8')
const staticPhase = legacy.slice(
  legacy.indexOf('RunCrossStackStaticContracts()'),
  legacy.indexOf('\nRunCrossStackRuntimeContracts()')
)
const runtimePhase = legacy.slice(
  legacy.indexOf('RunCrossStackRuntimeContracts()'),
  legacy.indexOf('\nRunCrossStackContractOnly()')
)

test('cross-stack static phase retains every source contract and excludes only the browser probe', () => {
  assert.match(staticPhase, /FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild \|\| return \$\?/u)
  assert.match(staticPhase, /FSUSBLOG_OPENAPI_BUILD=0 Run "\$ROOT_DIR\/tools\/contracts\/export-openapi\.sh"/u)
  for (const token of [
    'tools/contracts/export-openapi.sh',
    'check:openapi-sync',
    'check:contract:openapi',
    'check:frontend-routes',
    'check:consumer:openapi',
    'check:contract:binary-matrix',
    'check:contract:api-parity',
    'check:contract:pow-parity',
    'check:contract:frame-schema',
    'check:contract:negative-matrix',
    'check:coherence:runtime-matrix',
    'check:coherence:distribution-full',
    'check:coherence:notification-stream-events',
    'check:coherence:upload-complete',
    'auth-state-coherence.mjs',
    'check:coherence:sw-cache',
    'check:coherence:perf',
    'check:cross-stack-test-governance'
  ]) assert.equal(staticPhase.split(token).length - 1, 1, `${token} must run exactly once`)
  const producer = staticPhase.indexOf('FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild')
  const exportReader = staticPhase.indexOf('FSUSBLOG_OPENAPI_BUILD=0 Run "$ROOT_DIR/tools/contracts/export-openapi.sh"')
  assert.ok(producer >= 0, 'cross-stack static must prepare the shared Debug build')
  assert.ok(exportReader > producer, 'canonical OpenAPI export must run after the shared Debug producer')
  assert.doesNotMatch(staticPhase, /check:auth-zero-probe|RequireDebugStack/u)
  assert.doesNotMatch(staticPhase, /FSUSBLOG_OPENAPI_BUILD=1|dotnet build/u)
})

test('cross-stack runtime phase binds the exact browser probe to the bootstrapped debug stack', () => {
  assert.match(runtimePhase, /RequireDebugStack/u)
  assert.match(runtimePhase, /PLAYWRIGHT_BASE_URL="\$DEBUG_FRONTEND_URL"/u)
  assert.equal(runtimePhase.split('check:auth-zero-probe').length - 1, 1)
})

test('runtime bundle starts static cross-stack early and joins both halves as one logical tier', () => {
  assert.match(bundle, /step\('cross-stack', 'FSUSBLOG_OPENAPI_BUILD=0 tools\/test\/legacy-test\.sh cross-stack-contract static', \[\], \{\s*dependsOn: \['security-static', 'backend-build-ready'\]/u)
  assert.match(bundle, /step\('cross-stack-runtime', 'tools\/test\/legacy-test\.sh cross-stack-contract runtime', \[\], \{\s*dependsOn: \['runtime-integration'\]/u)
  assert.match(bundle, /step\('cross-stack-join', null, \['cross-stack-contract'\],[\s\S]*?dependsOn: \['cross-stack', 'cross-stack-runtime'\],[\s\S]*?runAfterSettled: true,[\s\S]*?coordinationOnly: true/u)
})
