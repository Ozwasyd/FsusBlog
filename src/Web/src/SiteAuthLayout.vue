<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ElThemeModeToggle } from '@ozwasyd/element-plus'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteLocaleSelect from './SiteLocaleSelect.vue'
import { t, themeLabels } from './siteLocale'
import { siteTitle } from './siteBrand'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
</script>

<template>
  <header class="site-auth-header">
    <div class="site-auth-bar">
      <RouterLink class="site-auth-brand" :to="{ name: 'home' }">{{ siteTitle }}</RouterLink>
      <div class="site-auth-actions">
        <SiteLocaleSelect />
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" :label="t('theme.label')" :labels="themeLabels" csp-safe @update:model-value="emit('theme', $event)" />
      </div>
    </div>
  </header>
  <main class="auth-page site-auth-main">
    <slot />
  </main>
</template>
