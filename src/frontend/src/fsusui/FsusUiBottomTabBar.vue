<template>
  <FsuMobileDock
    class="fsu-bottom-tab-bar"
    :label="label"
    position="bottom"
    :motion="motion"
    :disabled="disabled"
    :safe-area="safeArea"
    :immediate="immediate"
    style="position: fixed; inset-inline: 0; inset-block-end: 0; z-index: var(--fsus-z-mobile-dock, 30);"
    data-fsus-bottom-tab-bar
  >
    <a
      v-for="item in items"
      :key="item.key"
      class="fsu-bottom-tab-bar__item"
      :class="{ 'is-active': item.key === activeKey }"
      :href="item.href"
      :aria-current="item.key === activeKey ? 'page' : undefined"
      :data-fsus-bottom-tab-item="item.key"
      @click="handleItemClick(item, $event)"
    >
      <span class="fsu-bottom-tab-bar__indicator" aria-hidden="true" />
      <span class="fsu-bottom-tab-bar__label">{{ item.label }}</span>
    </a>
  </FsuMobileDock>
</template>

<script setup lang="ts">
import { FsuMobileDock, type MotionPresetName } from '@/fsusui/motion'

type BottomTabItem = Readonly<{
  key: string
  label: string
  href: string
}>

withDefaults(
  defineProps<{
    items: readonly BottomTabItem[]
    activeKey?: string
    label?: string
    motion?: MotionPresetName
    disabled?: boolean
    safeArea?: boolean
    immediate?: boolean
  }>(),
  {
    activeKey: '',
    label: '主导航',
    motion: 'dock-settle',
    disabled: false,
    safeArea: true,
    immediate: false,
  },
)

const emit = defineEmits<{
  navigate: [item: BottomTabItem, event: MouseEvent]
}>()

function handleItemClick(item: BottomTabItem, event: MouseEvent): void {
  emit('navigate', item, event)
}
</script>
