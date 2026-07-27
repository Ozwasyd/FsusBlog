<template>
  <el-select
    :model-value="selection"
    :disabled="busy"
    :loading="status === 'loading'"
    aria-label="语言偏好"
    class="locale-preference-header-selector"
    @change="handleChange"
  >
    <el-option label="自动" value="auto" />
    <el-option
      v-for="locale in ENABLED_LOCALES"
      :key="locale.code"
      :label="locale.nativeName"
      :value="locale.code"
    />
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { ENABLED_LOCALES, isSupportedLocale } from '@/locales'
import { localePreferenceCommandPort } from '@/services/localePreferenceCommandPort'
import { showErrorToast } from '@/utils/errorPresentation'

const {
  preference,
  status,
  ensureLoaded,
  setAuto,
  setFixed
} = localePreferenceCommandPort

const selection = computed(() =>
  preference.value?.mode === 'fixed' && preference.value.fixedLocale
    ? preference.value.fixedLocale
    : 'auto'
)
const busy = computed(() => status.value === 'loading' || status.value === 'saving')

onMounted(() => {
  void ensureLoaded().catch(() => undefined)
})

const handleChange = async (value: unknown): Promise<void> => {
  try {
    if (value === 'auto') {
      await setAuto()
    } else if (isSupportedLocale(value)) {
      await setFixed(value)
    }
  } catch (error) {
    showErrorToast(error, '语言偏好保存失败，请重试。')
  }
}
</script>

<style scoped>
.locale-preference-header-selector {
  width: 11rem;
  max-width: 100%;
}
</style>
