<template>
  <FsusUiSiteHeader
    class="site-chrome-header"
    :class="headerClass"
    :aria-label="ariaLabel"
    :nav-aria-label="navAriaLabel"
    :sticky="sticky"
    :max-width="maxWidth"
    :inner-class="innerClass"
    :primary-row-class="primaryRowClass"
    :brand-nav-class="brandNavClass"
    :desktop-actions-class="desktopActionsClass"
    :mobile-primary-actions-class="mobilePrimaryActionsClass"
    :mobile-secondary-actions-class="mobileSecondaryActionsClass"
  >
    <template #brand>
      <a :href="brandHref" :class="brandLinkClass" v-bind="brandDataAttributes">
        <span v-if="hasBrandImage" class="site-chrome-header__brand-mark">
          <img
            v-if="brandImageLight"
            :src="brandImageLight"
            :alt="siteTitleText"
            class="site-chrome-header__brand-image site-chrome-header__brand-image--light"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
          <img
            v-if="brandImageDark"
            :src="brandImageDark"
            :alt="siteTitleText"
            class="site-chrome-header__brand-image site-chrome-header__brand-image--dark"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
        </span>
        <template v-else>
          {{ siteTitleText }}
        </template>
      </a>
    </template>

    <template v-if="hasDesktopNav" #desktop-nav>
      <slot name="desktop-nav">
        <a
          v-for="item in navItems"
          :key="item.key"
          :href="item.href"
          :class="navLinkClass(item.key)"
          :data-public-nav="item.key"
        >
          {{ item.label }}
        </a>
      </slot>
    </template>

    <template v-if="hasDesktopActions" #desktop-actions>
      <slot name="desktop-actions">
        <ThemeModeToggle
          v-if="showDesktopThemeToggle"
          visibility="desktop"
          :labels="themeModeLabels"
        />
      </slot>
    </template>

    <template v-if="hasMobilePrimaryActions" #mobile-primary-actions>
      <slot name="mobile-primary-actions">
        <ThemeModeToggle
          v-if="showMobileThemeToggle"
          visibility="mobile"
          variant="menu-button"
          :labels="themeModeLabels"
        />
      </slot>
    </template>

    <template v-if="$slots['mobile-overflow-trigger']" #mobile-overflow-trigger>
      <slot name="mobile-overflow-trigger" />
    </template>

    <template
      v-if="$slots['mobile-secondary-actions']"
      #mobile-secondary-actions
    >
      <slot name="mobile-secondary-actions" />
    </template>
  </FsusUiSiteHeader>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { FsusUiSiteHeader } from '@/fsusui/siteHeader'
import { PUBLIC_SHELL_DEFAULTS } from '@/public-renderers/publicShellState'

export type SiteChromeClassValue =
  | string
  | Record<string, boolean>
  | SiteChromeClassValue[]

export type SiteChromeNavItem = Readonly<{
  key: string
  label: string
  href: string
}>

export type SiteChromeThemeModeLabels = Readonly<{
  light?: string
  dark?: string
  system?: string
  lightShort?: string
  darkShort?: string
  systemShort?: string
}>

const PUBLIC_THEME_MODE_LABELS: SiteChromeThemeModeLabels = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  lightShort: '浅',
  darkShort: '深',
  systemShort: '系统',
}

const props = withDefaults(
  defineProps<{
    siteTitle?: string | null
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    brandHref?: string
    brandLinkClass?: SiteChromeClassValue
    navItems?: SiteChromeNavItem[]
    activeNav?: string
    ariaLabel?: string
    navAriaLabel?: string
    sticky?: boolean
    maxWidth?: string
    headerClass?: SiteChromeClassValue
    innerClass?: SiteChromeClassValue
    primaryRowClass?: SiteChromeClassValue
    brandNavClass?: SiteChromeClassValue
    desktopActionsClass?: SiteChromeClassValue
    mobilePrimaryActionsClass?: SiteChromeClassValue
    mobileSecondaryActionsClass?: SiteChromeClassValue
    navLinkBaseClass?: SiteChromeClassValue
    activeNavLinkClass?: SiteChromeClassValue
    showDesktopThemeToggle?: boolean
    showMobileThemeToggle?: boolean
    themeModeLabels?: SiteChromeThemeModeLabels
  }>(),
  {
    siteTitle: PUBLIC_SHELL_DEFAULTS.siteTitle,
    siteLogoUrl: '',
    siteLogoDarkUrl: '',
    siteWordmarkUrl: '',
    brandHref: '/',
    brandLinkClass: '',
    navItems: () => [],
    activeNav: '',
    ariaLabel: '站点导航',
    navAriaLabel: '主导航',
    sticky: true,
    maxWidth: '64rem',
    headerClass: '',
    innerClass: '',
    primaryRowClass: '',
    brandNavClass: '',
    desktopActionsClass: '',
    mobilePrimaryActionsClass: '',
    mobileSecondaryActionsClass: '',
    navLinkBaseClass: '',
    activeNavLinkClass: '',
    showDesktopThemeToggle: true,
    showMobileThemeToggle: true,
    themeModeLabels: () => PUBLIC_THEME_MODE_LABELS,
  },
)

const slots = useSlots()

const siteTitleText = computed(
  () => props.siteTitle?.trim() || PUBLIC_SHELL_DEFAULTS.siteTitle,
)
const brandImageLight = computed(
  () =>
    props.siteWordmarkUrl?.trim() ||
    props.siteLogoUrl?.trim() ||
    props.siteLogoDarkUrl?.trim() ||
    '',
)
const brandImageDark = computed(
  () =>
    props.siteWordmarkUrl?.trim() ||
    props.siteLogoDarkUrl?.trim() ||
    props.siteLogoUrl?.trim() ||
    '',
)
const hasBrandImage = computed(() =>
  Boolean(brandImageLight.value || brandImageDark.value),
)
const hasDesktopNav = computed(
  () => props.navItems.length > 0 || Boolean(slots['desktop-nav']),
)
const hasDesktopActions = computed(
  () => props.showDesktopThemeToggle || Boolean(slots['desktop-actions']),
)
const hasMobilePrimaryActions = computed(
  () =>
    props.showMobileThemeToggle ||
    Boolean(slots['mobile-primary-actions']) ||
    Boolean(slots['mobile-overflow-trigger']),
)

const brandDataAttributes = computed(() => ({
  'data-public-nav': 'home',
}))

function navLinkClass(key: string): SiteChromeClassValue[] {
  return [
    props.navLinkBaseClass,
    { 'is-active': key === props.activeNav },
    key === props.activeNav ? props.activeNavLinkClass : '',
  ]
}
</script>

<style scoped>
@reference "@/assets/main.css";

.site-chrome-header__brand-mark {
  display: inline-flex;
  min-width: 0;
  max-width: min(14rem, 42vw);
  align-items: center;
}

.site-chrome-header__brand-image {
  display: block;
  max-height: 1.75rem;
  max-width: 100%;
  object-fit: contain;
}

.site-chrome-header__brand-image--dark {
  display: none;
}

:global(html.dark) .site-chrome-header__brand-image--light,
:global(html[data-theme-resolved='dark'])
  .site-chrome-header__brand-image--light {
  display: none;
}

:global(html.dark) .site-chrome-header__brand-image--dark,
:global(html[data-theme-resolved='dark'])
  .site-chrome-header__brand-image--dark {
  display: block;
}
</style>
