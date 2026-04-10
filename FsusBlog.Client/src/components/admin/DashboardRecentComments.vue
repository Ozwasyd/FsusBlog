<template>
  <el-card header="最新评论动态" shadow="never" class="border-zinc-100 h-full">
    <div v-if="!loading && view.recentComments.length === 0" class="h-75 flex flex-col items-center justify-center">
      <el-empty description="暂无新评论" />
    </div>
    <el-scrollbar v-else height="320px">
      <el-timeline class="p-4">
        <el-timeline-item
          v-for="comment in view.recentComments"
          :key="comment.id"
          :timestamp="comment.timeText"
          placement="top"
          :type="comment.isLatest ? 'primary' : ''"
        >
          <div class="bg-zinc-50 p-4 rounded-xl border border-zinc-100">
            <div class="flex items-center mb-1">
              <span class="font-bold text-sm text-blue-600 tracking-wide">{{ comment.userName }}</span>
            </div>
            <p class="text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap word-break-all">{{ comment.content }}</p>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-scrollbar>
  </el-card>
</template>

<script setup lang="ts">
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();
</script>
