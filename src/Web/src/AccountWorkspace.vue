<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElButton, ElDrawer, ElSiteHeader } from '@ozwasyd/element-plus'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteHeaderPreferences from './SiteHeaderPreferences.vue'
import { siteTitle } from './siteBrand'

defineProps<{ home: string; label: string; links: readonly { to: string; label: string }[]; themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const route = useRoute()
const open = ref(false)
watch(() => route.fullPath, () => { open.value = false })
</script>

<template>
  <div class="account-workspace">
    <ElSiteHeader max-width="76rem">
      <template #brand><RouterLink class="workspace-brand" :to="home">{{ siteTitle }}</RouterLink></template>
      <template #desktop-actions>
        <SiteHeaderPreferences :theme-mode="themeMode" @theme="emit('theme', $event)" />
        <slot name="actions" />
      </template>
      <template #mobile-overflow-trigger>
        <ElButton text class="account-workspace-menu" v-bind="{ 'aria-haspopup': 'dialog', 'aria-expanded': open }" @click="open = true">
          {{ label }}
        </ElButton>
      </template>
    </ElSiteHeader>
    <div class="account-workspace-frame">
      <nav class="account-workspace-nav" :aria-label="label">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to">{{ link.label }}</RouterLink>
      </nav>
      <div class="account-workspace-content"><slot /></div>
    </div>
    <ElDrawer v-model="open" :title="label" direction="rtl" size="min(22rem, 100%)" append-to-body>
      <nav class="account-workspace-drawer" :aria-label="label">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to" @click="open = false">{{ link.label }}</RouterLink>
        <SiteHeaderPreferences :theme-mode="themeMode" @theme="emit('theme', $event)" />
        <div @click="open = false"><slot name="actions" /></div>
      </nav>
    </ElDrawer>
  </div>
</template>

<style scoped>
.workspace-brand { display: block; overflow: hidden; text-overflow: ellipsis; }
.account-workspace-menu { min-block-size: 44px; }
.account-workspace-frame {
  display: grid;
  grid-template-columns: 11rem minmax(0, 1fr);
  gap: clamp(1.25rem, 4vw, 3.25rem);
  width: min(76rem, 100%);
  margin-inline: auto;
  padding-inline: var(--fsusblog-page-gutter);
}
.account-workspace-nav, .account-workspace-drawer { display: grid; align-content: start; gap: .25rem; }
.account-workspace-nav { padding-block: clamp(2.75rem, 8vw, 5rem); }
.account-workspace-nav a, .account-workspace-drawer a {
  display: flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: .75rem;
  border-radius: var(--fsus-radius-control);
  color: var(--el-text-color-secondary);
  text-decoration: none;
}
.account-workspace-nav a:hover, .account-workspace-drawer a:hover,
.account-workspace-nav [aria-current="page"], .account-workspace-drawer [aria-current="page"] {
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
}
@media (max-width: 767px) {
  .account-workspace-frame { display: block; padding-inline: 0; }
  .account-workspace-nav { display: none; }
}
</style>
