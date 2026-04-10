<template>
  <span :class="tagClass">
    <slot>{{ contract.label }}</slot>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TagContract } from '@/ui-contracts/primitives';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = defineProps<{
  contract: TagContract;
}>();

const tagClass = computed(() => [
  themeTokens.primitives.tagGhost,
  props.contract.hiddenOnMobile ? 'hidden sm:inline' : ''
].filter(Boolean).join(' '));
</script>
