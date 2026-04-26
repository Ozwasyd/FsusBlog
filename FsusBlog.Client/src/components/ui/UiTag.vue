<template>
  <span :class="tagClass">
    <slot>{{ label }}</slot>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TagTone, TagVariant } from '@/ui-contracts/primitives';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = withDefaults(defineProps<{
  label?: string;
  variant?: TagVariant;
  tone?: TagTone;
  hiddenOnMobile?: boolean;
}>(), {
  label: '',
  variant: 'ghost',
  tone: 'neutral',
  hiddenOnMobile: false
});

const tagClass = computed(() => [
  themeTokens.primitives.tagBase,
  themeTokens.primitives.tagVariants[props.variant],
  themeTokens.primitives.tagTones[props.tone],
  props.hiddenOnMobile ? 'hidden sm:inline-flex' : ''
].filter(Boolean).join(' '));
</script>
