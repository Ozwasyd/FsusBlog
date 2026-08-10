<template>
  <el-theme-mode-toggle
    :model-value="renderedMode"
    :compact="compact"
    :visibility="visibility"
    :variant="variant"
    :labels="resolvedLabels"
    :csp-safe="true"
    size="small"
    :label="themeModeCopy.label"
    @update:model-value="handleThemeModeUpdate"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  readInitialThemeMode,
  reconcileThemeRuntimeAfterHydration,
  useThemeRuntime,
  type ThemeMode
} from '@/services/themeRuntime'
import { FSUSBLOG_THEME_MODE_LABELS, type ThemeModeToggleLabels } from '@/components/ui/themeModeLabels'
import { useI18nText } from '@/composables/useI18nText'

const { messages } = useI18nText()
const themeModeCopy = computed(() => messages.value.layout.themeMode)

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

const initialMode = readInitialThemeMode()
const { mode, setThemeMode } = useThemeRuntime()
const hydrationSettled = ref(false)
const renderedMode = computed(() => hydrationSettled.value ? mode.value : initialMode)
const resolvedLabels = computed(() => ({
  ...FSUSBLOG_THEME_MODE_LABELS,
  ...props.labels,
}))

onMounted(() => {
  reconcileThemeRuntimeAfterHydration()
  hydrationSettled.value = true
})

function handleThemeModeUpdate(value: ThemeMode): void {
  setThemeMode(value)
}
</script>
