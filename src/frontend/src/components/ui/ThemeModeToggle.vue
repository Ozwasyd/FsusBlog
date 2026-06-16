<template>
  <el-theme-mode-toggle
    :model-value="mode"
    :compact="compact"
    :visibility="visibility"
    :variant="variant"
    :labels="labels"
    size="small"
    label="主题模式"
    @update:model-value="handleThemeModeUpdate"
  />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { reconcileThemeRuntimeAfterHydration, useThemeRuntime, type ThemeMode } from '@/services/themeRuntime'

type ThemeModeToggleLabels = {
  light?: string
  dark?: string
  system?: string
  lightShort?: string
  darkShort?: string
  systemShort?: string
}

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

onMounted(() => {
  reconcileThemeRuntimeAfterHydration()
})

function handleThemeModeUpdate(value: ThemeMode): void {
  setThemeMode(value)
}
</script>
