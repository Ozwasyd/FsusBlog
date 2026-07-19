import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('perception matrix projects the fresh production union and keeps standalone execution', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/perception-v2-test-matrix.sh'), 'utf8')
  const standaloneStart = lane.indexOf('\nFSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild')
  const localBranch = lane.slice(lane.indexOf('if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]'), standaloneStart)
  const standaloneBranch = lane.slice(standaloneStart)

  assert.match(lane, /source .*\/_lane-collect-support\.sh/u)
  assert.match(lane, /FSUSBLOG_LOCAL_PROFILE/u)
  assert.match(localBranch, /fsusblog\.perception-v2\.union-projection\.v1/u)
  assert.match(localBranch, /FSUSBLOG_TEST_RUN_ID/u)
  assert.match(localBranch, /backend-tests-ready\.json/u)
  assert.match(localBranch, /FSUSBLOG_BACKEND_TEST_DLL/u)
  assert.match(localBranch, /PerceptionChallengeV2E2eTests/u)
  assert.match(localBranch, /entry\.outcome !== 'Passed'/u)
  assert.doesNotMatch(localBranch, /dotnet test|check-perception-v2-e2e-evidence/u)
  assert.match(standaloneBranch, /FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild/u)
  assert.match(standaloneBranch, /dotnet_args=\(--no-build --no-restore\)/u)
  assert.match(standaloneBranch, /EnsureBackendFilteredBuild[\s\S]*?dotnet test[\s\S]*?check-perception-v2-e2e-evidence/u)
})

test('rights v3 matrix consumes the shared Debug build without another writer', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/rights-v3-test-matrix.sh'), 'utf8')
  const producer = lane.indexOf('FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild')
  const reader = lane.indexOf('dotnet test tests/backend/FsusBlog.Server.Tests.csproj')

  assert.match(lane, /source .*\/_lane-collect-support\.sh/u)
  assert.ok(producer >= 0, 'rights v3 must prepare the shared Debug build')
  assert.ok(reader > producer, 'rights v3 tests must run after the shared Debug producer')
  assert.match(lane.slice(reader), /--configuration Debug[\s\S]*?--no-build[\s\S]*?--no-restore/u)
})

for (const laneName of ['aeds-frame-cost', 'aeds-compression-profile']) {
  test(`${laneName} reuses the fresh local Release benchmark build`, () => {
    const lane = fs.readFileSync(path.join(root, `tools/test/lanes/${laneName}.sh`), 'utf8')

    assert.match(lane, /tools\/test\/ensure-benchmark-release-build\.sh/u)
    assert.match(lane, /--no-build/u)
    assert.match(lane, /--no-restore/u)
    assert.doesNotMatch(lane, /dotnet build/u)
  })
}
