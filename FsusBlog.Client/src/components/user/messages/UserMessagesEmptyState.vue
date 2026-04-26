<template>
  <div class="py-20 border-t border-[#F4F4F5]">
    <p class="text-[11px] font-bold tracking-normal text-[#D4D4D8] uppercase">
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
