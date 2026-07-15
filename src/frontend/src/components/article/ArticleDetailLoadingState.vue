<template>
  <el-skeleton class="fsusblog-skeleton-surface">
    <template #template>
      <div class="space-y-8 py-8" aria-hidden="true">
        <div class="w-full sm:w-4/5">
          <el-skeleton-item variant="h1" />
        </div>
        <div class="flex gap-6">
          <div class="w-20 sm:w-24">
            <el-skeleton-item variant="text" />
          </div>
          <div class="w-20 sm:w-24">
            <el-skeleton-item variant="text" />
          </div>
        </div>
        <div class="space-y-4 pt-8 sm:pt-12">
          <el-skeleton-item v-for="i in 6" :key="i" variant="text" />
        </div>
      </div>
    </template>
  </el-skeleton>
</template>
