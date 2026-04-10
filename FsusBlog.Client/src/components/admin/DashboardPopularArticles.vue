<template>
  <el-card header="热门文章排行" shadow="never" class="border-zinc-100 h-full">
    <el-table :data="view.popularArticles" style="width: 100%" stripe v-loading="loading">
      <el-table-column type="index" label="Rank" width="70" align="center">
        <template #default="scope">
          <span :class="scope.row.rankClassName">
            #{{ scope.row.rank }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="文章标题" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <router-link :to="{ name: 'ArticleDetail', params: { id: String(row.id) } }" class="text-zinc-700 hover:text-blue-600 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm">
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
  </el-card>
</template>

<script setup lang="ts">
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();
</script>
