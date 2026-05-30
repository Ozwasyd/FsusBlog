<template>
  <span v-if="hiddenOnMobile" class="hidden sm:inline-flex">
    <el-tag
      :type="tagType"
      :effect="tagEffect"
      size="small"
    >
      <slot>{{ label }}</slot>
    </el-tag>
  </span>
  <el-tag
    v-else
    :type="tagType"
    :effect="tagEffect"
    size="small"
  >
    <slot>{{ label }}</slot>
  </el-tag>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TagTone, TagVariant } from '@/ui-contracts/primitives';

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

const tagType = computed((): Exclude<TagTone, 'neutral'> | undefined => {
  if (props.tone === 'neutral') {
    return undefined;
  }
  return props.tone;
});
const tagEffect = computed((): 'dark' | undefined => {
  if (props.variant === 'status') {
    return 'dark';
  }
  return undefined;
});
</script>
