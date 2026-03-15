// src/main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@vueuse/head'

// 引入根组件
import App from './App.vue'

// 导入持久化插件
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

// 引入路由
import router from './router'

// 引入全局样式（包含 Tailwind v4 的配置和基础样式）
import './assets/main.css'
// Element Plus 样式
import 'element-plus/dist/index.css'

import * as ElementPlusIconsVue from '@element-plus/icons-vue'

// 大部分语言
import '@fontsource/google-sans/400.css'
import '@fontsource/google-sans/500.css'
import '@fontsource/google-sans/700.css'

// 简体中文
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'

// 繁体中文
import '@fontsource/noto-sans-tc/400.css'
import '@fontsource/noto-sans-tc/500.css'
import '@fontsource/noto-sans-tc/700.css'

// 日文
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/500.css'
import '@fontsource/noto-sans-jp/700.css'

// 代码块专属字体
import '@fontsource/jetbrains-mono/400.css' // 常规体（代码主体）
import '@fontsource/jetbrains-mono/500.css' // 中等字重（可选，部分主题可能会用到）
import '@fontsource/jetbrains-mono/700.css' // 粗体（用于高亮关键字）

const app = createApp(App)
const pinia = createPinia()

// 注册 Element Plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

const head = createHead()
app.use(head)

pinia.use(piniaPluginPersistedstate)
// 挂载插件
app.use(pinia)
app.use(router)

// 挂载应用
app.mount('#app')
