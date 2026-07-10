import { defineConfig } from 'vitest/config'

import model from './vitest.model.config'
import perf from './vitest.perf.config'
import property from './vitest.property.config'
import unit from './vitest.config'
import { createVitestRuntimeOptions } from './vitest.shared.mjs'

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
    projects: [
      project('unit', unit as Record<string, any>),
      project('property', property as Record<string, any>),
      project('model', model as Record<string, any>),
      project('perf', perf as Record<string, any>)
    ],
    coverage: (unit as Record<string, any>).test.coverage
  }
})
