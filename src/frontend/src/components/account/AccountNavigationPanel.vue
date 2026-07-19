<template>
  <div class="account-navigation-panel" :data-variant="variant">
    <nav class="account-global-module-nav" :aria-label="`${areaLabel}一级模块`">
      <h2 v-if="headingId" :id="headingId" class="account-sidebar-index-label">
        {{ areaLabel }}导航
      </h2>
      <ul class="account-global-module-list" role="list">
        <li v-for="group in groups" :key="group.key">
          <router-link
            :to="group.to"
            class="account-module-link"
            :class="{ 'account-module-link-active': isAccountNavGroupActive(group, route.path) }"
            :aria-current="isAccountNavGroupActive(group, route.path) ? 'location' : undefined"
            @click="$emit('navigate')"
          >
            <span class="account-module-link__label">{{ group.label }}</span>
            <span v-if="group.helper" class="account-module-link__helper">{{ group.helper }}</span>
          </router-link>
        </li>
      </ul>
    </nav>

    <section
      v-if="currentGroup && currentGroup.items.length > 1"
      class="account-local-navigation"
      :aria-labelledby="localNavigationTitleId"
    >
      <h2 :id="localNavigationTitleId" class="account-local-navigation__title">
        {{ currentGroup.label }}内导航
      </h2>
      <nav :aria-label="`${currentGroup.label}局部导航`">
        <ul class="account-local-navigation__list" role="list">
          <li v-for="item in currentGroup.items" :key="item.to">
            <router-link
              :to="item.to"
              class="account-local-navigation__link"
              :class="{ 'account-local-navigation__link--active': isAccountNavItemActive(item, route.path) }"
              :aria-current="isAccountNavItemActive(item, route.path) ? 'page' : undefined"
              @click="$emit('navigate')"
            >
              <span>{{ item.label }}</span>
              <span v-if="item.helper" class="account-local-navigation__helper">{{ item.helper }}</span>
            </router-link>
          </li>
        </ul>
      </nav>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  isAccountNavGroupActive,
  isAccountNavItemActive,
  type AccountNavGroup
} from '@/layouts/accountNav'

const props = withDefaults(defineProps<{
  areaLabel: string
  groups: readonly AccountNavGroup[]
  headingId?: string
  variant?: 'desktop' | 'mobile'
}>(), {
  headingId: '',
  variant: 'desktop'
})

defineEmits<{
  (e: 'navigate'): void
}>()

const route = useRoute()
const currentGroup = computed(() => (
  [...props.groups].reverse().find((group) => isAccountNavGroupActive(group, route.path))
  ?? props.groups[0]
  ?? null
))
const localNavigationTitleId = computed(() => (
  `account-${props.variant}-local-navigation-title`
))
</script>

<style scoped>
.account-navigation-panel,
.account-global-module-nav,
.account-local-navigation {
  min-width: 0;
}

.account-sidebar-index-label,
.account-local-navigation__title {
  margin: 0;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.4;
  text-transform: none;
}

.account-global-module-list,
.account-local-navigation__list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.account-sidebar-index-label + .account-global-module-list {
  margin-top: 1rem;
}

.account-module-link,
.account-local-navigation__link {
  position: relative;
  display: grid;
  min-height: 2.75rem;
  min-width: 0;
  align-content: center;
  border-radius: var(--fsus-radius-control-small);
  color: var(--fsusblog-text-tertiary);
  outline: none;
  transition:
    background var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-module-link {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem 0.375rem 1rem;
}

.account-module-link::before,
.account-local-navigation__link::before {
  position: absolute;
  top: 50%;
  left: 0;
  width: 2px;
  height: 0;
  background: var(--fsusblog-color-primary);
  content: '';
  opacity: 0;
  transform: translateY(-50%);
  transition:
    height var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-module-link:hover,
.account-module-link:focus-visible,
.account-module-link-active,
.account-local-navigation__link:hover,
.account-local-navigation__link:focus-visible,
.account-local-navigation__link--active {
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-primary);
}

.account-module-link:focus-visible,
.account-local-navigation__link:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.account-module-link:hover::before,
.account-module-link:focus-visible::before,
.account-module-link-active::before,
.account-local-navigation__link:hover::before,
.account-local-navigation__link:focus-visible::before,
.account-local-navigation__link--active::before {
  height: 1.25rem;
  opacity: 1;
}

.account-module-link__label,
.account-local-navigation__link > span:first-child {
  min-width: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
}

.account-module-link__helper,
.account-local-navigation__helper {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
}

.account-local-navigation {
  margin-top: 1.25rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding-top: 1rem;
}

.account-local-navigation__title {
  margin-bottom: 0.625rem;
}

.account-local-navigation__link {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem 0.375rem 1rem;
}

.account-navigation-panel[data-variant="mobile"] .account-global-module-list,
.account-navigation-panel[data-variant="mobile"] .account-local-navigation__list {
  gap: 0.125rem;
}
</style>
