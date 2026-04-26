<template>
  <el-row :gutter="20" class="mb-5">
    <el-col :xs="24" :sm="12" :lg="6" v-for="item in view.statCards" :key="item.label" class="mb-6">
      <div class="account-shell-panel flex h-full items-center gap-6 p-6 transition-all duration-300 hover:-translate-y-1">
        <div :class="['flex h-18 w-18 items-center justify-center rounded-[var(--fsus-radius-lg)] shrink-0', item.bgClass]">
          <el-icon size="26" :class="item.iconClass">
            <component :is="iconMap[item.iconName]" />
          </el-icon>
        </div>
        <div class="flex-1 min-w-0">
          <p class="mb-2 text-[10px] font-bold uppercase text-[#A1A1AA]">{{ item.label }}</p>
          <div class="flex items-baseline">
            <span class="text-4xl font-bold text-[#27272A] tabular-nums" data-visual-dynamic>
              {{ item.value }}
            </span>
          </div>
          <p class="mt-3 text-sm leading-6 text-[#71717A]">{{ item.description }}</p>
        </div>
      </div>
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
