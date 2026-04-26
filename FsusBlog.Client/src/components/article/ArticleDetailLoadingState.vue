<template>
  <div class="animate-pulse space-y-8 py-8" aria-hidden="true">
    <div class="h-8 sm:h-12 bg-[#F4F4F5] w-full sm:w-4/5"></div>
    <div class="flex gap-6">
      <div class="h-4 bg-[#F4F4F5] w-20 sm:w-24"></div>
      <div class="h-4 bg-[#F4F4F5] w-20 sm:w-24"></div>
    </div>
    <div class="space-y-4 pt-8 sm:pt-12">
      <div v-for="i in 6" :key="i" class="h-4 bg-[#F4F4F5] w-full"></div>
    </div>
  </div>
</template>

