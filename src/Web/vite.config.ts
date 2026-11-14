import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sibling = fileURLToPath(new URL('../../../FsusUI/', import.meta.url))
if (!existsSync(join(sibling, 'vue/packages/element-plus/index.ts'))) {
  throw new Error('FsusUI source is required in ../FsusUI next to the FsusBlogV2 checkout.')
}
const uiRoot = realpathSync(sibling)
const packages = join(uiRoot, 'vue/packages')
const entry = join(packages, 'element-plus/index.ts')
const nativeFiles = [
  'ep_wasm.mjs',
  'ep_wasm.wasm',
  'markdown_basic.js',
  'markdown_basic.wasm',
  'markdown_simd.js',
  'markdown_simd.wasm',
]
const localWasm = join(packages, 'wasm/dist')
const preparedWasm = process.env.FSUSBLOG_FSUSUI_WASM_DIST
const wasmDir = preparedWasm ? resolve(preparedWasm) : localWasm
const nativeMarkdown = nativeFiles.every(name => existsSync(join(wasmDir, name)))
if (preparedWasm) {
  if (!nativeMarkdown || !existsSync(join(wasmDir, '.native-artifact-fingerprint'))) {
    throw new Error('Prepared FsusUI Wasm requires the native asset set and its source fingerprint.')
  }
  const cacheTool = pathToFileURL(join(uiRoot, 'scripts/test-artifact-cache.mjs')).href
  const { artifactGroups, hashInputPatterns } = await import(cacheTool) as {
    artifactGroups: { wasm: { fingerprints: { id: string; inputPatterns: string[] }[] } }
    hashInputPatterns(patterns: string[]): Promise<{ hash: string }>
  }
  const authority = artifactGroups.wasm.fingerprints.find(entry => entry.id === 'native')
  const fingerprint = readFileSync(join(wasmDir, '.native-artifact-fingerprint'), 'utf8').trim()
  if (!authority || fingerprint !== (await hashInputPatterns(authority.inputPatterns)).hash) {
    throw new Error('Prepared FsusUI Wasm does not match the sibling source checkout.')
  }
}

function resolvePreparedWasm(): Plugin {
  const assetsModule = join(packages, 'wasm/runtime/assets.ts')
  return {
    name: 'fsusui-prepared-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!preparedWasm || id !== assetsModule) return
      let rewritten = code
      for (const name of nativeFiles) {
        const fromSource = relative(dirname(assetsModule), join(wasmDir, name)).replaceAll('\\', '/')
        const url = fromSource.startsWith('.') ? fromSource : './' + fromSource
        const expected = `'../dist/${name}'`
        if (!rewritten.includes(expected)) throw new Error(`Unknown FsusUI asset declaration for ${name}.`)
        rewritten = rewritten.replace(expected, JSON.stringify(url))
      }
      return rewritten
    },
  }
}

const plugins = () => [resolvePreparedWasm(), vue(), vueJsx()]
export default defineConfig({
  plugins: plugins(),
  worker: { format: 'es', plugins },
  resolve: {
    dedupe: ['vue'],
    alias: [
      { find: /^@ozwasyd\/element-plus$/, replacement: entry },
      {
        find: /^@ozwasyd\/element-plus\/(theme|icons-vue|markdown-runtime)$/,
        replacement: join(packages, 'element-plus/$1.ts'),
      },
      {
        find: /^@ozwasyd\/element-plus\/dist\/fsus\.css$/,
        replacement: join(packages, 'theme-chalk/src/fsus.scss'),
      },
      { find: /^element-plus$/, replacement: entry },
      { find: /^@element-plus\/icons-vue$/, replacement: join(packages, 'icons-vue/src/index.ts') },
      { find: /^@element-plus\/icons-vue\/(.+)$/, replacement: join(packages, 'icons-vue/src/$1') },
      { find: /^@element-plus\/(.+)$/, replacement: join(packages, '$1') },
    ],
  },
  optimizeDeps: { exclude: ['@ozwasyd/element-plus', '@ozwasyd/element-plus/theme', '@ozwasyd/element-plus/markdown-runtime'] },
  define: { 'import.meta.env.FSUS_MARKDOWN_NATIVE': JSON.stringify(nativeMarkdown) },
  server: {
    host: '127.0.0.1',
    fs: { allow: [root, uiRoot, wasmDir] },
    proxy: {
      '/api': { target: process.env.FSUS_SERVER_URL ?? 'http://127.0.0.1:5080', changeOrigin: false },
    },
  },
})
