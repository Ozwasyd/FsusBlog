<script setup lang="ts">
import { computed } from 'vue'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteLocaleSelect from './SiteLocaleSelect.vue'
import SiteHeaderDropdown from './SiteHeaderDropdown.vue'
import { t, themeLabels } from './siteLocale'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const themes = computed(() => (['light', 'dark', 'system'] as const)
  .map(value => ({ value, label: themeLabels.value[value] })))
function selectTheme(mode: string) {
  if (mode === 'light' || mode === 'dark' || mode === 'system') emit('theme', mode)
}
</script>

<template>
  <SiteLocaleSelect desktop />
  <SiteHeaderDropdown class="site-theme-menu" :label="t('theme.label')" :selected="themeMode ?? 'system'"
    :items="themes" @select="selectTheme" />
</template>
