<template>
  <el-theme-mode-toggle
    :model-value="mode"
    :compact="compact"
    :visibility="visibility"
    :variant="variant"
    :labels="resolvedLabels"
    size="small"
    :label="themeModeCopy.label"
    @update:model-value="handleThemeModeUpdate"
  />
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { reconcileThemeRuntimeAfterHydration, useThemeRuntime, type ThemeMode } from '@/services/themeRuntime'
import { FSUSBLOG_THEME_MODE_LABELS, type ThemeModeToggleLabels } from '@/components/ui/themeModeLabels'
import { FSUSBLOG_LAYOUT_COPY } from '@/copy'

const themeModeCopy = FSUSBLOG_LAYOUT_COPY.themeMode

const props = withDefaults(defineProps<{
  compact?: boolean
  visibility?: 'always' | 'desktop' | 'mobile'
  variant?: 'segmented' | 'menu-button'
  labels?: ThemeModeToggleLabels
}>(), {
  compact: true,
  visibility: 'always',
  variant: 'segmented',
  labels: () => ({})
})

const { mode, setThemeMode } = useThemeRuntime()
const resolvedLabels = computed(() => ({
  ...FSUSBLOG_THEME_MODE_LABELS,
  ...props.labels,
}))

onMounted(() => {
  reconcileThemeRuntimeAfterHydration()
})

function handleThemeModeUpdate(value: ThemeMode): void {
  setThemeMode(value)
}
</script>
