<template>
  <section class="workbench-panel" :aria-labelledby="resolvedTitleId">
    <header
      v-if="props.title || props.eyebrow || props.caption || $slots.header || $slots.actions"
      class="workbench-panel__header"
      :class="props.headerClass"
    >
      <slot name="header">
        <SectionTitle
          :id="resolvedTitleId"
          :eyebrow="props.eyebrow"
          :title="props.title"
          :caption="props.caption"
          :level="props.titleLevel"
        >
          <template v-if="$slots.title" #title>
            <slot name="title" />
          </template>
          <template v-if="$slots.caption" #caption>
            <slot name="caption" />
          </template>
        </SectionTitle>
      </slot>
      <slot name="actions" />
    </header>
    <slot />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import SectionTitle from '@/components/account/SectionTitle.vue'

const props = withDefaults(defineProps<{
  title?: string
  eyebrow?: string
  caption?: string
  titleId?: string
  titleLevel?: 2 | 3 | 4
  headerClass?: string
}>(), {
  title: '',
  eyebrow: '',
  caption: '',
  titleId: undefined,
  titleLevel: 2,
  headerClass: ''
})

const resolvedTitleId = computed(() => props.titleId)
</script>
