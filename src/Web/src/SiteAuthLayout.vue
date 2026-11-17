<script setup lang="ts">
import { RouterLink } from 'vue-router'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteHeaderPreferences from './SiteHeaderPreferences.vue'
import { siteTitle } from './siteBrand'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
</script>

<template>
  <header class="site-auth-header">
    <div class="site-auth-bar">
      <RouterLink class="site-auth-brand" :to="{ name: 'home' }">{{ siteTitle }}</RouterLink>
      <div class="site-auth-actions">
        <SiteHeaderPreferences :theme-mode="themeMode" @theme="emit('theme', $event)" />
      </div>
    </div>
  </header>
  <main class="auth-page site-auth-main">
    <slot />
  </main>
</template>
