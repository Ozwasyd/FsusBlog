<script setup lang="ts">
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
defineProps<{
  surface?: { key: number; compact: boolean; events: { close: () => void; closed: () => void; opened: () => void } }
  dockTarget?: HTMLElement
  foreground: boolean
  expanded: boolean
  headingId: string
  panelName: string
}>()
const emit = defineEmits<{ keydown: [event: KeyboardEvent]; dismiss: [] }>()
</script>

<template>
  <Teleport v-if="surface && !surface.compact" :to="dockTarget ?? 'body'" :disabled="!dockTarget">
    <aside
      v-show="foreground"
      :key="surface.key"
      class="outline-pane"
      :class="{ 'outline-pane--docked': Boolean(dockTarget) }"
      :aria-labelledby="headingId"
      @keydown="emit('keydown', $event)"
    >
      <header class="outline-header">
        <h2 :id="headingId">{{ panelName }}</h2>
        <ElButton text size="small" native-type="button" @click="emit('dismiss')">{{ t('comment.close') }}</ElButton>
      </header>
      <slot />
    </aside>
  </Teleport>
  <ElDrawer
    v-if="surface && surface.compact"
    :key="surface.key"
    :model-value="expanded"
    :title="panelName"
    direction="ltr"
    size="min(86vw, 22rem)"
    append-to-body
    v-on="surface.events"
  >
    <slot />
  </ElDrawer>
</template>

<style scoped>
.outline-pane {
  position: fixed;
  z-index: 30;
  inset-block: calc(6rem + var(--fsus-space-4)) auto;
  inset-inline-start: var(--fsus-space-4);
  display: grid;
  max-block-size: calc(100dvh - 6rem - 2 * var(--fsus-space-4));
  inline-size: min(20rem, 30vw);
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
  box-shadow: var(--fsus-shadow-panel);
}
.outline-pane--docked {
  position: static;
  z-index: auto;
  inset: auto;
  inline-size: 17rem;
  block-size: 100%;
  max-block-size: none;
  border: 0;
  border-inline-end: 1px solid var(--fsus-border);
  border-radius: 0;
  box-shadow: none;
}
.outline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
  padding: var(--fsus-space-3) var(--fsus-space-4);
  border-block-end: 1px solid var(--fsus-border);
}
.outline-header h2 {
  margin: 0;
  font-size: var(--fsus-typography-heading-sm-size);
  font-weight: 600;
}
</style>
