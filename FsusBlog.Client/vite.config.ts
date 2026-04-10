import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

function resolveManualChunk(id: string): string | undefined {
    if (!id.includes('node_modules')) {
        if (
            id.includes('/src/views/admin/') ||
            id.includes('/src/layouts/AdminLayout.vue') ||
            id.includes('/src/components/admin/') ||
            id.includes('/src/composables/useAdmin')
        ) {
            return 'route-admin'
        }
        if (
            id.includes('/src/views/user/') ||
            id.includes('/src/layouts/UserLayout.vue') ||
            id.includes('/src/components/user/')
        ) {
            return 'route-user'
        }
        if (id.includes('/src/views/auth/')) {
            return 'route-auth'
        }
        if (id.includes('/src/bootstrap/publicShellPrimitives.ts') || id.includes('/src/bootstrap/entry.ts')) {
            return 'entry-runtime'
        }
        if (id.includes('/src/bootstrap/fullApp.ts') || id.includes('/src/router/') || id.includes('/src/App.vue')) {
            return 'full-app-core'
        }
        return undefined
    }

    if (id.includes('/node_modules/element-plus/') || id.includes('/node_modules/@element-plus/')) {
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
    if (id.includes('/node_modules/dompurify/')) {
        return 'vendor-sanitize'
    }
    if (id.includes('/node_modules/@vueuse/head/')) {
        return 'vendor-vueuse'
    }
    if (id.includes('/node_modules/vue/')) {
        return 'vendor-vue'
    }

    return undefined
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd())
    const enablePublicShellProxy =
        env.VITE_PUBLIC_SHELL_PROXY === '1' ||
        env.VITE_PUBLIC_SHELL_PROXY?.toLowerCase() === 'true'

    const publicSeoProxy = {
        target: env.VITE_API_BASE_URL,
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

    return {
        plugins: [
            tailwindcss(),
            vue(),
            AutoImport({
                resolvers: [ElementPlusResolver()],
            }),
            Components({
                resolvers: [ElementPlusResolver()],
            }),
        ],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
                '@wasm': fileURLToPath(new URL('./wasm/web', import.meta.url))
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
                        '^/assets/.*': publicSeoProxy,
                        '^/$': publicSeoProxy,
                        '^/about/?$': publicSeoProxy,
                        '^/archive/?$': publicSeoProxy,
                        '^/article/\\d+/?$': publicSeoProxy,
                        '^/category/\\d+/?$': publicSeoProxy,
                        '^/tag/\\d+/?$': publicSeoProxy,
                    }
                    : {}),
                // 匹配所有以 /api 开头的请求
                '/api': {
                    target: env.VITE_API_BASE_URL, // 转发到的目标端口（来自 .env 文件）
                    changeOrigin: true,
                },
                '/hubs': {
                    target: env.VITE_API_BASE_URL,
                    ws: true, // 开启 WebSocket 代理支持
                    changeOrigin: true
                }
            },
            allowedHosts: true
        },
        worker: {
            format: "es"
        }
    }
})
