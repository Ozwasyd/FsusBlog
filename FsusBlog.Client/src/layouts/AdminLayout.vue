<template>
  <div class="admin-layout-root el-admin-reset min-h-screen bg-zinc-50 flex overflow-hidden">
    
    <transition name="el-fade-in">
      <div 
        v-if="isMobile && !isCollapse" 
        class="fixed inset-0 bg-black/50 z-1000 backdrop-blur-sm"
        @click="isCollapse = true"
      ></div>
    </transition>

    <aside 
      class="admin-sidebar bg-[#1d1e1f] z-1001 shrink-0 transition-transform duration-300 ease-in-out border-r border-white/5"
      :class="[
        isMobile ? (isCollapse ? '-translate-x-full' : 'translate-x-0') : 'translate-x-0',
        isMobile ? 'fixed inset-y-0 left-0' : 'relative',
        !isMobile && isCollapse ? 'w-16' : 'w-60'
      ]"
    >
      <div class="h-16 flex items-center justify-center bg-[#1d1e1f] text-white overflow-hidden select-none border-b border-white/5">
        <el-icon size="24" class="text-[#409EFF] drop-shadow-[0_0_8px_rgba(64,158,255,0.4)]">
          <Platform />
        </el-icon>
        <transition name="el-fade-in-linear">
          <span v-show="!isCollapse || isMobile" class="ml-3 font-bold text-lg tracking-tight bg-linear-to-r from-white to-zinc-400 bg-clip-text text-transparent">
            Admin Console
          </span>
        </transition>
      </div>

      <el-scrollbar class="h-[calc(100vh-64px)]">
        <el-menu
          :default-active="activeMenu"
          class="border-none!"
          :collapse="!isMobile && isCollapse"
          :router="true"
          background-color="#1d1e1f"
          text-color="#a8abb2"
          active-text-color="#ffffff"
          :unique-opened="true"
          :collapse-transition="false"
          @select="handleMenuSelect"
        >
          <el-menu-item index="/admin">
            <el-icon><DataLine /></el-icon>
            <template #title>控制台</template>
          </el-menu-item>

          <el-sub-menu index="article">
            <template #title>
              <el-icon><Document /></el-icon>
              <span>内容管理</span>
            </template>
            <el-menu-item index="/admin/article/list">文章列表</el-menu-item>
            <el-menu-item index="/admin/article/write">撰写文章</el-menu-item>
            <el-menu-item index="/admin/article/trash">回收站</el-menu-item>
          </el-sub-menu>

          <el-menu-item index="/admin/category">
            <el-icon><FolderOpened /></el-icon>
            <template #title>分类管理</template>
          </el-menu-item>

          <el-menu-item index="/admin/tag">
            <el-icon><CollectionTag /></el-icon>
            <template #title>标签管理</template>
          </el-menu-item>

          <el-menu-item index="/admin/users">
            <el-icon><User /></el-icon>
            <template #title>用户管理</template>
          </el-menu-item>

          <el-menu-item index="/admin/message">
            <el-icon><Message /></el-icon>
            <template #title>站内信管理</template>
          </el-menu-item>

          <el-menu-item index="/admin/settings">
            <el-icon><Setting /></el-icon>
            <template #title>系统设置</template>
          </el-menu-item>
        </el-menu>
      </el-scrollbar>
    </aside>

    <main class="flex-1 flex flex-col min-w-0 h-screen">
      <header class="h-16 bg-white border-b border-zinc-200 flex items-center justify-between px-6 shrink-0 z-50">
        <div class="flex items-center gap-4 min-w-0">
          <el-icon 
            class="text-xl cursor-pointer text-zinc-500 hover:text-[#409EFF] transition-colors" 
            @click="isCollapse = !isCollapse"
          >
            <Expand v-if="isCollapse" />
            <Fold v-else />
          </el-icon>
          
          <el-breadcrumb separator="/" class="hidden sm:block truncate">
            <el-breadcrumb-item :to="{ path: '/admin' }">管理端</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="flex items-center gap-4">
          <el-button link class="hidden md:inline-flex text-zinc-500 hover:text-[#409EFF]" @click="openHome">
            主站
          </el-button>
          
          <div class="w-px h-4 bg-zinc-200 hidden sm:block"></div>

          <el-dropdown trigger="click" @command="handleCommand">
            <div class="flex items-center gap-2 cursor-pointer p-1.5 hover:bg-zinc-100 rounded-lg transition-all border border-transparent hover:border-zinc-200">
              <el-avatar :size="26" src="https://cube.elemecdn.com/0/88/03b0d39583f48206768a7534e55bcpng.png" />
              <span class="hidden xs:inline text-sm font-medium text-zinc-700">{{ userStore.userInfo?.username }}</span>
              <el-icon class="text-zinc-400"><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">
                  <el-icon><User /></el-icon>个人设置
                </el-dropdown-item>
                <el-dropdown-item divided command="logout" class="text-red-500!">
                  <el-icon><SwitchButton /></el-icon>安全退出
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <section class="flex-1 overflow-y-auto p-5 sm:p-6 bg-[#f5f7fa] custom-scrollbar">
        <router-view v-slot="{ Component }">
          <transition name="el-fade-in-linear" mode="out-in">
            <div :key="route.path" class="admin-content-box">
              <component :is="Component" />
            </div>
          </transition>
        </router-view>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { 
  Platform, DataLine, Document, FolderOpened, 
  CollectionTag, Setting, Expand, Fold, ArrowDown,
  User, SwitchButton, Message
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const isCollapse = ref(false)
const isMobile = ref(false)

const activeMenu = computed(() => route.path)
const currentTitle = computed(() => (route.meta.title as string) || '控制板')

const resizeHandler = () => {
  const width = window.innerWidth
  isMobile.value = width < 768
  isCollapse.value = isMobile.value
}

watch(isCollapse, (val) => {
  if (isMobile.value) {
    document.body.style.overflow = val ? '' : 'hidden'
  }
})

const handleMenuSelect = () => {
  if (isMobile.value) isCollapse.value = true
}

const handleCommand = (command: string) => {
  if (command === 'logout') {
    userStore.logout()
    router.push('/login')
  } else {
    router.push('/admin/settings')
  }
}

const openHome = () => window.open('/', '_blank')

onMounted(() => {
  resizeHandler()
  window.addEventListener('resize', resizeHandler)
})

onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.el-admin-reset {
  --el-font-family: var(--el-font-family-base);
  background-color: #f5f7fa;
}

.admin-sidebar {
  box-shadow: 2px 0 12px rgba(0, 0, 0, 0.05);
}

/* 🌟 菜单项激活时的背景色调整 */
:deep(.el-menu-item.is-active) {
  background-color: #409EFF !important;
  border-radius: 4px;
  margin: 0 8px;
  width: calc(100% - 16px);
}

/* 🌟 悬浮态修正 */
:deep(.el-menu-item:hover), :deep(.el-sub-menu__title:hover) {
  background-color: rgba(255, 255, 255, 0.05) !important;
  color: #fff !important;
}

.admin-content-box {
  background: #fff;
  border-radius: 8px; /* 稍微圆润一点更现代 */
  padding: 24px;
  min-height: 100%;
  box-shadow: 0 1px 4px 0 rgba(0, 0, 0, 0.02), 0 2px 12px 0 rgba(0, 0, 0, 0.04);
}

:deep(.el-menu--collapse .el-sub-menu__icon-arrow) {
  display: none;
}
:deep(.el-menu--collapse .el-sub-menu__title span) {
  display: none;
}

/* 滚动条 */
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #dcdfe6;
  border-radius: 10px;
}
</style>