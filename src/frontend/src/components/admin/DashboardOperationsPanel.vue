<template>
  <section class="bg-[var(--fsusblog-page-bg)] h-full flex flex-col">
    <header class="p-8 border-b border-[var(--fsusblog-panel-border)]">
      <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">工作区</div>
      <h2 class="mt-4 text-3xl font-bold text-[var(--fsusblog-text-primary)]">运营入口</h2>
      <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
        从首页直接进入常用管理路径，并优先处理需要恢复、归类和治理的内容。
      </p>
    </header>

    <div class="p-8 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/50">
      <div class="flex items-start justify-between gap-6">
        <div>
          <p class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">回收站状态</p>
          <p class="mt-6 text-5xl font-bold text-[var(--fsusblog-text-primary)] tabular-nums tracking-normal">{{ trashCount }}</p>
          <p class="mt-6 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)] max-w-xs">
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

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-px bg-[var(--fsusblog-panel-bg-soft)]">
      <router-link
        v-for="item in actions"
        :key="item.label"
        :to="item.to"
        class="bg-[var(--fsusblog-page-bg)] p-8 transition-colors hover:bg-[var(--fsusblog-panel-bg)] group"
      >
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors">{{ item.eyebrow }}</div>
        <div class="mt-4 text-base font-bold text-[var(--fsusblog-text-primary)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors">{{ item.label }}</div>
        <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)] group-hover:text-[var(--fsusblog-text-secondary)] transition-colors">{{ item.helper }}</p>
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
  eyebrow: string
  label: string
  helper: string
  to: RouteLocationRaw
}> = [
  {
    eyebrow: '内容',
    label: '新建文章',
    helper: '进入写作流程并发布新稿。',
    to: { name: 'ManageWriteArticle' }
  },
  {
    eyebrow: '结构',
    label: '分类管理',
    helper: '维护目录结构与归档入口。',
    to: { name: 'ManageCategory' }
  },
  {
    eyebrow: '内容',
    label: '文章管理',
    helper: '查看内容表现并继续编辑或处理互动。',
    to: { name: 'ManageArticleList' }
  },
  {
    eyebrow: '治理',
    label: '用户管理',
    helper: '进入账号治理与风险处理工作流。',
    to: { name: 'ManageUsers' }
  },
  {
    eyebrow: '系统',
    label: '系统设置',
    helper: '维护站点元信息与静态页面内容。',
    to: { name: 'ManageSettings' }
  },
  {
    eyebrow: '结构',
    label: '标签管理',
    helper: '保持检索语义和文章关键词一致。',
    to: { name: 'ManageTag' }
  }
]
</script>
