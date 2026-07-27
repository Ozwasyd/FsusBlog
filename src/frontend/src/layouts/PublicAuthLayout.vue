<template>
  <div class="auth-page-shell min-h-screen w-full overflow-x-hidden">
    <SiteChromeHeaderAdapter
      :site-title="siteStore.siteInfo.title"
      :site-logo-url="siteStore.siteInfo.siteLogoUrl"
      :site-logo-dark-url="siteStore.siteInfo.siteLogoDarkUrl"
      :site-wordmark-url="siteStore.siteInfo.siteWordmarkUrl"
      :login-logo-url="siteStore.siteInfo.loginLogoUrl"
      :login-icon-url="siteStore.siteInfo.loginIconUrl"
      brand-context="auth"
      :brand-href="PUBLIC_FIXED_PATHS.home"
      brand-link-class="auth-header-brand"
      max-width="72rem"
      header-class="auth-header"
      inner-class="auth-header__inner"
      primary-row-class="auth-header__primary-row"
      desktop-actions-class="auth-header__actions"
      mobile-primary-actions-class="auth-header__mobile-actions"
      :show-desktop-theme-toggle="false"
      :show-mobile-theme-toggle="false"
    >
      <template #desktop-actions>
        <ThemeModeToggle visibility="desktop" />
        <router-link :to="authAction.to" class="auth-header-action">
          {{ authAction.label }}
        </router-link>
      </template>

      <template #mobile-primary-actions>
        <ThemeModeToggle visibility="mobile" variant="menu-button" />
        <router-link
          :to="authAction.to"
          class="auth-header-action auth-header-action--mobile"
        >
          {{ authAction.label }}
        </router-link>
      </template>
    </SiteChromeHeaderAdapter>

    <main
      class="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-start px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16"
    >
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { useI18nText } from '@/composables/useI18nText'
import { PUBLIC_FIXED_PATHS } from '@/public-renderers/publicRoutePaths'
import { useSiteStore } from '@/store/site'

const route = useRoute()
const siteStore = useSiteStore()
const { messages } = useI18nText()

const authAction = computed(() => {
  if (route.name === 'Register') {
    return { label: messages.value.public.shell.login, to: '/login' }
  }

  if (route.name === 'Recover') {
    return { label: messages.value.public.shell.login, to: '/login' }
  }

  return { label: messages.value.common.routeTitles.register, to: '/register' }
})
</script>

<style scoped>
@reference "@/assets/main.css";

.auth-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}

.auth-header-action {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: var(--fsus-radius-control-small);
  padding-inline: var(--fsus-space-3);
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  transition:
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.auth-header-action:hover,
.auth-header-action:focus-visible {
  color: var(--fsusblog-text-primary);
}

.auth-header-action:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.auth-header-action--mobile {
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}
</style>
