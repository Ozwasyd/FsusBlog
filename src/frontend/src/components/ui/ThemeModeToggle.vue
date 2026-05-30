<template>
  <el-theme-mode-toggle
    :model-value="mode"
    :compact="compact"
    :visibility="visibility"
    size="small"
    label="主题模式"
    @update:model-value="handleThemeModeUpdate"
  />
</template>

<script setup lang="ts">
import { useThemeRuntime, type ThemeMode } from '@/services/themeRuntime'

const props = withDefaults(defineProps<{
  compact?: boolean
  visibility?: 'always' | 'desktop' | 'mobile'
}>(), {
  compact: true,
  visibility: 'always'
})

const { mode, setThemeMode } = useThemeRuntime()

function handleThemeModeUpdate(value: ThemeMode): void {
  setThemeMode(value)
}
</script>
