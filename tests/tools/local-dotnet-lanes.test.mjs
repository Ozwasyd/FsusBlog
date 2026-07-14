import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('perception matrix projects the fresh production union and keeps standalone execution', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/perception-v2-test-matrix.sh'), 'utf8')
  const localBranch = lane.slice(lane.indexOf('if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]'), lane.indexOf('\ndotnet_args=()'))

  assert.match(lane, /FSUSBLOG_LOCAL_PROFILE/u)
  assert.match(localBranch, /fsusblog\.perception-v2\.union-projection\.v1/u)
  assert.match(localBranch, /FSUSBLOG_TEST_RUN_ID/u)
  assert.match(localBranch, /backend-tests-ready\.json/u)
  assert.match(localBranch, /FSUSBLOG_BACKEND_TEST_DLL/u)
  assert.match(localBranch, /PerceptionChallengeV2E2eTests/u)
  assert.match(localBranch, /entry\.outcome !== 'Passed'/u)
  assert.doesNotMatch(localBranch, /dotnet test|check-perception-v2-e2e-evidence/u)
  assert.match(lane.slice(lane.indexOf('\ndotnet_args=()')), /dotnet test[\s\S]*?check-perception-v2-e2e-evidence/u)
})

for (const laneName of ['aeds-frame-cost', 'aeds-compression-profile']) {
  test(`${laneName} reuses the fresh local Release benchmark build`, () => {
    const lane = fs.readFileSync(path.join(root, `tools/test/lanes/${laneName}.sh`), 'utf8')

    assert.match(lane, /FSUSBLOG_LOCAL_PROFILE/u)
    assert.match(lane, /--no-build/u)
    assert.match(lane, /--no-restore/u)
  })
}
