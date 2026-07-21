import assert from 'node:assert/strict';
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/privacy-zk-comment-matrix.sh'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))

test('privacy ZK lane exposes prebuild/postbuild contract, functional and finalize stages', () => {
  const contractPrebuild = lane.indexOf('RunContractPrebuildStage()')
  const contractPostbuild = lane.indexOf('RunContractPostbuildStage()')
  const contract = lane.indexOf('RunContractStage()')
  const functional = lane.indexOf('RunFunctionalStage()')
  const finalize = lane.indexOf('FinalizePrivacyMatrix()')

  assert.ok(contractPrebuild >= 0)
  assert.ok(contractPrebuild < contractPostbuild)
  assert.ok(contractPostbuild < contract)
  assert.ok(contract >= 0)
  assert.ok(contract < functional)
  assert.ok(functional < finalize)
  assert.match(lane, /source .*\/_lane-collect-support\.sh/u)
  assert.match(lane, /RunCollectParallel privacy-zk-functional/u)
  assert.match(lane, /backend-functional RunPrivacyBackendFunctional/u)
  assert.match(lane, /frontend RunPrivacyFrontend/u)
  assert.match(lane, /prod-smoke RunPrivacyProdSmoke/u)
  assert.match(lane, /ConfigureDotnetTestProcessors/u)
  assert.match(lane, /PRIVACY_DOTNET_ARGS=\(-- --no-build --no-restore\)/u)
  assert.match(lane, /RunPrivacyPrebuildContract\(\)[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild \|\| return \$\?[\s\S]*?FSUSBLOG_ZK_MCL_NO_BUILD=1/u)
  assert.match(lane, /RunPrivacyBackendFunctional\(\)[\s\S]*?ConfigureDotnetTestProcessors \|\| return \$\?[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release EnsureBackendFilteredBuild \|\| return \$\?[\s\S]*?check:privacy-zk-backend-functional/u)
  assert.match(lane, /WriteStageReceipt contract-prebuild/u)
  assert.match(lane, /RequireStageReceipt contract-prebuild/u)
  assert.match(lane, /WriteStageReceipt contract /u)
  assert.match(lane, /contract-prebuild\)[\s\S]*?RunContractPrebuildStage/u)
  assert.match(lane, /contract-postbuild\)[\s\S]*?RunContractPostbuildStage/u)
  assert.doesNotMatch(lane, /maxFailures|max[-_ ]?errors|fail-fast/u)
})

test('privacy contract package scripts keep current circuit checks before the generated prover check', () => {
  const scripts = packageJson.scripts
  const contract = scripts['check:privacy-zk-contract']
  const prebuild = scripts['check:privacy-zk-contract:prebuild']
  const postbuild = scripts['check:privacy-zk-contract:postbuild']

  assert.equal(contract, 'npm run check:privacy-zk-contract:prebuild && npm run check:privacy-zk-contract:postbuild')
  assert.match(prebuild, /comment-privacy-build-contract\.mjs/u)
  assert.match(prebuild, /check-zk-comment-v5-unlinkability\.mjs/u)
  assert.match(postbuild, /check-zk-comment-v5-manifests\.mjs/u)
  assert.doesNotMatch(postbuild, /MCL pairing fixture/u)
})

test('privacy functional command excludes performance tests', () => {
  const scripts = packageJson.scripts
  const originalBackend = scripts['check:privacy-zk-backend']
  const functionalBackend = scripts['check:privacy-zk-backend-functional']

  assert.ok(originalBackend)
  assert.ok(functionalBackend)
  assert.match(functionalBackend, /^dotnet test /u)
  assert.match(functionalBackend, / -c Release /u)
  assert.match(functionalBackend, /AnonymousPrivacyConcurrencyTests/u)
  assert.match(functionalBackend, /Category!=Performance/u)
  for (const selection of originalBackend.match(/FullyQualifiedName~[A-Za-z0-9]+/gu) ?? []) {
    if (/ZkAnonymousProofVerifierContractTests|AnonymousCommentGovernanceContractTests/u.test(selection)) continue
    assert.match(functionalBackend, new RegExp(selection, 'u'))
  }
  assert.doesNotMatch(functionalBackend, /FSUSBLOG_RUN_PERFORMANCE_TESTS/u)
})

test('privacy evidence requires all successful stage receipts', () => {
  const finalize = lane.slice(lane.indexOf('FinalizePrivacyMatrix()'), lane.indexOf('case "${1:-all}"'))
  assert.match(finalize, /RequireStageReceipt contract/u)
  assert.match(finalize, /RequireStageReceipt functional/u)
  assert.doesNotMatch(finalize, /RequireStageReceipt benchmark/u)
  assert.match(lane, /receipt\.runId !== expectedRunId/u)
})

test('privacy frontend report has a dedicated lane and contains no retired test paths', () => {
  const frontend = packageJson.scripts['check:privacy-zk-frontend']
  assert.match(frontend, /FSUSBLOG_VITEST_LANE=privacy-zk/u)
  assert.doesNotMatch(frontend, /commentAnonymousAuthorWorkflow|anonymousModerationGovernanceWorkflow/u)
})
