import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/perf-regression.sh'), 'utf8')
const legacy = fs.readFileSync(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')

test('backend perf overlaps read-only production readiness while keeping standalone builds after native P99', () => {
  assert.match(lane, /FSUSBLOG_BACKEND_PERF_READINESS_MODE:-build.*verify-fresh/su)
  assert.match(lane, /verify-fresh[\s\S]*?export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release/u)
  assert.match(lane, /run_collect_parallel backend-perf-native-readiness/u)
  assert.match(lane, /native-p99 run_backend_perf_native_p99_only/u)
  assert.match(lane, /readiness-verify run_backend_perf_readiness_build_only/u)
  assert.match(lane, /governance run_backend_perf_governance_only/u)
  assert.match(lane, /run_collect_parallel backend-perf-native-governance.*run_collect readiness-build run_backend_perf_readiness_build_only/su)
  assert.match(lane, /finish_collect/u)
})

test('backend perf Release build uses the live dynamic MSBuild grant and standard reusable output', () => {
  assert.match(legacy, /FSUSBLOG_DOTNET_BUILD_PARALLELISM:-dynamic/u)
  assert.match(legacy, /resolve-dotnet-build-parallelism\.mjs/u)
  assert.match(legacy, /dotnet build "\$ROOT_DIR\/benchmarks\/core\/FsusBlog\.Core\.Benchmarks\.csproj" -c Release/u)
  assert.doesNotMatch(legacy, /run_backend_perf_readiness_build_only\(\)[\s\S]*?--no-?dependencies/u)
})

test('backend perf native P99 consumes the fresh Release test assembly without a duplicate Debug build', () => {
  assert.match(legacy, /backend_test_configuration\(\)[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION:-Debug/u)
  assert.match(legacy, /Debug\|Release/u)
  assert.match(legacy, /tests\/backend\/bin\/Release\/net10\.0\/FsusBlog\.Server\.Tests\.dll/u)
  assert.match(legacy, /reuse backend \$configuration build from local physical build bundle/u)
  assert.match(legacy, /dotnet test "\$SERVER_TEST_PROJ" -c "\$configuration" -v minimal --no-build/u)
})
