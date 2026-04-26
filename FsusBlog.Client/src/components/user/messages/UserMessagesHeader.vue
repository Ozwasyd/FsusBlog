<template>
  <header class="mb-10 sm:mb-16">
    <div class="flex flex-col gap-5 sm:flex-row sm:justify-between sm:items-end">
      <div class="min-w-0">
        <div class="text-[9px] sm:text-[10px] font-bold tracking-normal text-[#A1A1AA] uppercase mb-5 sm:mb-6">
          收件箱
        </div>
        <h1 class="text-3xl sm:text-5xl font-bold tracking-normal text-[#0F0F11] mb-3 sm:mb-6">
          通知中心
        </h1>
        <p class="text-[9px] font-mono font-bold text-[#A1A1AA] uppercase tracking-normal" aria-live="polite">
          {{ view.unreadCount }} 未阅读
        </p>
      </div>
      <button
        v-if="view.showReadAll"
        type="button"
        class="min-h-11 self-start text-[9px] font-bold uppercase tracking-normal text-[#A1A1AA] hover:text-[#0F0F11] transition-colors duration-300 pb-1 border-b border-transparent hover:border-[#0F0F11] outline-none focus-visible:text-[#0F0F11] focus-visible:border-[#0F0F11] sm:self-auto"
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
