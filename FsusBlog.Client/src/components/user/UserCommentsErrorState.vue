<template>
  <div class="py-20 border-t border-zinc-100 flex flex-col items-center">
    <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-400 uppercase text-center mb-4">加载失败</p>
    <button
      type="button"
      class="text-[10px] font-bold tracking-[0.2em] text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
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

