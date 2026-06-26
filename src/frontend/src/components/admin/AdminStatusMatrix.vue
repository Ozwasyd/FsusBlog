<template>
  <div
    class="admin-status-matrix"
    :class="`admin-status-matrix--${density}`"
    role="list"
    :aria-label="ariaLabel"
  >
    <div
      v-for="item in items"
      :key="item.label"
      class="admin-status-matrix__slot"
      role="listitem"
    >
      <component
        :is="clickable ? 'button' : 'div'"
        class="admin-status-matrix__item"
        :class="{
          'is-clickable': clickable,
          'is-active': clickable && activeValue === item.value
        }"
        :data-tone="item.tone ?? 'neutral'"
        :type="clickable ? 'button' : undefined"
        :aria-pressed="clickable ? activeValue === item.value : undefined"
        @click="clickable ? emit('item-click', item) : undefined"
      >
        <div class="admin-status-matrix__label">
          <span class="admin-status-matrix__dot" aria-hidden="true" />
          <span class="admin-status-matrix__label-text">{{ item.label }}</span>
          <span v-if="item.meta" class="admin-status-matrix__meta">{{ item.meta }}</span>
        </div>
        <div class="admin-status-matrix__value">
          {{ item.displayValue ?? item.value }}
          <span
            v-if="item.bar"
            class="admin-status-matrix__bar"
            :style="{ width: `${Math.min(60, Math.max(0, item.bar.percent) * 0.6)}px` }"
            :data-tone="item.tone ?? 'neutral'"
            :aria-label="`占比 ${item.bar.percent}%`"
          />
        </div>
        <p v-if="item.helper" class="admin-status-matrix__helper">{{ item.helper }}</p>
      </component>
    </div>
  </div>
</template>

<script setup lang="ts">
export type AdminStatusMatrixTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export type AdminStatusMatrixDensity = 'default' | 'compact'

export interface AdminStatusMatrixItem {
  label: string
  value: string | number
  displayValue?: string | number
  tone?: AdminStatusMatrixTone
  helper?: string
  meta?: string
  bar?: { percent: number }
}

withDefaults(defineProps<{
  items: readonly AdminStatusMatrixItem[]
  clickable?: boolean
  activeValue?: string | number
  ariaLabel?: string
  density?: AdminStatusMatrixDensity
}>(), {
  clickable: false,
  activeValue: undefined,
  ariaLabel: undefined,
  density: 'default'
})

const emit = defineEmits<{
  'item-click': [item: AdminStatusMatrixItem]
}>()
</script>

<style scoped>
.admin-status-matrix {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  overflow: hidden;
  border-top: 1px solid var(--fsusblog-panel-border);
  border-left: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.admin-status-matrix--compact {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
}

.admin-status-matrix__slot {
  min-width: 0;
}

.admin-status-matrix__item {
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 12px 16px;
  background: var(--fsusblog-page-bg);
  border-right: 1px solid var(--fsusblog-panel-border);
  border-bottom: 1px solid var(--fsusblog-panel-border);
  border-left: 2px solid transparent;
}

.admin-status-matrix--compact .admin-status-matrix__item {
  min-height: 44px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 2px 10px;
  padding: 10px 12px;
}

.admin-status-matrix--compact .admin-status-matrix__label {
  gap: 6px;
  line-height: 1.2;
}

.admin-status-matrix__label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
}

.admin-status-matrix__dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--fsusblog-panel-border-strong);
}

.admin-status-matrix__label-text,
.admin-status-matrix__meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-status-matrix__meta {
  margin-left: auto;
  color: var(--fsusblog-text-subtle);
  font-size: 11px;
  font-weight: 600;
}

.admin-status-matrix__value {
  min-width: 0;
  margin-top: 6px;
  color: var(--fsusblog-text-primary);
  font-size: 15px;
  font-weight: 800;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.admin-status-matrix--compact .admin-status-matrix__value {
  margin-top: 0;
  font-size: 13px;
  font-weight: 750;
  line-height: 1.2;
}

.admin-status-matrix--compact .admin-status-matrix__helper {
  grid-column: 1 / -1;
  margin-top: 2px;
}

.admin-status-matrix__helper {
  margin-top: 4px;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.admin-status-matrix__item.is-clickable {
  appearance: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  min-height: 40px;
  font: inherit;
  color: inherit;
  transition:
    background-color var(--fsus-motion-control),
    border-color var(--fsus-motion-control),
    color var(--fsus-motion-control);
}

.admin-status-matrix__item.is-clickable:hover {
  border-left-color: var(--fsusblog-admin-status-info-border);
  color: var(--fsusblog-text-primary);
  background: var(--fsusblog-admin-status-weak-bg);
}

.admin-status-matrix__item.is-clickable:focus-visible {
  outline: 2px solid var(--fsusblog-color-primary);
  outline-offset: 2px;
}

.admin-status-matrix__item.is-active {
  border-left-color: var(--fsusblog-admin-status-info);
  background: var(--fsusblog-admin-status-weak-bg);
}

.admin-status-matrix__bar {
  display: inline-block;
  vertical-align: middle;
  height: 2px;
  margin-left: 8px;
  background: var(--fsusblog-panel-border);
  border-radius: 1px;
}

.admin-status-matrix__bar[data-tone='info'] {
  background: var(--fsusblog-admin-status-info);
}

.admin-status-matrix__bar[data-tone='success'] {
  background: var(--fsusblog-admin-status-success);
}

.admin-status-matrix__bar[data-tone='warning'] {
  background: var(--fsusblog-admin-status-warning);
}

.admin-status-matrix__bar[data-tone='danger'] {
  background: var(--fsusblog-admin-status-danger);
}

.admin-status-matrix__item[data-tone='info'] .admin-status-matrix__dot {
  background: var(--fsusblog-admin-status-info);
}

.admin-status-matrix__item[data-tone='success'] .admin-status-matrix__dot {
  background: var(--fsusblog-admin-status-success);
}

.admin-status-matrix__item[data-tone='warning'] .admin-status-matrix__dot {
  background: var(--fsusblog-admin-status-warning);
}

.admin-status-matrix__item[data-tone='danger'] .admin-status-matrix__dot {
  background: var(--fsusblog-admin-status-danger);
}

@media (max-width: 480px) {
  .admin-status-matrix {
    grid-template-columns: 1fr;
  }

  .admin-status-matrix__item {
    min-height: 52px;
    padding: 10px 12px;
  }

  .admin-status-matrix--compact .admin-status-matrix__item {
    min-height: 48px;
  }
}
</style>
