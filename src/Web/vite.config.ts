import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const requireFromWeb = createRequire(import.meta.url)
const fsusUiPackageRoot = dirname(dirname(requireFromWeb.resolve('@ozwasyd/element-plus')))
const nativeFiles = [
  'ep_wasm.mjs',
  'ep_wasm.wasm',
  'markdown_basic.js',
  'markdown_basic.wasm',
  'markdown_simd.js',
  'markdown_simd.wasm',
]
const wasmDir = join(fsusUiPackageRoot, 'es/wasm/dist')
const nativeMarkdown = nativeFiles.every(name => existsSync(join(wasmDir, name)))
if (!nativeMarkdown) {
  throw new Error('Installed @ozwasyd/element-plus package is missing its bundled native Wasm assets.')
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
        const manifests = head.match(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"[^>]*>/gi) ?? []
        let publicContent: string | undefined
        if (isSitePage) {
          const match = body.match(/<div\s+id="app">([\s\S]*?)<\/div>\s*(?:<script|<\/body>)/i)
          if (match?.[1]) publicContent = match[1]
        }
        resolveFragments({ headTags: [...metas, ...styles, ...manifests], publicContent })
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
const plugins = () => [vue(), vueJsx()]
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
          if (/\/src\/authoring\/(workspaceRegistry|draftMarkdownImport|splitLayoutModel|sourceHandoffCoordinator|writeCommandAdapter|writeWorkspaceController)\.ts$/.test(normalized) ||
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
  },
  optimizeDeps: { exclude: ['@ozwasyd/element-plus', '@ozwasyd/element-plus/theme', '@ozwasyd/element-plus/markdown-runtime'] },
  define: { 'import.meta.env.FSUS_MARKDOWN_NATIVE': JSON.stringify(nativeMarkdown) },
  server: {
    host: 'localhost',
    port: Number.isFinite(webPort) && webPort > 0 ? webPort : 5173,
    strictPort: true,
    fs: { allow: [root] },
    proxy: {
      '/api': { ...proxyRule, ws: true },
      '/public-media': proxyRule,
      '/site-appearance': proxyRule,
      '/manifest.webmanifest': proxyRule,
      '/integrity': proxyRule,
      '/feed': proxyRule,
      '/sitemap.xml': proxyRule,
      '/sitemap': proxyRule,
      '/robots.txt': proxyRule,
      '/health': proxyRule,
    },
  },
})
