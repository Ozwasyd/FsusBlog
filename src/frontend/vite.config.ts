import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { createFsusUiAliases, resolveFsusUiWasmDist, resolveLocalFsusUiRoot } from './scripts/fsusui-local'
import { generatedArtifactWatchIgnorePatterns } from './scripts/vite-watch-policy.mjs'
import { assertProductionFrontendBuildId } from './src/config/releaseStorage'

const FRONTEND_ROOT = fileURLToPath(new URL('./', import.meta.url))
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '../..')
const localeCatalog = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'src/shared/Contracts/Localization/locale-catalog.json'),
    'utf8'
)) as { locales?: Array<{ code?: string; status?: string }> }
const localeCodes = (localeCatalog.locales ?? [])
    .filter((locale) => locale.status === 'enabled' && typeof locale.code === 'string')
    .map((locale) => locale.code as string)
const localeDomainSource = fs.readFileSync(
    path.join(FRONTEND_ROOT, 'src/locales/localeDomains.ts'),
    'utf8'
)
const localeDomainMatch = localeDomainSource.match(
    /export const LOCALE_DOMAINS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u
)
const localeDomains = localeDomainMatch
    ? [...localeDomainMatch[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
    : []
if (localeCodes.length === 0 || localeDomains.length === 0) {
    throw new Error('locale/domain catalogs must be available before Vite chunk planning')
}
const localeDomainChunkPattern = new RegExp(
    `[\\\\/]src[\\\\/]locales[\\\\/](${localeCodes.map(escapeRegExp).join('|')})`
    + `[\\\\/](${localeDomains.map(escapeRegExp).join('|')})\\.ts$`,
    'u'
)

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

function resolveLocaleDomainChunk(id: string): string | undefined {
    const localeDomain = localeDomainChunkPattern.exec(id)
    return localeDomain ? `locale-${localeDomain[1]}-${localeDomain[2]}` : undefined
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
            id.includes('/src/public-renderers/publicRouteRegistry.ts') ||
            id.includes('/src/public-renderers/publicRoutePaths.ts') ||
            id.includes('/src/public-renderers/publicFixedPageSemantics.ts') ||
            id.includes('/src/public-renderers/generated/publicPageManifest.ts') ||
            id.includes('/src/router/routeTitleContract.ts')
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

function shouldIgnoreBuildWarning(warning: { message?: string; id?: string; code?: string }): boolean {
    if (
        warning.message?.includes('[PLUGIN_TIMINGS]') ||
        warning.message?.includes('Your build spent significant time in plugin') ||
        warning.message?.includes('INEFFECTIVE_DYNAMIC_IMPORT') ||
        warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT'
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
        new RegExp(`${escapeRegExp(normalizedRoot)}/vue/packages/`),
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
    const distRoot = path.resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT
        || fileURLToPath(new URL('./dist/', import.meta.url)))
    const backendWebRoot = path.resolve(process.env.FSUSBLOG_BACKEND_WEBROOT
        || fileURLToPath(new URL('../backend/wwwroot/', import.meta.url)))
    const sidecarPathPattern = /^\/aot-cache\/payloads\/[0-9a-f]{2}\/[0-9a-f]{64}\.aeds$/i
    const handleSidecar = (request: any, response: any, next: () => void) => {
        const pathname = request.url?.split(/[?#]/)[0] ?? ''
        if (!sidecarPathPattern.test(pathname)) {
            next()
            return
        }

        const relativeSidecarPath = pathname.slice(1)
        const filePath = [
            path.join(distRoot, relativeSidecarPath),
            path.join(backendWebRoot, relativeSidecarPath)
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

function serveReleaseScopedPreviewAssets() {
    const releaseAssetPathPattern =
        /^\/release-assets\/\d{14}-[0-9a-f]{12}(?=\/|$)/u
    const rewriteReleaseAssetRequest = (
        request: any,
        _response: any,
        next: () => void
    ) => {
        const requestUrl = request.url ?? '/'
        const [pathname, suffix = ''] = requestUrl.split(/(?=[?#])/u, 2)
        const match = releaseAssetPathPattern.exec(pathname)
        if (match) {
            request.url = `${pathname.slice(match[0].length) || '/'}${suffix}`
        }
        next()
    }

    return {
        name: 'serve-release-scoped-preview-assets',
        apply: 'serve' as const,
        configurePreviewServer(server: any) {
            server.middlewares.use(rewriteReleaseAssetRequest)
        }
    }
}

function rejectRetiredBrandEntrypoints() {
    const retiredBrandEntrypointPaths = new Set([
        '/favicon.svg',
        '/favicon.ico',
        '/apple-touch-icon.png',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/maskable-512.png'
    ])

    const rejectRetiredPath = (request: any, response: any, next: () => void) => {
        const pathname = request.url?.split(/[?#]/)[0] ?? ''
        if (!retiredBrandEntrypointPaths.has(pathname)) {
            next()
            return
        }

        response.statusCode = 404
        response.end()
    }

    return {
        name: 'reject-retired-brand-entrypoints',
        apply: 'serve' as const,
        configureServer(server: any) {
            server.middlewares.use(rejectRetiredPath)
        },
        configurePreviewServer(server: any) {
            server.middlewares.use(rejectRetiredPath)
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
    response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; worker-src 'self' blob:; report-uri /api/security/csp-report;"
    )
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
        href: '/src/assets/tailwind.css?direct',
        style: 'tailwind'
    },
    {
        href: '/src/assets/markdown.css?direct',
        style: 'markdown'
    },
    {
        href: '/src/assets/public-page.css?direct',
        style: 'public-page'
    }
]

const productionManifestStyleOwners = [
    {
        owner: 'public-shell-critical',
        source: '/src/assets/public-shell-critical.css'
    },
    {
        owner: 'tailwind',
        source: '/src/assets/tailwind.css'
    },
    {
        owner: 'markdown',
        source: '/src/assets/markdown.css'
    },
    {
        owner: 'public-page',
        source: '/src/assets/public-page.css'
    }
] as const
const productionRequiredManifestOwners = [
    'index',
    'entry-runtime',
    'public-page-runtime',
    'public-shell-critical',
    'tailwind',
    'markdown',
    'public-page',
    'full-app-core',
    'route-user',
    'route-admin',
    'route-auth',
    'route-error'
] as const
const productionRequiredManualChunkOwners = [
    'public-page-runtime',
    'full-app-core',
    'route-user',
    'route-admin',
    'route-auth',
    'route-error'
] as const
const productionManifestOwnerRequestPrefix = '/@fsusblog-manifest-owner/'
const productionManifestOwnerResolvedPrefix = '\0fsusblog:manifest-owner:'

function productionManifestOwnerModuleId(owner: string): string {
    return `${productionManifestOwnerResolvedPrefix}${owner}`
}

function preserveProductionManifestOwners(validateOwners: boolean): Plugin {
    const styleByOwner = new Map(
        productionManifestStyleOwners.map((style) => [style.owner, style])
    )
    const owners = ['entry-runtime', ...styleByOwner.keys()]
    let enforceOwners = validateOwners

    return {
        name: 'preserve-production-manifest-owners',
        apply: 'build' as const,
        configResolved(config) {
            const input = config.build.rolldownOptions?.input
            const entries = typeof input === 'string'
                ? [input]
                : Array.isArray(input)
                    ? input
                    : Object.values(input ?? {})
            enforceOwners = enforceOwners && entries.some((entry) =>
                typeof entry === 'string' && /(?:^|[\\/])index\.html$/u.test(entry))
        },
        resolveId(source: string) {
            if (!source.startsWith(productionManifestOwnerRequestPrefix)) {
                return undefined
            }

            const owner = source.slice(productionManifestOwnerRequestPrefix.length)
            return owners.includes(owner)
                ? productionManifestOwnerModuleId(owner)
                : undefined
        },
        load(id: string) {
            if (id === productionManifestOwnerModuleId('entry-runtime')) {
                return `Object.freeze({ owner: 'entry-runtime' })`
            }

            const owner = id.startsWith(productionManifestOwnerResolvedPrefix)
                ? id.slice(productionManifestOwnerResolvedPrefix.length)
                : ''
            const style = styleByOwner.get(owner as typeof productionManifestStyleOwners[number]['owner'])
            if (!style) {
                return undefined
            }

            // Rolldown removes CSS-only facades. A frozen, discarded owner
            // marker keeps a non-entry manifest chunk without runtime state.
            return `
                import ${JSON.stringify(style.source)}
                Object.freeze({ owner: ${JSON.stringify(style.owner)} })
            `
        },
        transformIndexHtml: {
            order: 'pre' as const,
            handler() {
                return owners.map((owner) => ({
                    tag: 'script',
                    attrs: {
                        type: 'module',
                        src: `${productionManifestOwnerRequestPrefix}${owner}`
                    },
                    injectTo: 'head' as const
                }))
            }
        },
        generateBundle: {
            order: 'pre' as const,
            handler(_options, bundle) {
                // The kernel remains a standalone Rolldown input so build.mjs can
                // publish its stable alias without creating an index -> kernel ->
                // index dependency cycle. It is a preload target, not the SPA
                // document entry, so only index may carry isEntry in the manifest.
                for (const output of Object.values(bundle)) {
                    if (output.type !== 'chunk') {
                        continue
                    }
                    if (output.name === 'publicBootKernel') {
                        output.isEntry = false
                        continue
                    }
                    if (enforceOwners) {
                        output.isEntry = output.name === 'index'
                    }
                }

                if (!enforceOwners) {
                    return
                }

                const chunks = Object.values(bundle).filter((output) => output.type === 'chunk')
                for (const owner of productionRequiredManifestOwners) {
                    const matches = chunks.filter((output) => output.name === owner)
                    if (matches.length !== 1) {
                        throw new Error(`production_manifest_owner_not_unique:${owner}:${matches.length}`)
                    }
                }

                const primaryEntries = chunks.filter((output) => output.isEntry)
                if (primaryEntries.length !== 1 || primaryEntries[0].name !== 'index') {
                    throw new Error(
                        `production_manifest_primary_entry_invalid:${primaryEntries.map((entry) => entry.name).join(',')}`
                    )
                }
            }
        }
    }
}

function injectPublicSourceCssInDev() {
    return {
        name: 'inject-public-source-css-in-dev',
        apply: 'serve' as const,
        transformIndexHtml(html: string) {
            let transformedHtml = html
            const missingTags: string[] = []

            for (const link of publicSourceCssDevLinks) {
                const sourceHref = link.href.replace(/\?direct$/, '')
                const sourceLink = `href="${sourceHref}"`
                const directLink = `href="${link.href}"`

                if (transformedHtml.includes(sourceLink)) {
                    transformedHtml = transformedHtml.replaceAll(sourceLink, directLink)
                    continue
                }

                if (!transformedHtml.includes(directLink)) {
                    missingTags.push(
                        `    <link rel="stylesheet" href="${link.href}" data-fsusblog-style="${link.style}" />`
                    )
                }
            }

            if (missingTags.length === 0 || !transformedHtml.includes('</head>')) {
                return transformedHtml
            }

            return transformedHtml.replace('</head>', `${missingTags.join('\n')}\n  </head>`)
        }
    }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
    const env = loadEnv(mode, process.cwd())
    const frontendBuildId = env.VITE_FSUSBLOG_BUILD_ID?.trim() || ''
    if (command === 'build' && mode === 'production') {
        assertProductionFrontendBuildId(frontendBuildId)
    }
    const apiBaseUrl = process.env.VITE_API_BASE_URL?.trim()
        || env.VITE_API_BASE_URL?.trim()
        || 'http://127.0.0.1:7568'
    const enableVueHydrationMismatchDetails = process.env.FSUSBLOG_VUE_HYDRATION_DETAILS === '1'
        || process.env.FSUSBLOG_VUE_HYDRATION_DETAILS?.toLowerCase() === 'true'
    const warnAsError = process.env.FSUSBLOG_VITE_WARN_AS_ERROR === '1'
        || process.env.FSUSBLOG_VITE_WARN_AS_ERROR?.toLowerCase() === 'true'
    const isPublicSsrBuild = process.env.FSUSBLOG_PUBLIC_SSR_BUILD === '1'
        || process.env.FSUSBLOG_PUBLIC_SSR_BUILD?.toLowerCase() === 'true'
    const publicShellProxyFlag = process.env.VITE_PUBLIC_SHELL_PROXY?.trim()
        || env.VITE_PUBLIC_SHELL_PROXY?.trim()
    const enablePublicShellProxy = publicShellProxyFlag === '1'
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
        // The run-bound release readiness probe must observe the immutable
        // frontend entry from this Vite process. Letting the public-shell
        // proxy handle it can turn the backend's canonical-root redirect into
        // a false stale-preview failure before runtime tests even start.
        bypass: (request) => {
            const requestUrl = new URL(request.url ?? '/', 'http://release-preview.local')
            if (requestUrl.pathname === '/' && requestUrl.searchParams.has('fsus-preview-proof')) {
                return '/index.html'
            }
        },
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

    const releasePreviewApplicationProxy: Record<string, ProxyOptions> = enablePublicShellProxy
        ? {
            // The release preview serves immutable frontend files itself, but
            // application routes must keep the backend's production HTTP
            // semantics (SSR nonce, redirects, real 404s, and integrity APIs).
            '^/(?!\\.vite(?:/|$)|aot-cache(?:/|$)|assets(?:/|$)|dist(?:/|$)|favicon(?:/|$)|fixtures(?:/|$)|release-assets(?:/|$)|server(?:/|$)|social(?:/|$)|wasm(?:/|$)|manifest\\.webmanifest(?:\\?|$)|public-shell-emergency\\.css(?:\\?|$)|sw\\.js(?:\\?|$)).*$': publicSeoProxy,
        }
        : {}

    const sharedApiProxy: Record<string, ProxyOptions> = {
        '^/integrity(?:/|$)': publicSeoProxy,
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
        '^/__local/.*$': {
            target: apiBaseUrl,
            changeOrigin: true
        },
        '^/uploads/.*$': {
            target: apiBaseUrl,
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
        publicDir: command === 'build' && process.env.FSUSBLOG_FRONTEND_DIST_ROOT ? false : 'public',
        cacheDir: process.env.FSUSBLOG_FRONTEND_CACHE_ROOT
            ? path.resolve(process.env.FSUSBLOG_FRONTEND_CACHE_ROOT, 'vite')
            : undefined,
        define: {
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(enableVueHydrationMismatchDetails)
        },
        plugins: [
            applyDevelopmentSecurityHeaders(),
            rejectRetiredBrandEntrypoints(),
            injectPublicSourceCssInDev(),
            preserveProductionManifestOwners(!isPublicSsrBuild),
            fixViteClientWorkerDocumentGuard(),
            serveFsusUiOptimizedWasmAssets(fsusUiWasmDist),
            servePublicAotHydrationSidecars(),
            serveReleaseScopedPreviewAssets(),
            tailwindcss(),
            vue({
                template: {
                    compilerOptions: {
                        comments: false
                    }
                }
            }),
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
            // Browser fixtures live under the canonical repository-level test root.
            // Resolve their package imports through this frontend package so they
            // share the application's Vue/router instances.
            dedupe: command === 'serve' ? ['vue', 'vue-router'] : [],
            alias: [
                ...fsusUiAliases,
                { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
                { find: '@wasm', replacement: fileURLToPath(new URL('./wasm/web', import.meta.url)) },
            ]
        },
        optimizeDeps: {
            exclude: [
                // Local FsusUI WASM must stay source-resolved; the published
                // package can lag the local table composable API.
                '@element-plus/wasm',
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
            target: 'es2022',
            // Public AOT owns the audited modulepreload set. Vite's generated
            // runtime helper assigns raw strings to modulepreload href, which
            // is a TrustedScriptURL sink under the production CSP.
            modulePreload: false,
            outDir: process.env.FSUSBLOG_FRONTEND_DIST_ROOT
                ? path.resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT)
                : 'dist',
            // The run-bound dist root is shared by independent client and SSR
            // stages. build.mjs prepares its unique root exactly once before
            // admission; an individual Vite stage must never wipe sibling output.
            emptyOutDir: process.env.FSUSBLOG_FRONTEND_DIST_ROOT ? false : undefined,
            // COMPATIBILITY: Production sourcemaps break Wasm glue URL resolution inside the Worker.
            sourcemap: mode === 'development',
            minify: true,
            manifest: true,
            // 针对大型项目优化块大小
            chunkSizeWarningLimit: 650,
            rolldownOptions: {
                input: {
                    index: path.resolve(FRONTEND_ROOT, 'index.html'),
                    publicBootKernel: path.resolve(FRONTEND_ROOT, 'src/bootstrap/publicBootKernel.ts')
                },
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
                                    ...productionManifestStyleOwners.map(({ owner, source }) => ({
                                        name: owner,
                                        test(moduleId: string) {
                                            return moduleId === productionManifestOwnerModuleId(owner)
                                                || moduleId.replaceAll('\\', '/').includes(source)
                                        },
                                        priority: 120,
                                        minSize: 0
                                    })),
                                    {
                                        name: 'markdown-adapter',
                                        test: /[\\/]src[\\/]fsusui[\\/]markdown\.ts$/u,
                                        priority: 115,
                                        minSize: 0
                                    },
                                    {
                                        name: 'entry-runtime',
                                        test: (moduleId: string) =>
                                            moduleId === productionManifestOwnerModuleId('entry-runtime'),
                                        priority: 110,
                                        minSize: 0
                                    },
                                    ...productionRequiredManualChunkOwners.map((owner) => ({
                                        name: owner,
                                        test(moduleId: string) {
                                            return resolveManualChunk(moduleId) === owner
                                        },
                                        priority: 50,
                                        minSize: 0
                                    })),
                                    {
                                        name: 'publicBootKernel',
                                        test: /[\\/]src[\\/]bootstrap[\\/]publicBootKernel\.ts$/u,
                                        priority: 105,
                                        minSize: 0
                                    },
                                    {
                                        name: 'vendor-element-plus',
                                        test: /node_modules[\\/](?:@ozwasyd[\\/]element-plus|@element-plus[\\/]icons-vue|@popperjs[\\/]core|@floating-ui|async-validator|dayjs|@ctrl[\\/]tinycolor|motion-dom)/,
                                        priority: 100,
                                        minSize: 4096
                                    },
                                    {
                                        name: 'vendor-vue',
                                        test: /node_modules[\\/](?:@vue|vue)[\\/]/,
                                        priority: 90,
                                        minSize: 4096
                                    },
                                    {
                                        name: 'vendor-runtime',
                                        test: /node_modules[\\/](?:pinia|pinia-plugin-persistedstate|vue-router)[\\/]/,
                                        priority: 80,
                                        minSize: 4096
                                    },
                                    {
                                        name: 'vendor-echarts',
                                        test: /node_modules[\\/]echarts[\\/]/,
                                        priority: 70,
                                        minSize: 4096
                                    },
                                    {
                                        name: 'vendor-progress',
                                        test: /node_modules[\\/]nprogress[\\/]/,
                                        priority: 70,
                                        minSize: 4096
                                    },
                                    {
                                        name: 'vendor-vueuse',
                                        test: /node_modules[\\/]@unhead[\\/]/,
                                        priority: 70,
                                        minSize: 4096
                                    },
                                    {
                                        name(moduleId: string) {
                                            return resolveLocaleDomainChunk(moduleId) ?? null
                                        },
                                        priority: 20,
                                        minSize: 0
                                    },
                                    {
                                        name(moduleId: string) {
                                            return resolveManualChunk(moduleId) ?? null
                                        },
                                        priority: 10,
                                        minSize: 4096
                                    }
                                ]
                            }
                        }
                    })
            }
        },
        server: {
            host: '0.0.0.0',
            port: 3000,
            // Coverage and browser reports are written while production lanes
            // exercise this server. They are evidence, not application input,
            // and must never invalidate an in-flight browser measurement.
            watch: {
                ignored: generatedArtifactWatchIgnorePatterns.slice()
            },
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
                ...sharedApiProxy,
                ...publicRouteProxy,
                ...releasePreviewApplicationProxy
            }
        },
        worker: {
            format: "es"
        }
    }
})
