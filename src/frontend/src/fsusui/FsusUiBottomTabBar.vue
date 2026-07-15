<template>
  <nav
    ref="root"
    class="fsu-mobile-dock fsu-bottom-tab-bar"
    :class="{ 'fsu-mobile-dock--safe-area': safeArea }"
    :aria-label="label"
    data-fsus-mobile-dock="bottom"
    :data-fsus-motion-preset="motion"
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
  </nav>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { MotionPresetName } from '@/fsusui/motion'

type BottomTabItem = Readonly<{
  key: string
  label: string
  href: string
}>

const props = withDefaults(
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

const root = ref<HTMLElement>()
async function play(): Promise<void> {
  await nextTick()
  if (!root.value) return
  const { runMotion } = await import('@/fsusui/motion')
  runMotion(root.value, { name: props.motion, disabled: props.disabled })
}

onMounted(() => {
  if (props.immediate) void play()
})

watch(
  () => [props.motion, props.disabled, props.safeArea],
  () => {
    if (props.immediate) void play()
  },
)

function handleItemClick(item: BottomTabItem, event: MouseEvent): void {
  emit('navigate', item, event)
}

defineExpose({ play })
</script>

<style scoped>
.fsu-bottom-tab-bar {
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: var(--fsus-z-mobile-dock, 30);
}

.fsu-bottom-tab-bar.fsu-mobile-dock--safe-area {
  padding-bottom: max(var(--fsus-mobile-dock-padding-bottom, 0px), env(safe-area-inset-bottom));
}
</style>
