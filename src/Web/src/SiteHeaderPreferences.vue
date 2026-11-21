<script setup lang="ts">
import { computed } from 'vue'
import { ElRadioButton, ElRadioGroup } from '@ozwasyd/element-plus'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteLocaleSelect from './SiteLocaleSelect.vue'
import SiteHeaderDropdown from './SiteHeaderDropdown.vue'
import { t, themeLabels } from './siteLocale'

defineProps<{ themeMode?: ThemeMode; mobile?: boolean }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const themes = computed(() => (['light', 'dark', 'system'] as const)
  .map(value => ({ value, label: themeLabels.value[value] })))
function selectTheme(mode: string | number | boolean | undefined) {
  if (mode === 'light' || mode === 'dark' || mode === 'system') emit('theme', mode)
}
</script>

<template>
  <div v-if="mobile" class="site-mobile-preferences">
    <SiteLocaleSelect />
    <ElRadioGroup class="public-menu-segment-group fsus-radio-group--touch"
      size="small" :label="t('theme.label')" :model-value="themeMode ?? 'system'" @update:model-value="selectTheme">
      <ElRadioButton v-for="item in themes" :key="item.value" class="public-menu-segment" :value="item.value">
        {{ item.label }}
      </ElRadioButton>
    </ElRadioGroup>
  </div>
  <template v-else>
    <SiteLocaleSelect desktop />
    <SiteHeaderDropdown class="site-theme-menu" :label="t('theme.label')" :selected="themeMode ?? 'system'"
      :items="themes" @select="selectTheme" />
  </template>
</template>

<style scoped>
.site-mobile-preferences {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: .5rem;
}
</style>
