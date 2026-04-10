<template>
  <el-row :gutter="20" class="mb-5">
    <el-col :xs="24" :sm="12" :lg="6" v-for="item in view.statCards" :key="item.label" class="mb-4">
      <el-card shadow="hover" class="border-none transition-all duration-300 hover:-translate-y-1">
        <div class="flex items-center gap-4">
          <div :class="['p-4 rounded-xl flex items-center justify-center shrink-0', item.bgClass]">
            <el-icon size="26" :class="item.iconClass">
              <component :is="iconMap[item.iconName]" />
            </el-icon>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-zinc-500 text-xs font-bold mb-1 uppercase tracking-wider">{{ item.label }}</p>
            <div class="flex items-baseline">
              <span class="text-2xl font-bold text-zinc-800 tracking-tight tabular-nums">
                {{ item.value }}
              </span>
            </div>
          </div>
        </div>
      </el-card>
    </el-col>
  </el-row>
</template>

<script setup lang="ts">
import { ChatDotRound, Delete, Document, View } from '@element-plus/icons-vue'
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

const iconMap = {
  document: Document,
  comments: ChatDotRound,
  views: View,
  trash: Delete
} as const;

defineProps<{
  view: AdminDashboardViewContract;
}>();
</script>
