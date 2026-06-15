<template>
  <span v-if="hiddenOnMobile" class="hidden sm:inline-flex">
    <el-tag
      :type="tagType"
      :effect="tagEffect"
      :motion="fsusBlogMotionPresets.tagChip"
      size="small"
    >
      <slot>{{ label }}</slot>
    </el-tag>
  </span>
  <el-tag
    v-else
    :type="tagType"
    :effect="tagEffect"
    :motion="fsusBlogMotionPresets.tagChip"
    size="small"
  >
    <slot>{{ label }}</slot>
  </el-tag>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TagTone, TagVariant } from '@/ui-contracts/primitives';
import { toFsusUiTagEffect, toFsusUiTagType } from '@/fsusui/primitiveAdapters';
import { fsusBlogMotionPresets } from '@/fsusui/motion';

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

const tagType = computed(() => toFsusUiTagType(props.tone));
const tagEffect = computed(() => toFsusUiTagEffect(props.variant));
</script>
