<template>
  <div
    class="locale-selector-runtime-adapter"
    data-locale-selector-runtime-adapter
    :data-compact="compact ? 'true' : 'false'"
    :data-active-locale="activeLocale"
  >
    <LocaleSelector
      :items="items"
      :active-locale="activeLocale"
      :pending-locale="pendingLocale"
      :open="menuOpen"
      :error-message="errorMessage"
      :compact="compact"
      @select="handleSelect"
      @open-change="handleOpenChange"
      @retry="handleRetry"
    />
  </div>
</template>

<script setup lang="ts">
import LocaleSelector from '@/components/ui/LocaleSelector.vue'
import { useLocaleSelectorRuntime } from '@/components/i18n/useLocaleSelectorRuntime'

withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false
})

const {
  activeLocale,
  items,
  pendingLocale,
  errorMessage,
  menuOpen,
  handleOpenChange,
  handleSelect,
  handleRetry
} = useLocaleSelectorRuntime()
</script>

<style scoped>
.locale-selector-runtime-adapter {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  vertical-align: middle;
}
</style>
