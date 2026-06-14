<template>
  <section class="bg-[var(--fsusblog-page-bg)] h-full flex flex-col">
    <header class="p-8 border-b border-[var(--fsusblog-panel-border)]">
      <h2 class="text-lg font-bold text-[var(--fsusblog-text-primary)]">热门文章</h2>
      <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-secondary)]">用内容表现判断哪些稿件值得继续编辑、补链或置顶处理。</p>
    </header>
    <div class="flex-1 p-2">
      <AdminInlineEmptyState
        v-if="!loading && view.popularArticles.length === 0"
        class="flex min-h-[320px] flex-col justify-center"
        title="暂无热门文章数据"
        description="发布文章并累积阅读后，这里会显示值得继续编辑、补链或置顶的稿件。"
      />
      <el-table v-else :data="popularArticleRows" v-loading="loading">
        <el-table-column type="index" label="Rank" width="70" align="center">
          <template #default="scope">
            <span :class="['tabular-nums text-xs font-semibold', scope.row.rank <= 3 ? 'text-[var(--fsusblog-text-primary)]' : 'text-[var(--fsusblog-text-subtle)]']">
              #{{ scope.row.rank }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="文章标题" min-width="200">
          <template #default="{ row }">
            <router-link :to="{ name: 'ManageEditArticle', params: { id: String(row.id) } }" class="blog-focus-ring rounded-[var(--fsus-radius-control-small)] text-sm font-medium text-[var(--fsusblog-text-secondary)] transition-colors hover:text-[var(--fsusblog-color-primary)] outline-none">
              {{ row.title }}
            </router-link>
          </template>
        </el-table-column>
        <el-table-column prop="views" label="阅读量" width="100" align="right">
          <template #default="{ row }">
            <span class="tabular-nums text-xs font-semibold text-[var(--fsusblog-text-muted)]">
              {{ row.views }}
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState
            title="暂无热门文章数据"
            description="加载完成后若仍为空，可先检查文章发布状态与阅读统计。"
          />
        </template>
      </el-table>
    </div>
    <footer class="p-6 border-t border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)]">
      <router-link
        :to="{ name: 'ManageArticleList' }"
        class="blog-link-state group flex items-center gap-3 text-xs font-semibold normal-case tracking-normal"
      >
        进入文章管理 <el-icon class="transition-transform" aria-hidden="true"><ArrowRight /></el-icon>
      </router-link>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ArrowRight } from '@/fsusui/icons';
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

const props = defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();

const popularArticleRows = computed(() => [...props.view.popularArticles]);
</script>

<style scoped>
@reference "@/assets/main.css";

.blog-link-state {
  @apply rounded-[var(--fsus-radius-control-small)] text-[var(--fsusblog-text-muted)] outline-none transition-colors hover:text-[var(--fsusblog-text-primary)] focus-visible:text-[var(--fsusblog-text-primary)];
}

.blog-focus-ring:focus-visible,
.blog-link-state:focus-visible {
  box-shadow: inset 0 0 0 1px var(--fsusblog-color-focus-ring);
}
</style>
