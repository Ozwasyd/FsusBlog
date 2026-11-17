<script setup lang="ts">
import { selectSiteLocale, siteLocale, t } from './siteLocale'
</script>

<template>
  <select class="site-locale-select" :aria-label="t('nav.language')" :value="siteLocale"
    @change="selectSiteLocale(($event.target as HTMLSelectElement).value)">
    <option lang="zh-CN" value="zh-CN">中文</option>
    <option lang="en" value="en">EN</option>
  </select>
</template>
