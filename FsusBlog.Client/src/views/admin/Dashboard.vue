<template>
  <div class="dashboard-wrapper">
    <DashboardStatCards :view="dashboardView" />

    <!-- 中部图表区域 -->
    <el-row :gutter="20" class="mb-5">
      <el-col :xs="24" :lg="8" class="mb-5">
        <el-card shadow="never" class="border-zinc-100">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-bold text-zinc-700">访客来源构成</span>
              <el-tooltip content="对比注册用户与匿名访客的活跃度" placement="top">
                <el-icon class="text-zinc-400 cursor-help"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          <div ref="visitChartRef" class="h-75 w-full" v-loading="loading"></div>
        </el-card>
      </el-col>
      
      <el-col :xs="24" :lg="16" class="mb-5">
        <el-card header="地域访问分布 (Top 10)" shadow="never" class="border-zinc-100">
          <div ref="regionChartRef" class="h-75 w-full" v-loading="loading"></div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 底部数据列表区域 -->
    <el-row :gutter="20">
      <el-col :xs="24" :lg="12" class="mb-5">
        <DashboardPopularArticles :view="dashboardView" :loading="loading" />
      </el-col>

      <el-col :xs="24" :lg="12" class="mb-5">
        <DashboardRecentComments :view="dashboardView" :loading="loading" />
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { InfoFilled } from '@element-plus/icons-vue'
import DashboardStatCards from '@/components/admin/DashboardStatCards.vue'
import DashboardRecentComments from '@/components/admin/DashboardRecentComments.vue'
import DashboardPopularArticles from '@/components/admin/DashboardPopularArticles.vue'
import { useAdminDashboard } from '@/composables/useAdminDashboard'

const { loading, dashboardView, visitChartRef, regionChartRef } = useAdminDashboard()
</script>

<style scoped>
.dashboard-wrapper {
  animation: page-fade-in 0.5s ease-out;
}

@keyframes page-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.el-card) {
  --el-card-border-radius: 12px;
}

:deep(.el-card__header) {
  padding: 16px 20px;
  font-size: 14px;
  color: #374151;
}

.word-break-all {
  word-break: break-all;
  overflow-wrap: break-word;
}
</style>
