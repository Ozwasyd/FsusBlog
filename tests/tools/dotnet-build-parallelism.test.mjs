import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDotnetBuildParallelism } from '../../tools/test/resolve-dotnet-build-parallelism.mjs'

test('dotnet build consumes an admitted scheduler CPU grant without a second memory cap', () => {
  assert.equal(resolveDotnetBuildParallelism({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '4',
      FSUSBLOG_STEP_MEMORY_GIB: '2'
    },
    cpuCount: 8,
    freeMemoryBytes: 512 * 1024 ** 2,
    totalMemoryBytes: 16 * 1024 ** 3,
    load1: 7
  }), 4)
})

test('dotnet build honors the nested worker cap inside a larger scheduler grant', () => {
  assert.equal(resolveDotnetBuildParallelism({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '6',
      FSUSBLOG_STEP_MEMORY_GIB: '6',
      FSUSBLOG_COMMAND_MANIFEST_WORKERS: '2'
    },
    cpuCount: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    load1: 0
  }), 2)
})

test('direct dotnet build derives its cap from live host CPU, load, and memory', () => {
  assert.equal(resolveDotnetBuildParallelism({
    env: {},
    cpuCount: 8,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    load1: 2
  }), 2)
})
