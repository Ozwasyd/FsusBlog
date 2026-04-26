<template>
  <div class="py-20 border-t border-[#F4F4F5] flex flex-col items-center">
    <p class="text-[11px] font-bold tracking-normal text-[#A1A1AA] uppercase mb-6">加载失败</p>
    <button
      type="button"
      class="text-[10px] font-bold tracking-normal text-[#0F0F11] border-b border-[#0F0F11] pb-0.5 hover:text-[#2A599C] hover:border-[#2A599C] transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
      @click="$emit('retry')"
    >
      重试
    </button>
  </div>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>
