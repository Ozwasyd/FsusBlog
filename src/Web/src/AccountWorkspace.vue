<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElButton, ElDrawer, ElSiteHeader } from '@ozwasyd/element-plus'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import SiteHeaderPreferences from './SiteHeaderPreferences.vue'
import { siteTitle } from './siteBrand'

defineProps<{ home: string; label: string; links: readonly { to: string; label: string }[]; themeMode?: ThemeMode; surface?: 'account' | 'task' }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const route = useRoute()
const open = ref(false)
watch(() => route.fullPath, () => { open.value = false })
</script>

<template>
  <div class="account-workspace" :class="{ 'is-task-surface': surface === 'task' }">
    <ElSiteHeader max-width="76rem">
      <template #brand><RouterLink class="workspace-brand" :to="home">{{ siteTitle }}</RouterLink></template>
      <template #desktop-actions>
        <SiteHeaderPreferences :theme-mode="themeMode" @theme="emit('theme', $event)" />
        <slot name="actions" :drawer="false" />
      </template>
      <template #mobile-overflow-trigger>
        <ElButton class="account-workspace-menu" v-bind="{ 'aria-haspopup': 'dialog', 'aria-expanded': open }" @click="open = true">
          {{ label }}
        </ElButton>
      </template>
    </ElSiteHeader>
    <div class="account-workspace-frame">
      <nav class="account-workspace-nav" :aria-label="label">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to">{{ link.label }}</RouterLink>
      </nav>
      <div class="account-workspace-content" tabindex="-1"><slot /></div>
    </div>
    <ElDrawer v-model="open" :title="label" direction="rtl" size="clamp(min(18.5rem, calc(100vw - 24px)), 80vw, 20rem)" append-to-body>
      <div class="account-workspace-drawer">
        <nav class="account-workspace-drawer-nav" :aria-label="label">
          <RouterLink v-for="link in links" :key="link.to" :to="link.to" @click="open = false">{{ link.label }}</RouterLink>
        </nav>
        <div class="account-workspace-drawer-section">
          <SiteHeaderPreferences mobile :theme-mode="themeMode" @theme="emit('theme', $event)" />
        </div>
        <div v-if="$slots.actions" class="account-workspace-drawer-section account-workspace-drawer-actions" @click="open = false">
          <slot name="actions" :drawer="true" />
        </div>
      </div>
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
.account-workspace-nav, .account-workspace-drawer-nav { display: grid; align-content: start; gap: .25rem; }
.account-workspace-drawer { display: grid; align-content: start; gap: 1rem; }
.account-workspace-drawer-section {
  padding-block-start: 1rem;
  border-block-start: 1px solid var(--el-border-color-lighter);
}
.account-workspace-drawer-actions {
  display: grid;
  gap: .5rem;
}
.account-workspace-drawer-actions :slotted(*) {
  inline-size: 100%;
  margin: 0;
}
.account-workspace-nav { padding-block: clamp(2.75rem, 8vw, 5rem); }
.account-workspace.is-task-surface .account-workspace-nav {
  padding-block: var(--fsus-space-6);
}
.account-workspace-content {
  min-width: 0;
}
.account-workspace.is-task-surface .account-workspace-content {
  padding-block: var(--fsus-space-6) var(--fsus-space-8);
}
.account-workspace-nav a, .account-workspace-drawer-nav a {
  position: relative;
  display: flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: .75rem;
  border-radius: var(--fsus-radius-control);
  color: var(--el-text-color-secondary);
  text-decoration: none;
  transition: color var(--fsus-motion-control) var(--fsus-motion-standard),
    background-color var(--fsus-motion-control) var(--fsus-motion-standard);
}
.account-workspace-nav a:hover, .account-workspace-drawer-nav a:hover,
.account-workspace-nav [aria-current="page"], .account-workspace-drawer-nav [aria-current="page"] {
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
}
.account-workspace-nav [aria-current="page"], .account-workspace-drawer-nav [aria-current="page"] {
  font-weight: 500;
}
.account-workspace-nav [aria-current="page"]::before, .account-workspace-drawer-nav [aria-current="page"]::before {
  content: "";
  position: absolute;
  inset-block: .5rem;
  inset-inline-start: 0;
  inline-size: 2px;
  border-radius: 999px;
  background: var(--fsus-scholarly-blue);
}
@media (max-width: 767px) {
  .account-workspace-frame { display: block; padding-inline: 0; }
  .account-workspace-nav { display: none; }
  .account-workspace.is-task-surface .account-workspace-content {
    padding-inline: var(--fsusblog-page-gutter);
    padding-block: var(--fsus-space-5) var(--fsus-space-6);
  }
}
</style>
