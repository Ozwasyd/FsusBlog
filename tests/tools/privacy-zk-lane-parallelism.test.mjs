import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/privacy-zk-comment-matrix.sh'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))

test('privacy ZK lane exposes prebuild/postbuild contract, functional, benchmark and finalize stages', () => {
  const contractPrebuild = lane.indexOf('run_contract_prebuild_stage()')
  const contractPostbuild = lane.indexOf('run_contract_postbuild_stage()')
  const contract = lane.indexOf('run_contract_stage()')
  const functional = lane.indexOf('run_functional_stage()')
  const benchmark = lane.indexOf('run_benchmark_stage()')
  const finalize = lane.indexOf('finalize_privacy_matrix()')

  assert.ok(contractPrebuild >= 0)
  assert.ok(contractPrebuild < contractPostbuild)
  assert.ok(contractPostbuild < contract)
  assert.ok(contract >= 0)
  assert.ok(contract < functional)
  assert.ok(functional < benchmark)
  assert.ok(benchmark < finalize)
  assert.match(lane, /source .*\/_legacy\.sh/u)
  assert.match(lane, /run_collect_parallel privacy-zk-functional/u)
  assert.match(lane, /backend-functional run_privacy_backend_functional/u)
  assert.match(lane, /frontend run_privacy_frontend/u)
  assert.match(lane, /prod-smoke run_privacy_prod_smoke/u)
  assert.match(lane, /privacy-zk-native-p99 run_privacy_benchmark/u)
  assert.match(lane, /configure_dotnet_test_processors/u)
  assert.match(lane, /PRIVACY_DOTNET_ARGS=\(-- --no-build --no-restore\)/u)
  assert.match(lane, /run_privacy_prebuild_contract\(\)[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug ensure_backend_filtered_build \|\| return \$\?[\s\S]*?FSUSBLOG_ZK_MCL_NO_BUILD=1/u)
  assert.match(lane, /run_privacy_backend_functional\(\)[\s\S]*?configure_dotnet_test_processors \|\| return \$\?[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release ensure_backend_filtered_build \|\| return \$\?[\s\S]*?check:privacy-zk-backend-functional/u)
  assert.match(lane, /run_privacy_benchmark\(\)[\s\S]*?configure_dotnet_test_processors \|\| return \$\?[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release ensure_backend_filtered_build \|\| return \$\?[\s\S]*?check:privacy-zk-benchmark/u)
  assert.match(lane, /write_stage_receipt contract-prebuild/u)
  assert.match(lane, /require_stage_receipt contract-prebuild/u)
  assert.match(lane, /write_stage_receipt contract /u)
  assert.match(lane, /contract-prebuild\)[\s\S]*?run_contract_prebuild_stage/u)
  assert.match(lane, /contract-postbuild\)[\s\S]*?run_contract_postbuild_stage/u)
  assert.doesNotMatch(lane, /maxFailures|max[-_ ]?errors|fail-fast/u)
})

test('privacy contract package scripts keep build-independent MCL work before the generated prover check', () => {
  const scripts = packageJson.scripts
  const contract = scripts['check:privacy-zk-contract']
  const prebuild = scripts['check:privacy-zk-contract:prebuild']
  const postbuild = scripts['check:privacy-zk-contract:postbuild']

  assert.equal(contract, 'npm run check:privacy-zk-contract:prebuild && npm run check:privacy-zk-contract:postbuild')
  assert.match(prebuild, /build-zk-comment-v2-r1cs\.mjs --check/u)
  assert.match(prebuild, /MCL pairing fixture\|MCL tool writes/u)
  assert.doesNotMatch(prebuild, /browser wasm prover bundle/u)
  assert.match(postbuild, /check-zk-comment-v5-manifests\.mjs/u)
  assert.match(postbuild, /browser wasm prover bundle/u)
  assert.match(postbuild, /FSUSBLOG_ZK_MCL_NO_BUILD=1/u)
})

test('privacy functional and benchmark commands keep benchmark isolation exact', () => {
  const scripts = packageJson.scripts
  const originalBackend = scripts['check:privacy-zk-backend']
  const functionalBackend = scripts['check:privacy-zk-backend-functional']
  const benchmark = scripts['check:privacy-zk-benchmark']

  assert.ok(originalBackend)
  assert.ok(functionalBackend)
  assert.ok(benchmark)
  assert.match(functionalBackend, /^dotnet test /u)
  assert.match(functionalBackend, / -c Release /u)
  assert.match(functionalBackend, /AnonymousPrivacyConcurrencyTests/u)
  assert.match(functionalBackend, /Category!=Performance/u)
  for (const selection of originalBackend.match(/FullyQualifiedName~[A-Za-z0-9]+/gu) ?? []) {
    if (/ZkAnonymousProofVerifierContractTests|AnonymousCommentGovernanceContractTests/u.test(selection)) continue
    assert.match(functionalBackend, new RegExp(selection, 'u'))
  }
  assert.match(benchmark, /^dotnet test /u)
  assert.match(benchmark, / -c Release /u)
  assert.match(benchmark, /ZkCommentV2CrossStackFixtureTests\.RepositoryMclPairingFixture_P99StaysInsideManifestBudget/u)
  assert.doesNotMatch(functionalBackend, /FSUSBLOG_RUN_PERFORMANCE_TESTS/u)
  assert.match(lane, /FSUSBLOG_RUN_PERFORMANCE_TESTS=1[\s\\]*npm .*check:privacy-zk-benchmark/u)
})

test('privacy evidence requires all successful stage receipts', () => {
  const finalize = lane.slice(lane.indexOf('finalize_privacy_matrix()'), lane.indexOf('case "${1:-all}"'))
  assert.match(finalize, /require_stage_receipt contract/u)
  assert.match(finalize, /require_stage_receipt functional/u)
  assert.match(finalize, /require_stage_receipt benchmark/u)
  assert.match(finalize, /isolated native verifier P99 benchmark stage receipts/u)
  assert.match(lane, /receipt\.runId !== expectedRunId/u)
})

test('privacy frontend report has a dedicated lane and contains no retired test paths', () => {
  const frontend = packageJson.scripts['check:privacy-zk-frontend']
  assert.match(frontend, /FSUSBLOG_VITEST_LANE=privacy-zk/u)
  assert.doesNotMatch(frontend, /commentAnonymousAuthorWorkflow|anonymousModerationGovernanceWorkflow/u)
})
