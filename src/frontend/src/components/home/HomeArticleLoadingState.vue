<template>
  <div class="mb-4 flex justify-end" aria-hidden="true">
    <span class="fsusblog-dot-loader"></span>
  </div>
  <el-skeleton
    v-for="i in 3"
    :key="i"
    class="fsusblog-skeleton-surface"
  >
    <template #template>
      <div class="flex flex-col gap-6" aria-hidden="true">
        <div class="w-32 mb-2">
          <el-skeleton-item variant="text" />
        </div>
        <div class="w-3/4">
          <el-skeleton-item variant="h3" />
        </div>
        <div class="space-y-3 mt-2">
          <el-skeleton-item variant="text" />
          <div class="w-5/6">
            <el-skeleton-item variant="text" />
          </div>
        </div>
      </div>
    </template>
  </el-skeleton>
</template>
