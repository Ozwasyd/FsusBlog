<template>
  <div class="account-page dashboard-wrapper w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">站点工作台</h1>
      <p class="account-page-description">
        先看关键指标和访问结构，再进入内容、用户与系统处理流程。
      </p>
    </header>

    <DashboardStatCards :view="dashboardView" />

    <el-row :gutter="20" class="mb-5">
      <el-col :xs="24" :lg="8" class="mb-5">
        <section class="admin-form-panel h-full">
          <div class="card-header pb-4 mb-4 border-b border-[#F4F4F5] text-sm text-[#374151]">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">访问分析</div>
                <span class="mt-2 block font-bold text-[#3F3F46]">访客来源构成</span>
                <p class="mt-2 text-sm leading-6 text-[#71717A]">判断当前活跃主要来自注册用户还是匿名访问。</p>
              </div>
              <el-tooltip content="对比注册用户与匿名访客的活跃度" placement="top">
                <el-icon class="text-[#A1A1AA] cursor-help"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </div>
          <div v-if="!loading && !hasVisitChartData" class="flex h-75 items-center justify-center">
            <el-empty description="暂无访问来源数据" />
          </div>
          <div v-else ref="visitChartRef" class="h-75 w-full" v-loading="loading"></div>
        </section>
      </el-col>
      
      <el-col :xs="24" :lg="16" class="mb-5">
        <section class="admin-form-panel h-full">
          <div class="card-header pb-4 mb-4 border-b border-[#F4F4F5] text-sm text-[#374151]">
            <div>
              <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">访问分析</div>
              <span class="mt-2 block font-bold text-[#3F3F46]">地域访问分布 (Top 10)</span>
              <p class="mt-2 text-sm leading-6 text-[#71717A]">查看站点流量集中区域，辅助判断内容传播与读者来源。</p>
            </div>
          </div>
          <div v-if="!loading && !hasRegionChartData" class="flex h-75 items-center justify-center">
            <el-empty description="暂无地域访问数据" />
          </div>
          <div v-else ref="regionChartRef" class="h-75 w-full" v-loading="loading"></div>
        </section>
      </el-col>
    </el-row>

    <section class="mb-5">
      <header class="mb-5">
        <div class="account-section-title border-t-0 pt-0">运营工作区</div>
        <p class="account-section-caption mb-0">集中处理内容表现、近期互动和常用管理入口。</p>
      </header>
      <el-row :gutter="20">
        <el-col :xs="24" :xl="8" class="mb-5">
          <DashboardOperationsPanel :view="dashboardView" />
        </el-col>
        <el-col :xs="24" :xl="8" class="mb-5">
          <DashboardPopularArticles :view="dashboardView" :loading="loading" />
        </el-col>
        <el-col :xs="24" :xl="8" class="mb-5">
          <DashboardRecentComments :view="dashboardView" :loading="loading" />
        </el-col>
      </el-row>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import DashboardOperationsPanel from '@/components/admin/DashboardOperationsPanel.vue'
import DashboardStatCards from '@/components/admin/DashboardStatCards.vue'
import DashboardRecentComments from '@/components/admin/DashboardRecentComments.vue'
import DashboardPopularArticles from '@/components/admin/DashboardPopularArticles.vue'
import { useAdminDashboard } from '@/composables/useAdminDashboard'

const { loading, dashboardView, visitChartRef, regionChartRef } = useAdminDashboard()
const hasVisitChartData = computed(() =>
  dashboardView.value.visitChart.registeredVisits > 0 || dashboardView.value.visitChart.anonymousVisits > 0
)
const hasRegionChartData = computed(() => dashboardView.value.regionChart.labels.length > 0)
</script>

<style scoped>
.dashboard-wrapper {
  animation: page-fade-in 0.5s ease-out;
}

@keyframes page-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.word-break-all {
  word-break: break-all;
  overflow-wrap: break-word;
}
</style>
