<script setup lang="ts">
import { ElOption, ElSelect } from '@ozwasyd/element-plus'
import { selectSiteLocale, siteLocale, t } from './siteLocale'

defineProps<{ desktop?: boolean }>()
const options = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'EN' },
] as const

function selectOption(value: unknown) {
  if (typeof value === 'string') selectSiteLocale(value)
}
</script>

<template>
  <ElSelect v-if="desktop" class="site-locale-combo" fit-input-width
    :ariaLabel="t('nav.language')" :model-value="siteLocale" @update:model-value="selectOption">
    <ElOption v-for="option in options" :key="option.value" v-bind="option" />
  </ElSelect>
  <select v-else class="site-locale-select" :aria-label="t('nav.language')" :value="siteLocale"
    @change="selectSiteLocale(($event.target as HTMLSelectElement).value)">
    <option v-for="option in options" :key="option.value" :lang="option.value" :value="option.value">{{ option.label }}</option>
  </select>
</template>
