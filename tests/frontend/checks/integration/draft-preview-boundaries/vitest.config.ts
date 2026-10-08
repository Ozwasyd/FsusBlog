import { mergeConfig } from '../../../../../src/frontend/node_modules/vitest/dist/config.js'
import Components from '../../../../../src/frontend/node_modules/unplugin-vue-components/dist/vite.mjs'
import base from '../../../../../src/frontend/vitest.config'

// The production entry creates its own apps; use the production public-component
// resolver without modifying shared test setup or aliasing a substitute component.
export default mergeConfig(base, {
  plugins: [Components({
    dts: false,
    exclude: [/\/FsusUI\/vue\/packages\//],
    resolvers: [(name: string) => /^El[A-Z]/.test(name) ? { name, from: '@ozwasyd/element-plus' } : undefined],
  })],
})
