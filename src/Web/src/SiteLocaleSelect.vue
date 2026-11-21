<script setup lang="ts">
import { ArrowDown } from '@ozwasyd/element-plus/icons-vue'
import SiteHeaderDropdown from './SiteHeaderDropdown.vue'
import { selectSiteLocale, siteLocale, t } from './siteLocale'

defineProps<{ desktop?: boolean }>()
const options = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'EN' },
] as const

</script>

<template>
  <SiteHeaderDropdown v-if="desktop" class="site-locale-menu"
    :label="t('nav.language')" :selected="siteLocale" :items="options" @select="selectSiteLocale" />
  <span v-else class="site-select-field">
    <select class="site-locale-select" :aria-label="t('nav.language')" :value="siteLocale"
      @change="selectSiteLocale(($event.target as HTMLSelectElement).value)">
      <option v-for="option in options" :key="option.value" :lang="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <ArrowDown class="site-select-chevron" v-bind="{ 'aria-hidden': true }" />
  </span>
</template>
