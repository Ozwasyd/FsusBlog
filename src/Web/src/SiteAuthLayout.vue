<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { RouterLink } from 'vue-router'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteHeaderPreferences from './SiteHeaderPreferences.vue'
import { siteTitle } from './siteBrand'

defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const content = useTemplateRef<HTMLElement>('content')
defineExpose({ content })
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
  <main ref="content" class="auth-page site-auth-main" tabindex="-1">
    <slot />
  </main>
</template>
