import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite'

import frontendConfig from './vite.config'

const frontendRoot = fileURLToPath(new URL('.', import.meta.url))
const fixtureNamespace = process.env.FSUSBLOG_LIGHTBOX_FIXTURE_NAMESPACE?.trim() || 'manual'
if (!/^(?:manual|\d+)$/u.test(fixtureNamespace)) {
  throw new Error(`invalid article lightbox production surface namespace: ${fixtureNamespace}`)
}
const fixtureSegment = `__issue2379_lightbox_${fixtureNamespace}`
const fixtureOutDir = path.join(frontendRoot, `dist/assets/${fixtureSegment}`)

export default defineConfig(async (env: ConfigEnv) => {
  const baseConfig = typeof frontendConfig === 'function'
    ? await frontendConfig(env)
    : await frontendConfig
  const merged = mergeConfig(baseConfig as UserConfig, {
    root: frontendRoot,
    base: `/assets/${fixtureSegment}/`,
    publicDir: false,
    build: {
      outDir: fixtureOutDir,
      emptyOutDir: true,
      manifest: false
    }
  })

  if (!merged.build) merged.build = {}
  merged.build.rolldownOptions = {
    ...(merged.build.rolldownOptions ?? {}),
    input: path.join(frontendRoot, 'test-fixtures/article-lightbox-production-surface.html')
  }
  return merged
})
