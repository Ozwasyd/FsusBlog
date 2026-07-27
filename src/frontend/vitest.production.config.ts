import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import model from './vitest.model.config'
import perf from './vitest.perf.config'
import property from './vitest.property.config'
import unit from './vitest.config'
import { createVitestRuntimeOptions, resolveVitestCoverageDirectory } from './vitest.shared.mjs'

const unitCoverage = (unit as Record<string, any>).test.coverage
const rollingHost = process.env.FSUSBLOG_VITEST_ROLLING_HOST === '1'
const coverageUniverseOwner = process.env.FSUSBLOG_VITEST_COVERAGE_UNIVERSE_OWNER === '1'
const rollingShardCoverage = rollingHost && !coverageUniverseOwner
  ? {
      ...unitCoverage,
      // Ordinary rolling hosts instrument only files reached by their immutable
      // partition. One real test host owns the all-files universe, avoiding a
      // second no-matching Vitest cold start without weakening final coverage.
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
      reportsDirectory: resolveVitestCoverageDirectory('coverage/perf-transform-cache-no-coverage'),
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
