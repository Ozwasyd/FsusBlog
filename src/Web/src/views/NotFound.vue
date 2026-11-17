<script setup lang="ts">
import { t } from '../siteLocale'
</script>

<template>
  <section class="reading-column editorial-page">
    <h1>{{ t('page.missing') }}</h1>
    <p>{{ t('reading.pageMoved') }}</p>
    <RouterLink to="/">{{ t('reading.returnHome') }}</RouterLink>
  </section>
</template>
