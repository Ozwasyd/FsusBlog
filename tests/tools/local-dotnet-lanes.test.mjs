import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('perception matrix reuses the fresh local backend build', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/perception-v2-test-matrix.sh'), 'utf8')

  assert.match(lane, /FSUSBLOG_LOCAL_PROFILE/u)
  assert.match(lane, /--no-build/u)
  assert.match(lane, /--no-restore/u)
})

for (const laneName of ['aeds-frame-cost', 'aeds-compression-profile']) {
  test(`${laneName} reuses the fresh local Release benchmark build`, () => {
    const lane = fs.readFileSync(path.join(root, `tools/test/lanes/${laneName}.sh`), 'utf8')

    assert.match(lane, /FSUSBLOG_LOCAL_PROFILE/u)
    assert.match(lane, /--no-build/u)
    assert.match(lane, /--no-restore/u)
  })
}
