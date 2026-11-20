import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
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

const serverUrl = process.env.FSUS_SERVER_URL ?? 'http://127.0.0.1:5080'
const webPort = Number(process.env.FSUS_WEB_PORT ?? 5173)

const sitePagePaths = new Set(['/about', '/privacy', '/guidelines', '/copyright'])

function fetchServerShellFragments(requestPath: string, requestHost: string | undefined): Promise<{ headTags: string[]; publicContent?: string }> {
  return new Promise(resolveFragments => {
    let target: URL
    try {
      target = new URL(serverUrl)
    } catch {
      resolveFragments({ headTags: [] })
      return
    }
    const cleanPath = requestPath.split('?', 1)[0] || '/'
    const isSitePage = sitePagePaths.has(cleanPath)
    const probePath = cleanPath.startsWith('/admin') ? '/admin/identity' : isSitePage ? cleanPath : '/'
    const req = http.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: probePath,
      method: 'GET',
      timeout: 400,
      headers: requestHost ? { host: requestHost, accept: 'text/html' } : { accept: 'text/html' },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        resolveFragments({ headTags: [] })
        return
      }
      let body = ''
      res.setEncoding('utf8')
      const limit = isSitePage ? 700_000 : 32_768
      res.on('data', chunk => {
        if (body.length < limit) body += chunk
      })
      res.on('end', () => {
        const headEnd = body.indexOf('</head>')
        const head = headEnd >= 0 ? body.slice(0, headEnd) : body
        const metas = head.match(/<meta\s+name="fsus-[^"]+"[^>]*>/gi) ?? []
        const styles = head.match(/<link\s+rel="stylesheet"\s+href="\/site-appearance\/[^"]+"[^>]*>/gi) ?? []
        let publicContent: string | undefined
        if (isSitePage) {
          const match = body.match(/<div\s+id="app">([\s\S]*?)<\/div>\s*(?:<script|<\/body>)/i)
          if (match?.[1]) publicContent = match[1]
        }
        resolveFragments({ headTags: [...metas, ...styles], publicContent })
      })
    })
    req.on('timeout', () => { req.destroy(); resolveFragments({ headTags: [] }) })
    req.on('error', () => resolveFragments({ headTags: [] }))
    req.end()
  })
}

function syncServerHeadMeta(): Plugin {
  const requestHost = new AsyncLocalStorage<string | undefined>()
  return {
    name: 'fsus-dev-server-meta',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        requestHost.run(req.headers.host, next)
      })
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        const { headTags, publicContent } = await fetchServerShellFragments(ctx.originalUrl ?? ctx.path, requestHost.getStore())
        let result = html
        if (headTags.length > 0)
          result = result.replace('</head>', `    ${headTags.join('\n    ')}\n  </head>`)
        if (publicContent)
          result = result.replace('<!--fsus-public-content-->', publicContent)
        return result
      },
    },
  }
}

function companionLoopback(): Plugin {
  return {
    name: 'fsus-companion-loopback',
    apply: 'serve',
    configureServer(server) {
      const httpServer = server.httpServer
      if (!httpServer) return
      let companion: net.Server | undefined
      httpServer.once('listening', () => {
        const address = httpServer.address()
        if (!address || typeof address === 'string') return
        const targetHost = address.address === '::1' ? '::1' : address.address === '127.0.0.1' ? '127.0.0.1' : undefined
        if (!targetHost) return
        const mirrorHost = targetHost === '::1' ? '127.0.0.1' : '::1'
        const proxy = net.createServer(client => {
          const upstream = net.connect({ host: targetHost, port: address.port })
          client.pipe(upstream)
          upstream.pipe(client)
          const destroy = () => {
            client.destroy()
            upstream.destroy()
          }
          client.on('error', destroy)
          upstream.on('error', destroy)
        })
        proxy.on('error', () => {})
        proxy.listen({ host: mirrorHost, port: address.port, ipv6Only: mirrorHost === '::1' })
        companion = proxy
      })
      httpServer.once('close', () => { companion?.close() })
    },
  }
}

const proxyRule = { target: serverUrl, changeOrigin: false }
const plugins = () => [resolvePreparedWasm(), vue(), vueJsx()]
export default defineConfig({
  plugins: [...plugins(), syncServerHeadMeta(), companionLoopback()],
  worker: { format: 'es', plugins },
  build: {
    rollupOptions: {
      output: {
        // Keep transitive dependencies in Rollup's shared chunks. These selected
        // leaf/model modules have no dependency back into the Write view.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/')
          if (normalized.endsWith('/src/authoring/workspaceRegistry.ts') ||
              /\/src\/Contracts\/(property-values|property-text-hit|document-export-tasks|markdown-export)\.ts$/.test(normalized)) {
            return 'authoring-model'
          }
          // Independent ESM libraries, not Mermaid internals or its parser.
          // Keep every diagram loader, including Wardley, unchanged.
          if (/\/node_modules\/(dompurify|marked|roughjs|d3-[^/]+)\//.test(normalized)) {
            return 'diagram-primitives'
          }
        },
      },
    },
  },
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
    host: 'localhost',
    port: Number.isFinite(webPort) && webPort > 0 ? webPort : 5173,
    strictPort: true,
    fs: { allow: [root, uiRoot, wasmDir] },
    proxy: {
      '/api': { ...proxyRule, ws: true },
      '/public-media': proxyRule,
      '/site-appearance': proxyRule,
      '/integrity': proxyRule,
      '/feed': proxyRule,
      '/sitemap.xml': proxyRule,
      '/sitemap': proxyRule,
      '/robots.txt': proxyRule,
      '/health': proxyRule,
    },
  },
})
