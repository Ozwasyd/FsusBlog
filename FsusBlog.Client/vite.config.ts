import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())

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
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    sourcemap: true,
  },
  server: {
      host: '0.0.0.0',
      port: 3000, // 前端运行端口
      proxy: {
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
      }
    },
} 
})
