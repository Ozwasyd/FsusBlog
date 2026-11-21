<script setup lang="ts">
import { ElRadioButton, ElRadioGroup } from '@ozwasyd/element-plus'
import SiteHeaderDropdown from './SiteHeaderDropdown.vue'
import { selectSiteLocale, siteLocale, t } from './siteLocale'

defineProps<{ desktop?: boolean }>()
const options = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'EN' },
] as const
function chooseLocale(value: string | number | boolean | undefined) {
  if (typeof value === 'string') selectSiteLocale(value)
}
</script>

<template>
  <SiteHeaderDropdown v-if="desktop" class="site-locale-menu"
    :label="t('nav.language')" :selected="siteLocale" :items="options" @select="selectSiteLocale" />
  <ElRadioGroup v-else class="public-menu-segment-group public-menu-locale-group fsus-radio-group--touch"
    size="small" :label="t('nav.language')" :model-value="siteLocale" @update:model-value="chooseLocale">
    <ElRadioButton v-for="option in options" :key="option.value" class="public-menu-segment" :value="option.value">
      <span :lang="option.value">{{ option.label }}</span>
    </ElRadioButton>
  </ElRadioGroup>
</template>
