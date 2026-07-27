<template>
  <section class="account-page language-preference-page">
    <FsusUiTaskPageHeader
      title="语言与区域"
      description="选择自动跟随浏览器语言，或固定当前设备与账户使用的语言。"
      class="account-task-page-header"
    />

    <FsusUiSettingsSection
      title="语言偏好"
      description="登录账户的固定语言会跨设备同步；自动模式会删除当前设备的显式语言 Cookie，并重新使用浏览器 Accept-Language。"
    >
      <el-skeleton
        v-if="status === 'loading' && !preference"
        :rows="4"
        animated
        aria-label="正在加载语言偏好"
      />

      <form
        v-else
        class="language-preference-form"
        aria-label="语言偏好"
        @submit.prevent="save"
      >
        <el-radio-group
          v-model="draftMode"
          :disabled="busy"
          aria-label="语言偏好模式"
        >
          <el-radio value="auto">自动跟随浏览器语言</el-radio>
          <el-radio value="fixed">固定语言</el-radio>
        </el-radio-group>

        <el-select
          v-model="draftLocale"
          :disabled="busy || draftMode !== 'fixed'"
          aria-label="固定语言"
          placeholder="选择语言"
        >
          <el-option
            v-for="locale in ENABLED_LOCALES"
            :key="locale.code"
            :label="locale.nativeName"
            :value="locale.code"
          />
        </el-select>

        <p class="language-preference-device-state" role="status">
          当前设备生效语言：{{ activeLocaleName }}
        </p>

        <el-alert
          v-if="status === 'conflict'"
          title="偏好已在另一台设备更新。请刷新最新值后再重试。"
          type="warning"
          :closable="false"
          show-icon
        >
          <template #default>
            <el-button :disabled="busy" @click="reload">刷新并重试</el-button>
          </template>
        </el-alert>

        <el-alert
          v-else-if="status === 'failure'"
          title="语言偏好暂时不可用，尚未确认保存。"
          type="error"
          :closable="false"
          show-icon
        >
          <template #default>
            <el-button :disabled="busy" @click="reload">重试</el-button>
          </template>
        </el-alert>

        <el-alert
          v-else-if="status === 'success'"
          title="语言偏好已保存。"
          type="success"
          :closable="false"
          show-icon
        />

        <div>
          <el-button
            native-type="submit"
            type="primary"
            :loading="status === 'saving'"
            :disabled="busy || (draftMode === 'fixed' && !draftLocale)"
          >
            保存语言偏好
          </el-button>
        </div>
      </form>
    </FsusUiSettingsSection>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { FsusUiSettingsSection, FsusUiTaskPageHeader } from '@/fsusui'
import { activeLocale, ENABLED_LOCALES } from '@/locales'
import type { SupportedLocale } from '@/locales/localeCatalog'
import { localePreferenceCommandPort } from '@/services/localePreferenceCommandPort'

const {
  preference,
  status,
  ensureLoaded,
  refresh,
  setAuto,
  setFixed
} = localePreferenceCommandPort

const draftMode = ref<'auto' | 'fixed'>('auto')
const draftLocale = ref<SupportedLocale>('zh-CN')
const busy = computed(() => status.value === 'loading' || status.value === 'saving')
const activeLocaleName = computed(() =>
  ENABLED_LOCALES.find((locale) => locale.code === activeLocale.value)?.nativeName
  ?? activeLocale.value
)

watch(preference, (snapshot) => {
  if (!snapshot) return
  draftMode.value = snapshot.mode
  if (snapshot.fixedLocale) draftLocale.value = snapshot.fixedLocale
}, { immediate: true })

onMounted(() => {
  void ensureLoaded().catch(() => undefined)
})

const save = async (): Promise<void> => {
  try {
    if (draftMode.value === 'auto') {
      await setAuto()
    } else {
      await setFixed(draftLocale.value)
    }
  } catch {
    // The shared command port exposes conflict/failure state for inline recovery.
  }
}

const reload = async (): Promise<void> => {
  try {
    await refresh()
  } catch {
    // The same failure state remains visible with a retry action.
  }
}
</script>

<style scoped>
.language-preference-form {
  display: grid;
  gap: var(--fsus-space-5);
  max-width: 40rem;
}

.language-preference-device-state {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  overflow-wrap: anywhere;
}
</style>
