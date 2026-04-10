<template>
  <div :class="themeTokens.primitives.emptyRoot">
    <p :class="themeTokens.primitives.emptyTitle">{{ contract.title }}</p>
    <p v-if="contract.body" :class="themeTokens.primitives.emptyBody">{{ contract.body }}</p>
    <UiButton v-if="contract.action" :contract="contract.action" class="mt-4" />
  </div>
</template>

<script setup lang="ts">
import type { EmptyStateContract } from '@/ui-contracts/primitives';
import { themeTokens } from '@/ui-tokens/themeTokens';
import UiButton from './UiButton.vue';

defineProps<{
  contract: EmptyStateContract;
}>();
</script>
