import { defineConfig, mergeConfig, type UserConfig, type ConfigEnv } from 'vite'

// Load the app config factory without enabling HMR or file watching so
// Playwright fixture pages cannot be reloaded mid-test by the optimizer.
const baseModule = await import('./vite.config')
const baseExport = baseModule.default

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const base =
    typeof baseExport === 'function'
      ? await Promise.resolve(baseExport(env))
      : baseExport

  return mergeConfig(base as UserConfig, {
    server: {
      hmr: false,
      watch: null
    }
  })
})
