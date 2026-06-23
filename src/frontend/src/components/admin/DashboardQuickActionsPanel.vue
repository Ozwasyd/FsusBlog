<template>
  <section class="bg-[var(--fsusblog-page-bg)] h-full flex flex-col">
    <header class="p-6 border-b border-[var(--fsusblog-panel-border)]">
      <h2 class="text-lg font-bold text-[var(--fsusblog-text-primary)]">快速处理入口</h2>
      <p class="mt-2 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
        从首页直接进入常用管理路径，并优先处理需要恢复、归类和治理的内容。
      </p>
    </header>

    <div class="p-6 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/50">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">回收站状态</p>
          <p class="mt-3 text-2xl font-bold text-[var(--fsusblog-text-primary)] tabular-nums tracking-normal">{{ trashCount }}</p>
          <p class="mt-3 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)] max-w-xs">
            {{ trashCount > 0 ? '当前存在待恢复或待清理稿件，建议优先处理。' : '当前没有待处理的下线稿件。' }}
          </p>
        </div>
        <el-button
          :tag="RouterLink"
          :to="{ name: 'ManageArticleTrash' }"
          type="primary"
        >
          查看回收站
        </el-button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <router-link
        v-for="item in actions"
        :key="item.label"
        :to="item.to"
        class="bg-[var(--fsusblog-page-bg)] p-6 transition-colors hover:bg-[var(--fsusblog-panel-bg)] group"
      >
        <div class="text-base font-bold text-[var(--fsusblog-text-primary)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors">{{ item.label }}</div>
        <p class="mt-2 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)] group-hover:text-[var(--fsusblog-text-secondary)] transition-colors">{{ item.helper }}</p>
      </router-link>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats'

const props = defineProps<{
  view: AdminDashboardViewContract
}>()

const trashCount = computed(() => props.view.statCards.find((item) => item.key === 'trashCount')?.value ?? 0)

const actions: ReadonlyArray<{
  label: string
  helper: string
  to: RouteLocationRaw
}> = [
  {
    label: '新建文章',
    helper: '进入写作流程并发布新稿。',
    to: { name: 'ManageWriteArticle' }
  },
  {
    label: '分类管理',
    helper: '维护目录结构与归档入口。',
    to: { name: 'ManageCategory' }
  },
  {
    label: '文章管理',
    helper: '查看内容表现并继续编辑或处理互动。',
    to: { name: 'ManageArticleList' }
  },
  {
    label: '用户管理',
    helper: '进入账号治理与风险处理工作流。',
    to: { name: 'ManageUsers' }
  },
  {
    label: '系统设置',
    helper: '维护站点元信息与静态页面内容。',
    to: { name: 'ManageSettings' }
  },
  {
    label: '标签管理',
    helper: '保持检索语义和文章关键词一致。',
    to: { name: 'ManageTag' }
  }
]
</script>
