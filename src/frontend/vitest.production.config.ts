import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import model from './vitest.model.config'
import perf from './vitest.perf.config'
import property from './vitest.property.config'
import unit from './vitest.config'
import { createVitestRuntimeOptions } from './vitest.shared.mjs'

const unitCoverage = (unit as Record<string, any>).test.coverage
const rollingShardCoverage = process.env.FSUSBLOG_VITEST_SINGLE_HOST === '1'
  ? {
      ...unitCoverage,
      // Each rolling process instruments only the files it actually executes.
      // The dedicated full-universe seed and final blob merge retain the complete
      // production coverage contract without repeating it in every shard.
      include: undefined
    }
  : unitCoverage
const transformCachePath = process.env.FSUSBLOG_VITEST_TRANSFORM_CACHE_PATH?.trim()
const transformCacheIdentity = process.env.FSUSBLOG_VITEST_TRANSFORM_CACHE_IDENTITY?.trim()
const perfTransformCacheConsumer = process.env.FSUSBLOG_VITEST_PERF_TRANSFORM_CACHE_CONSUMER === '1'

if (Boolean(transformCachePath) !== Boolean(transformCacheIdentity)) {
  throw new Error('run-bound Vitest transform cache requires both path and identity')
}
if (perfTransformCacheConsumer && !transformCachePath) {
  throw new Error('perf transform-cache consumer requires a validated run-bound cache')
}

const productionCoverage = perfTransformCacheConsumer
  ? {
      provider: 'custom' as const,
      enabled: true,
      customProviderModule: fileURLToPath(new URL('./vitest.transform-cache-coverage.mjs', import.meta.url)),
      reportsDirectory: '.tmp/perf-transform-cache-no-coverage',
      reporter: [],
      clean: false,
      cleanOnRerun: false,
      reportOnFailure: false
    }
  : rollingShardCoverage

function project(name: string, config: Record<string, any>) {
  return {
    ...config,
    test: {
      ...config.test,
      name
    }
  }
}

export default defineConfig({
  test: {
    ...createVitestRuntimeOptions('production'),
    deps: { optimizer: { ssr: { enabled: true } } },
    projects: [
      project('unit', unit as Record<string, any>),
      project('property', property as Record<string, any>),
      project('model', model as Record<string, any>),
      project('perf', perf as Record<string, any>)
    ],
    coverage: productionCoverage,
    experimental: transformCachePath
      ? { fsModuleCache: true, fsModuleCachePath: transformCachePath }
      : undefined
  }
})
