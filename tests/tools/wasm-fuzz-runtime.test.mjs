import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const lane = await readFile(new URL('../../tools/test/lanes/wasm-fuzz-regression.sh', import.meta.url), 'utf8')
const runner = await readFile(new URL('../../tools/security/run-wasm-fuzz.mjs', import.meta.url), 'utf8')
const releaseVerifier = await readFile(new URL('../../tools/operations/check-release-evidence-manifest.mjs', import.meta.url), 'utf8')
const evidenceCollector = await readFile(new URL('../../tools/operations/collect-release-evidence.sh', import.meta.url), 'utf8')

test('wasm fuzz lane executes the real decoder instead of projecting an environment marker', () => {
  assert.match(lane, /exec node "\$ROOT_DIR\/tools\/security\/run-wasm-fuzz\.mjs"/u)
  assert.doesNotMatch(lane, /FSUSBLOG_WASM_FUZZ_SEEDS_RUN/u)
  assert.match(runner, /decoderVariants = \['basic', 'speed'\]/u)
  assert.match(runner, /readFile\(variant\.wasmPath\)/u)
  assert.match(runner, /createAedsModule\(\{ wasmBinary/u)
  assert.match(runner, /instance\._decode_io_buffer\(inputToken, input\.byteLength\)/u)
  assert.match(runner, /wasm_fuzz_tier_differential/u)
  assert.match(runner, /wasm_fuzz_arena_clear_failed/u)
  assert.match(runner, /input\.byteLength === 0[\s\S]*instance\._decode_io_buffer\(0n, 0\)/u)
})

test('wasm fuzz evidence is run-bound, reproducible, and cannot report success without executed seeds', () => {
  assert.match(runner, /FSUSBLOG_TEST_NAMESPACE/u)
  assert.match(runner, /function seedFor\(corpusIndex, iteration\)/u)
  assert.match(runner, /seedsRun \+= 1/u)
  assert.match(runner, /status: 'ok',[\s\S]*executionSource: 'fresh-wasm-runtime'/u)
  assert.match(runner, /status: 'failure',[\s\S]*blocker: 'wasm-fuzz-execution-failed'/u)
  assert.match(runner, /process\.exitCode = 1/u)
})

test('wasm fuzz workload scales from the scheduler CPU grant with a non-zero floor', () => {
  assert.match(runner, /FSUSBLOG_STEP_CPU_BUDGET[\s\S]*FSUSBLOG_TIER_CPU_UNITS[\s\S]*FSUSBLOG_BUNDLE_CPU_UNITS/u)
  assert.doesNotMatch(runner, /FSUSBLOG_STEP_CPU_UNITS/u)
  assert.match(runner, /Math\.max\(64, grantedCpu \* 64\)/u)
  assert.match(runner, /corpus\.map\(\(entry, corpusIndex\)/u)
})

test('release evidence rejects marker-only wasm fuzz summaries', () => {
  for (const source of [releaseVerifier, evidenceCollector]) {
    assert.match(source, /fresh-wasm-runtime/u)
    assert.match(source, /seedPlan/u)
    assert.match(source, /sha256/u)
    assert.match(source, /crashes/u)
  }
})
