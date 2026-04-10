<template>
  <header class="mb-12 sm:mb-20">
    <div class="flex justify-between items-end">
      <div>
        <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">
          收件箱
        </div>
        <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-3 sm:mb-4">
          通知中心
        </h1>
        <p class="text-[9px] font-mono font-bold text-zinc-400 uppercase tracking-[0.2em]" aria-live="polite">
          {{ view.unreadCount }} 未阅读
        </p>
      </div>
      <button
        v-if="view.showReadAll"
        type="button"
        class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors duration-300 pb-1 border-b border-transparent hover:border-zinc-950 outline-none focus-visible:text-zinc-950 focus-visible:border-zinc-950"
        @click="emit('read-all')"
      >
        {{ view.readAllText }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { UserMessagesHeaderViewContract } from '@/view-contracts/userMessages'

defineProps<{
  view: UserMessagesHeaderViewContract
}>()

const emit = defineEmits<{
  'read-all': []
}>()
</script>
