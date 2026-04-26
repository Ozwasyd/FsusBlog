import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

function resolveManualChunk(id: string): string | undefined {
    if (!id.includes('node_modules')) {
        if (
            id.includes('/src/views/admin/') ||
            id.includes('/src/views/user/') ||
            id.includes('/src/layouts/AccountLayout.vue') ||
            id.includes('/src/components/admin/') ||
            id.includes('/src/components/user/') ||
            id.includes('/src/composables/useAdmin') ||
            id.includes('/src/layouts/accountNav.ts')
        ) {
            return 'route-account'
        }
        if (id.includes('/src/views/auth/')) {
            return 'route-auth'
        }
        if (id.includes('/src/bootstrap/publicShellPrimitives.ts') || id.includes('/src/bootstrap/entry.ts')) {
            return 'entry-runtime'
        }
        if (
            id.includes('/src/bootstrap/publicShell.ts') ||
            id.includes('/src/bootstrap/publicHydrationBootstrap.ts') ||
            id.includes('/src/public-renderers/')
        ) {
            return 'public-page-runtime'
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
    if (id.includes('/node_modules/md-editor-v3/')) {
        return 'vendor-md-editor'
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
    if (id.includes('/node_modules/vue/')) {
        return 'vendor-vue'
    }

    return undefined
}

function shouldIgnoreBuildWarning(warning: { message?: string; id?: string }): boolean {
    return Boolean(
        warning.message?.includes('new URL("ep_wasm.wasm",import.meta.url)') &&
        warning.id?.includes('/node_modules/@ozwasyd/element-plus/')
    )
}

function patchFsusUiWasmUrl() {
    return {
        name: 'patch-fsusui-wasm-url',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
            if (
                !id.includes('/node_modules/@ozwasyd/element-plus/') ||
                !code.includes('new URL("ep_wasm.wasm",import.meta.url)')
            ) {
                return null
            }

            return code.replace(
                'new URL("ep_wasm.wasm",import.meta.url)',
                'new URL(/* @vite-ignore */ "ep_wasm.wasm", import.meta.url)'
            )
        }
    }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd())
    const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || 'http://127.0.0.1:5000'
    const hasProxyFlag = typeof env.VITE_PUBLIC_SHELL_PROXY === 'string' && env.VITE_PUBLIC_SHELL_PROXY.trim().length > 0
    const enablePublicShellProxy = hasProxyFlag
        ? env.VITE_PUBLIC_SHELL_PROXY === '1' || env.VITE_PUBLIC_SHELL_PROXY?.toLowerCase() === 'true'
        : true

    const publicSeoProxy = {
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

    const publicRouteProxy = enablePublicShellProxy
        ? {
            '^/$': publicSeoProxy,
            '^/about/?$': publicSeoProxy,
            '^/archive/?$': publicSeoProxy,
            '^/article/\\d+/?$': publicSeoProxy,
            '^/category/\\d+/?$': publicSeoProxy,
            '^/tag/\\d+/?$': publicSeoProxy,
        }
        : {}

    const sharedApiProxy = {
        '/api': {
            target: apiBaseUrl,
            changeOrigin: true,
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
        '^/search/index\\.manifest\\.json$': {
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
        plugins: [
            patchFsusUiWasmUrl(),
            tailwindcss(),
            vue(),
            AutoImport({
                resolvers: [
                    (name) => {
                        if (name.match(/^El[A-Z]/)) {
                            return { name, from: '@ozwasyd/element-plus' }
                        }
                    }
                ],
            }),
            Components({
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
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
                '@wasm': fileURLToPath(new URL('./wasm/web', import.meta.url)),
                'element-plus': '@ozwasyd/element-plus',
            }
        },
        build: {
            // 核心修复(2026-02-21)：生产环境禁用 sourcemap 
            // 逻辑自洽：消除 Wasm 胶水代码在 Worker 线程中引发的 URL 解析错误
            sourcemap: mode === 'development',
            // 性能最大化：使用默认的 esbuild 进行压缩，显著提升构建速度
            minify: true,
            // 针对大型项目优化块大小
            chunkSizeWarningLimit: 1000,
            rollupOptions: {
                onwarn(warning, warn) {
                    if (shouldIgnoreBuildWarning(warning)) {
                        return
                    }

                    warn(warning)
                },
                output: {
                    manualChunks(id) {
                        return resolveManualChunk(id)
                    }
                }
            }
        },
        server: {
            host: '0.0.0.0',
            port: 3000, // 前端运行端口
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
