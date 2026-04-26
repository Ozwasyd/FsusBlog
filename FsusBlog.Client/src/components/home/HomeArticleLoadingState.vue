<template>
  <div v-for="i in 3" :key="i" class="animate-pulse flex flex-col gap-6" aria-hidden="true">
    <div class="h-3 bg-[#F4F4F5] w-32 mb-2"></div>
    <div class="h-7 bg-[#F4F4F5] w-3/4"></div>
    <div class="space-y-3 mt-2">
      <div class="h-4 bg-[#F4F4F5] w-full"></div>
      <div class="h-4 bg-[#F4F4F5] w-5/6"></div>
    </div>
  </div>
</template>

