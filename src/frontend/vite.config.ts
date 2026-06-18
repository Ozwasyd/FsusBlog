import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { createFsusUiAliases, resolveFsusUiWasmDist, resolveLocalFsusUiRoot } from './scripts/fsusui-local'

const FRONTEND_ROOT = fileURLToPath(new URL('./', import.meta.url))
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '../..')

function resolveAdminManualChunk(id: string): string | undefined {
    if (
        id.includes('/src/views/admin/article/') ||
        id.includes('/src/components/admin/article/') ||
        id.includes('/src/composables/useAdminArticle')
    ) {
        return 'route-admin-article'
    }
    if (
        id.includes('/src/views/admin/moderation/') ||
        id.includes('/src/components/admin/comment-moderation/') ||
        id.includes('/src/components/admin/moderation/')
    ) {
        return 'route-admin-moderation'
    }
    if (
        id.includes('/src/views/admin/security/') ||
        id.includes('/src/components/admin/security/')
    ) {
        return 'route-admin-security'
    }
    if (
        id.includes('/src/views/admin/UserManage.vue') ||
        id.includes('/src/components/admin/users/')
    ) {
        return 'route-admin-users'
    }
    if (
        id.includes('/src/views/admin/OpsHealth.vue') ||
        id.includes('/src/views/admin/CacheDiagnostics.vue') ||
        id.includes('/src/views/admin/Integrity.vue') ||
        id.includes('/src/views/admin/AuditLog.vue')
    ) {
        return 'route-admin-ops'
    }
    if (
        id.includes('/src/views/admin/Dashboard.vue') ||
        id.includes('/src/components/admin/Dashboard') ||
        id.includes('/src/composables/useAdminDashboard')
    ) {
        return 'route-admin-dashboard'
    }
    if (
        id.includes('/src/views/admin/Settings.vue') ||
        id.includes('/src/views/admin/Category.vue') ||
        id.includes('/src/views/admin/Tag.vue') ||
        id.includes('/src/views/admin/Assets.vue') ||
        id.includes('/src/views/admin/ContentTools.vue')
    ) {
        return 'route-admin-content'
    }
    if (
        id.includes('/src/views/admin/MessageCenter.vue') ||
        id.includes('/src/composables/useAdminMessage')
    ) {
        return 'route-admin-messages'
    }

    return undefined
}

function resolveManualChunk(id: string): string | undefined {
    if (!id.includes('node_modules')) {
        const adminChunk = resolveAdminManualChunk(id)
        if (adminChunk) {
            return adminChunk
        }

        if (
            id.includes('/src/views/user/') ||
            id.includes('/src/layouts/AccountLayout.vue') ||
            id.includes('/src/components/user/') ||
            id.includes('/src/layouts/accountNav.ts')
        ) {
            return 'route-user'
        }
        if (
            id.includes('/src/views/admin/') ||
            id.includes('/src/components/admin/') ||
            id.includes('/src/composables/useAdmin')
        ) {
            return 'route-admin'
        }
        if (id.includes('/src/views/error/')) {
            return 'route-error'
        }
        if (id.includes('/src/views/auth/')) {
            return 'route-auth'
        }
        if (
            id.includes('/src/bootstrap/publicShellPrimitives.ts') ||
            id.includes('/src/bootstrap/entry.ts') ||
            id.includes('/src/services/themeRuntime.ts')
        ) {
            return 'entry-runtime'
        }
        if (
            id.includes('/src/public-renderers/publicRouteRegistry.ts') ||
            id.includes('/src/public-renderers/publicRoutePaths.ts') ||
            id.includes('/src/public-renderers/publicFixedPageSemantics.ts') ||
            id.includes('/src/public-renderers/generated/publicPageManifest.ts')
        ) {
            return 'public-route-core'
        }
        if (
            id.includes('/src/bootstrap/publicShell.ts') ||
            id.includes('/src/bootstrap/publicHydrationBootstrap.ts') ||
            id.includes('/src/public-renderers/')
        ) {
            return 'public-page-runtime'
        }
        if (
            id.includes('/src/components/ui/MarkdownRenderer.vue') ||
            id.includes('/src/services/markdownActivationService.ts') ||
            id.includes('/src/services/fsusMarkdownRuntime.ts') ||
            id.includes('/src/services/shikiHighlighter.ts')
        ) {
            return 'markdown-runtime'
        }
        if (id.includes('/src/bootstrap/fullApp.ts') || id.includes('/src/router/') || id.includes('/src/App.vue')) {
            return 'full-app-core'
        }
        return undefined
    }

    if (id.includes('/node_modules/@ozwasyd/element-plus/es/components/config-provider/src/theme-mode')) {
        return 'entry-runtime'
    }
    if (
        id.includes('/node_modules/@ozwasyd/element-plus/') ||
        id.includes('/node_modules/@element-plus/')
    ) {
        return 'vendor-element-plus'
    }
    if (id.includes('/node_modules/echarts/')) {
        return 'vendor-echarts'
    }
    if (id.includes('/node_modules/nprogress/')) {
        return 'vendor-progress'
    }
    if (
        id.includes('/node_modules/pinia/') ||
        id.includes('/node_modules/pinia-plugin-persistedstate/') ||
        id.includes('/node_modules/vue-router/')
    ) {
        return 'vendor-runtime'
    }
    if (id.includes('/node_modules/@unhead/')) {
        return 'vendor-vueuse'
    }
    if (id.includes('/node_modules/@vue/') || id.includes('/node_modules/vue/')) {
        return 'vendor-vue'
    }

    return undefined
}

function shouldIgnoreBuildWarning(warning: { message?: string; id?: string }): boolean {
    if (
        warning.message?.includes('[PLUGIN_TIMINGS]') ||
        warning.message?.includes('Your build spent significant time in plugin')
    ) {
        return true
    }

    return false
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createLocalFsusUiTransformExcludes(localFsusUiRoot: string | null): RegExp[] {
    const defaults = [
        /[\\/]node_modules[\\/]/,
        /[\\/]\.git[\\/]/,
    ]

    if (!localFsusUiRoot) {
        return defaults
    }

    const normalizedRoot = localFsusUiRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    return [
        ...defaults,
        new RegExp(`${escapeRegExp(normalizedRoot)}/packages/`),
    ]
}

function tryRealpath(value: string): string | null {
    try {
        return fs.realpathSync(value)
    } catch {
        return null
    }
}

function createServerFsAllow(localFsusUiRoot: string | null, fsusUiWasmDist: string): string[] {
    const frontendNodeModules = path.resolve(FRONTEND_ROOT, 'node_modules')
    const candidates = [
        FRONTEND_ROOT,
        REPO_ROOT,
        frontendNodeModules,
        tryRealpath(frontendNodeModules),
        localFsusUiRoot,
        localFsusUiRoot ? tryRealpath(localFsusUiRoot) : null,
        fsusUiWasmDist,
        tryRealpath(fsusUiWasmDist)
    ]
    const seen = new Set<string>()

    return candidates.flatMap((candidate) => {
        if (!candidate) {
            return []
        }

        const resolved = path.resolve(candidate)
        if (seen.has(resolved)) {
            return []
        }

        seen.add(resolved)
        return [resolved]
    })
}

// Vite 8 在 dev 模式下会把 HMR 客户端注入到 module worker。
// HMR 客户端的 CSS 热更新路径直接访问 document.querySelectorAll，
// 但 Worker 全局作用域没有 document，导致 handleMessage 抛出 ReferenceError。
// 此插件在 CSS 热更新分支入口插入 hasDocument 守卫，使 Worker 跳过 CSS 更新。
function fixViteClientWorkerDocumentGuard() {
    // CSS hot update 分支的特征字符串（Vite 8.0.x client.mjs 中稳定存在）
    const MARKER = `if (update.type === "js-update") return hmrClient.queueUpdate(update);`
    const GUARD = `if (!("document" in globalThis)) return;`
    return {
        name: 'fix-vite-client-worker-document-guard',
        apply: 'serve' as const,
        transform(code: string, id: string) {
            if (!id.includes('/@vite/client') && !id.includes('vite/dist/client/client.mjs')) {
                return null
            }
            if (!code.includes(MARKER) || code.includes(GUARD)) {
                return null
            }
            return code.replace(MARKER, `${MARKER}\n                        ${GUARD}`)
        }
    }
}

function serveFsusUiOptimizedWasmAssets(fsusUiWasmDist: string) {
    const servedFiles = new Set([
        'markdown_simd.js',
        'markdown_simd.wasm',
        'markdown_basic.js',
        'markdown_basic.wasm'
    ])

    return {
        name: 'serve-fsusui-optimized-wasm-assets',
        apply: 'serve' as const,
        configureServer(server: any) {
            server.middlewares.use((request: any, response: any, next: () => void) => {
                const pathname = request.url?.split('?')[0] ?? ''
                const match = /^(?:\/node_modules\/\.vite)?\/dist\/([^/]+)$/.exec(pathname)
                const fileName = match?.[1]
                if (!fileName || !servedFiles.has(fileName)) {
                    next()
                    return
                }

                const filePath = path.join(fsusUiWasmDist, fileName)
                if (!fs.existsSync(filePath)) {
                    next()
                    return
                }

                response.statusCode = 200
                response.setHeader('Cache-Control', 'no-cache')
                response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'application/javascript')
                fs.createReadStream(filePath).pipe(response)
            })
        }
    }
}

function servePublicAotHydrationSidecars() {
    const sidecarPathPattern = /^\/aot-cache\/payloads\/[0-9a-f]{2}\/[0-9a-f]{64}\.aeds$/i
    const handleSidecar = (request: any, response: any, next: () => void) => {
        const pathname = request.url?.split(/[?#]/)[0] ?? ''
        if (!sidecarPathPattern.test(pathname)) {
            next()
            return
        }

        const relativeSidecarPath = pathname.slice(1)
        const filePath = [
            path.join(fileURLToPath(new URL('./dist/', import.meta.url)), relativeSidecarPath),
            path.join(fileURLToPath(new URL('../backend/wwwroot/', import.meta.url)), relativeSidecarPath)
        ].find((candidatePath) => fs.existsSync(candidatePath))
        if (!filePath) {
            next()
            return
        }

        const stats = fs.statSync(filePath)
        response.statusCode = 200
        response.setHeader('Content-Length', String(stats.size))
        response.setHeader('Content-Type', 'application/vnd.fsus.aeds')
        response.setHeader('Cache-Control', 'public,max-age=31536000,immutable')
        fs.createReadStream(filePath).pipe(response)
    }

    return {
        name: 'serve-public-aot-hydration-sidecars',
        apply: 'serve' as const,
        configureServer(server: any) {
            server.middlewares.use(handleSidecar)
        },
        configurePreviewServer(server: any) {
            server.middlewares.use(handleSidecar)
        }
    }
}

function setDevelopmentSecurityHeaders(response: any) {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()')
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function applyDevelopmentSecurityHeaders() {
    return {
        name: 'apply-development-security-headers',
        configureServer(server: any) {
            server.middlewares.use((_request: any, response: any, next: () => void) => {
                setDevelopmentSecurityHeaders(response)
                next()
            })
        },
        configurePreviewServer(server: any) {
            server.middlewares.use((_request: any, response: any, next: () => void) => {
                setDevelopmentSecurityHeaders(response)
                next()
            })
        }
    }
}

const publicSourceCssDevLinks = [
    {
        href: '/src/assets/public-shell-critical.css?direct',
        style: 'public-shell-critical'
    },
    {
        href: '/src/assets/public-page.css?direct',
        style: 'public-page'
    }
]

function injectPublicSourceCssInDev() {
    return {
        name: 'inject-public-source-css-in-dev',
        apply: 'serve' as const,
        transformIndexHtml(html: string) {
            const tags = publicSourceCssDevLinks
                .filter((link) => !html.includes(`href="${link.href}"`))
                .map((link) => `    <link rel="stylesheet" href="${link.href}" data-fsusblog-style="${link.style}" />`)

            if (tags.length === 0 || !html.includes('</head>')) {
                return html
            }

            return html.replace('</head>', `${tags.join('\n')}\n  </head>`)
        }
    }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd())
    const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || 'http://127.0.0.1:7568'
    const enableVueHydrationMismatchDetails = process.env.FSUSBLOG_VUE_HYDRATION_DETAILS === '1'
        || process.env.FSUSBLOG_VUE_HYDRATION_DETAILS?.toLowerCase() === 'true'
    const warnAsError = process.env.FSUSBLOG_VITE_WARN_AS_ERROR === '1'
        || process.env.FSUSBLOG_VITE_WARN_AS_ERROR?.toLowerCase() === 'true'
    const isPublicSsrBuild = process.env.FSUSBLOG_PUBLIC_SSR_BUILD === '1'
        || process.env.FSUSBLOG_PUBLIC_SSR_BUILD?.toLowerCase() === 'true'
    const enablePublicShellProxy = env.VITE_PUBLIC_SHELL_PROXY?.trim() === '1'
    const disableLocalFsusUi = process.env.FSUSBLOG_USE_LOCAL_FSUSUI === '0'
        || process.env.FSUSBLOG_USE_LOCAL_FSUSUI?.toLowerCase() === 'false'
    const localFsusUiRoot = !disableLocalFsusUi
        ? resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT)
        : null
    const fsusUiAliases = createFsusUiAliases(localFsusUiRoot)
    const fsusUiWasmDist = resolveFsusUiWasmDist(localFsusUiRoot)
    const localFsusUiTransformExcludes = createLocalFsusUiTransformExcludes(localFsusUiRoot)
    const serverFsAllow = createServerFsAllow(localFsusUiRoot, fsusUiWasmDist)

    const publicSeoProxy: ProxyOptions = {
        target: apiBaseUrl,
        changeOrigin: false,
        configure: (proxy: any) => {
            proxy.on('proxyReq', (proxyReq: any, req: any) => {
                const host = req.headers.host
                if (host) {
                    proxyReq.setHeader('X-Forwarded-Host', host)
                    proxyReq.setHeader('X-Forwarded-Proto', 'http')
                }
            })
        }
    }

    const publicRouteProxy: Record<string, ProxyOptions> = enablePublicShellProxy
        ? {
            '^/$': publicSeoProxy,
            '^/about/?$': publicSeoProxy,
            '^/archive/?$': publicSeoProxy,
            '^/article/\\d+/?$': publicSeoProxy,
            '^/category/\\d+/?$': publicSeoProxy,
            '^/tag/\\d+/?$': publicSeoProxy,
            '^/tag/[^/]+/?$': publicSeoProxy,
            '^/feed/(?:rss\\.xml|atom\\.xml|feed\\.json)$': publicSeoProxy,
            '^/robots\\.txt$': publicSeoProxy,
            '^/sitemap\\.xml$': publicSeoProxy,
        }
        : {}

    const sharedApiProxy: Record<string, ProxyOptions> = {
        '/api': {
            target: apiBaseUrl,
            ws: true,
            changeOrigin: true,
            configure: (proxy: any) => {
                proxy.on('proxyReqWs', (proxyReq: any, req: any) => {
                    const cookie = req.headers.cookie
                    if (cookie) {
                        proxyReq.setHeader('Cookie', cookie)
                    }

                    const host = req.headers.host
                    if (host) {
                        proxyReq.setHeader('X-Forwarded-Host', host)
                        proxyReq.setHeader('X-Forwarded-Proto', 'http')
                    }
                })
            }
        },
        '^/uploads/.*$': {
            target: apiBaseUrl,
            changeOrigin: true
        },
        '/hubs': {
            target: apiBaseUrl,
            ws: true,
            changeOrigin: true
        },
        '^/search/index\\.bin$': {
            target: apiBaseUrl,
            changeOrigin: true
        },
        '^/search/index\\.manifest\\.aeds$': {
            target: apiBaseUrl,
            changeOrigin: true
        },
        '^/search/index\\.(?:core|recent|archive|body)\\.[0-9a-f]{16}\\.bin$': {
            target: apiBaseUrl,
            changeOrigin: true
        },
        '^/search/patches/.*$': {
            target: apiBaseUrl,
            changeOrigin: true
        }
    }

    return {
        define: {
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(enableVueHydrationMismatchDetails)
        },
        plugins: [
            applyDevelopmentSecurityHeaders(),
            injectPublicSourceCssInDev(),
            fixViteClientWorkerDocumentGuard(),
            serveFsusUiOptimizedWasmAssets(fsusUiWasmDist),
            servePublicAotHydrationSidecars(),
            tailwindcss(),
            vue(),
            vueJsx(),
            AutoImport({
                exclude: localFsusUiTransformExcludes,
                resolvers: [
                    (name) => {
                        if (name.match(/^El[A-Z]/)) {
                            return { name, from: '@ozwasyd/element-plus' }
                        }
                    }
                ],
            }),
            Components({
                exclude: localFsusUiTransformExcludes,
                resolvers: [
                    (name) => {
                        if (name.match(/^El[A-Z]/)) {
                            return { name, from: '@ozwasyd/element-plus' }
                        }
                    }
                ],
            }),
        ],
        resolve: {
            alias: [
                ...fsusUiAliases,
                { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
                { find: '@wasm', replacement: fileURLToPath(new URL('./wasm/web', import.meta.url)) },
            ]
        },
        optimizeDeps: {
            exclude: [
                '@ozwasyd/element-plus/es/wasm/index.mjs',
                '@ozwasyd/element-plus/es/wasm/markdown.mjs',
                '@ozwasyd/element-plus/es/wasm/markdown-runtime.mjs',
                '@ozwasyd/element-plus/es/wasm/runtime/assets.mjs',
                '@ozwasyd/element-plus/es/wasm/runtime/emscripten.mjs',
                '@ozwasyd/element-plus/es/wasm/runtime/serialized.mjs',
                '@ozwasyd/element-plus/es/wasm/runtime/utf8.mjs'
            ]
        },
        ssr: isPublicSsrBuild
            ? {
                noExternal: true
            }
            : undefined,
        build: {
            // 核心修复(2026-02-21)：生产环境禁用 sourcemap
            // 逻辑自洽：消除 Wasm 胶水代码在 Worker 线程中引发的 URL 解析错误
            sourcemap: mode === 'development',
            // 性能最大化：使用默认的 esbuild 进行压缩，显著提升构建速度
            minify: true,
            manifest: true,
            // 针对大型项目优化块大小
            chunkSizeWarningLimit: 1000,
            rolldownOptions: {
                onwarn(warning, warn) {
                    if (shouldIgnoreBuildWarning(warning)) {
                        return
                    }

                    if (warnAsError) {
                        const message = warning.message || String(warning)
                        throw new Error(`[vite-warning-as-error] ${message}`)
                    }

                    warn(warning)
                },
                ...(isPublicSsrBuild
                    ? {}
                    : {
                        output: {
                            codeSplitting: {
                                includeDependenciesRecursively: false,
                                groups: [
                                    {
                                        name: 'entry-runtime',
                                        test: /node_modules[\\/]@ozwasyd[\\/]element-plus[\\/]es[\\/]components[\\/]config-provider[\\/]src[\\/]theme-mode/,
                                        priority: 110,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-element-plus',
                                        test: /node_modules[\\/](?:@ozwasyd[\\/]element-plus|@element-plus[\\/]icons-vue|@popperjs[\\/]core|@floating-ui|async-validator|dayjs|@ctrl[\\/]tinycolor|motion-dom)/,
                                        priority: 100,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-vue',
                                        test: /node_modules[\\/](?:@vue|vue)[\\/]/,
                                        priority: 90,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-runtime',
                                        test: /node_modules[\\/](?:pinia|pinia-plugin-persistedstate|vue-router)[\\/]/,
                                        priority: 80,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-echarts',
                                        test: /node_modules[\\/]echarts[\\/]/,
                                        priority: 70,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-progress',
                                        test: /node_modules[\\/]nprogress[\\/]/,
                                        priority: 70,
                                        minSize: 1
                                    },
                                    {
                                        name: 'vendor-vueuse',
                                        test: /node_modules[\\/]@unhead[\\/]/,
                                        priority: 70,
                                        minSize: 1
                                    },
                                    {
                                        name(moduleId: string) {
                                            return resolveManualChunk(moduleId) ?? null
                                        },
                                        priority: 10,
                                        minSize: 1
                                    }
                                ]
                            }
                        }
                    })
            }
        },
        server: {
            host: '0.0.0.0',
            port: 3000, // 前端运行端口
            fs: {
                allow: serverFsAllow
            },
            proxy: {
                ...(enablePublicShellProxy
                    ? {
                        '^/assets/.*': publicSeoProxy
                    }
                    : {}),
                ...publicRouteProxy,
                ...sharedApiProxy
            },
            allowedHosts: true
        },
        preview: {
            host: '0.0.0.0',
            port: 8080,
            proxy: {
                ...publicRouteProxy,
                ...sharedApiProxy
            }
        },
        worker: {
            format: "es"
        }
    }
})
