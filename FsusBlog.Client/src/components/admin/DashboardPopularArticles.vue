<template>
  <section class="account-shell-panel h-full p-6">
    <header class="mb-4 border-b border-[#F4F4F5] pb-4">
      <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">内容表现</div>
      <h2 class="mt-2 text-base font-bold text-[#27272A]">热门文章</h2>
      <p class="mt-2 text-sm leading-6 text-[#71717A]">用内容表现判断哪些稿件值得继续编辑、补链或置顶处理。</p>
    </header>
    <div v-if="!loading && view.popularArticles.length === 0" class="flex h-[320px] flex-col items-center justify-center">
      <el-empty description="暂无热门文章数据" />
    </div>
    <el-table v-else :data="view.popularArticles" style="width: 100%" v-loading="loading" class="popular-table">
      <el-table-column type="index" label="Rank" width="70" align="center">
        <template #default="scope">
          <span :class="scope.row.rankClassName">
            #{{ scope.row.rank }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="文章标题" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <router-link :to="{ name: 'ManageEditArticle', params: { id: String(row.id) } }" class="rounded-[var(--fsus-radius-sm)] text-[#3F3F46] transition-colors outline-none hover:text-[#2A599C] focus-visible:ring-2 focus-visible:ring-[#2A599C]">
            {{ row.title }}
          </router-link>
        </template>
      </el-table-column>
      <el-table-column prop="views" label="阅读量" width="100" align="right">
        <template #default="{ row }">
          <el-tag size="small" type="info" effect="plain" class="font-mono">
            {{ row.views }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>
    <footer class="mt-5 border-t border-[#F4F4F5] pt-4">
      <router-link
        :to="{ name: 'ManageArticleList' }"
        class="text-[11px] font-semibold text-[#71717A] transition-colors hover:text-[#2A599C]"
      >
        进入文章管理
      </router-link>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();
</script>

<style scoped>
:deep(.popular-table .el-table__header th) {
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

:deep(.popular-table .el-table__inner-wrapper::before) {
  display: none;
}
</style>
