<template>
  <div class="py-20 border-t border-zinc-100">
    <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-300 uppercase text-center">
      {{ view.title }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { UserMessagesEmptyStateViewContract } from '@/view-contracts/userMessages'

defineProps<{
  view: UserMessagesEmptyStateViewContract
}>()
</script>
