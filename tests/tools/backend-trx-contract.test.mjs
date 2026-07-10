import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const legacy = await readFile(new URL('../../tools/test/legacy-test.sh', import.meta.url), 'utf8')
const coverage = await readFile(new URL('../../tools/coverage/collect-backend-coverage.sh', import.meta.url), 'utf8')

function shellFunction(source, name) {
  const start = source.indexOf(`${name}() {`)
  assert.notEqual(start, -1, `missing shell function ${name}`)
  const end = source.indexOf('\n}', start)
  assert.notEqual(end, -1, `unterminated shell function ${name}`)
  return source.slice(start, end + 2)
}

test('every filtered backend helper writes a stable lane TRX result', () => {
  const filtered = shellFunction(legacy, 'run_backend_dotnet_filter_only')
  const covered = shellFunction(legacy, 'run_backend_dotnet_filter_with_coverage')
  assert.match(legacy, /BACKEND_TRX_DIR=.*\.tmp\/test-results\/backend/u)
  assert.match(filtered, /backend_trx_file/u)
  assert.match(filtered, /--logger "trx;LogFileName=\$trx_file"/u)
  assert.match(covered, /backend_trx_file/u)
  assert.match(covered, /--logger "trx;LogFileName=\$trx_file"/u)
})

test('ordinary backend coverage writes its own stable lane TRX result', () => {
  assert.match(coverage, /BACKEND_TRX_DIR=.*\.tmp\/test-results\/backend/u)
  assert.match(coverage, /coverage-backend\.trx/u)
  assert.match(coverage, /--logger "trx;LogFileName=\$TRX_FILE"/u)
})
