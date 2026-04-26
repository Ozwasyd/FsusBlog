<template>
  <section class="account-shell-panel h-full p-6">
    <header class="mb-5 border-b border-[#F4F4F5] pb-4">
      <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">工作区</div>
      <h2 class="mt-2 text-base font-bold text-[#27272A]">运营入口</h2>
      <p class="mt-2 text-sm leading-6 text-[#71717A]">
        从首页直接进入常用管理路径，并优先处理需要恢复、归类和治理的内容。
      </p>
    </header>

    <div class="account-soft-block mb-5 p-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-[10px] font-bold uppercase text-[#A1A1AA]">回收站状态</p>
          <p class="mt-3 text-3xl font-bold text-[#27272A] tabular-nums">{{ trashCount }}</p>
          <p class="mt-2 text-sm leading-6 text-[#71717A]">
            {{ trashCount > 0 ? '当前存在待恢复或待清理稿件，建议优先处理。' : '当前没有待处理的下线稿件。' }}
          </p>
        </div>
        <router-link
          :to="{ name: 'ManageArticleTrash' }"
          class="rounded-[8px] border border-[#E4E4E7] px-4 py-2 text-[11px] font-semibold text-[#27272A] transition-colors hover:border-[#2A599C] hover:text-[#2A599C]"
        >
          查看回收站
        </router-link>
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <router-link
        v-for="item in actions"
        :key="item.label"
        :to="item.to"
        class="account-soft-block block p-4 transition-colors hover:border-[#2A599C] hover:text-[#2A599C]"
      >
        <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">{{ item.eyebrow }}</div>
        <div class="mt-2 text-sm font-bold text-[#27272A]">{{ item.label }}</div>
        <p class="mt-2 text-sm leading-6 text-[#71717A]">{{ item.helper }}</p>
      </router-link>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
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
    label: '分类与标签',
    helper: '维护目录结构与索引关键词。',
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
