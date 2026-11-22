<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox } from '@ozwasyd/element-plus'
import { readerRegistrationAvailable, registerReaderPasskey } from '../../../Contracts/reader-registration'
import { t, type MessageKey } from '../siteLocale'
import { readInitialRegisterState } from '../workspacePreload'

const initialRegister = readInitialRegisterState()
const checking = ref(!initialRegister)
const available = ref(initialRegister?.available ?? false)
const agreed = ref(false)
const busy = ref(false)
const registered = ref(false)
const failure = ref<MessageKey | ''>('')
const lifetime = new AbortController()
onUnmounted(() => lifetime.abort())

async function checkAvailability() {
  if (busy.value || lifetime.signal.aborted) return
  checking.value = true
  available.value = false
  failure.value = ''
  try {
    const enabled = await readerRegistrationAvailable(lifetime.signal)
    if (!lifetime.signal.aborted) available.value = enabled
  } catch {
    if (!lifetime.signal.aborted) failure.value = 'readerRegistration.checkFailed'
  } finally {
    if (!lifetime.signal.aborted) checking.value = false
  }
}

async function register() {
  if (checking.value || !available.value || !agreed.value || busy.value || registered.value || lifetime.signal.aborted) return
  busy.value = true
  failure.value = ''
  try {
    await registerReaderPasskey(lifetime.signal)
    if (!lifetime.signal.aborted) registered.value = true
  } catch (error) {
    if (!lifetime.signal.aborted) failure.value = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'readerRegistration.cancelled' : 'readerRegistration.failed'
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

onMounted(() => {
  if (!initialRegister) void checkAvailability()
})
</script>

<template>
  <div class="auth-heading">
    <h1>{{ t('page.register') }}</h1>
    <p>{{ t('readerRegistration.subtitle') }}</p>
  </div>
  <div v-if="registered" class="auth-form register-state" role="status">
    <ElAlert :title="t('readerRegistration.created')" type="success" :closable="false" show-icon />
    <RouterLink class="register-next-link" to="/login">{{ t('readerRegistration.login') }}</RouterLink>
  </div>
  <div v-else-if="checking" class="auth-form register-state" role="status">
    <p class="auth-secondary-hint">{{ t('readerRegistration.checking') }}</p>
  </div>
  <div v-else-if="!available" class="auth-form register-state">
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <p v-else class="auth-secondary-hint" role="status">{{ t('readerRegistration.unavailable') }}</p>
    <div class="auth-secondary-actions">
      <ElButton native-type="button" @click="checkAvailability">{{ t('readerRegistration.checkAgain') }}</ElButton>
    </div>
  </div>
  <form v-else class="auth-form register-form" @submit.prevent="register">
    <div class="auth-secondary-panel register-consent-panel">
      <div class="register-scope">
        <p class="auth-secondary-hint">{{ t('readerRegistration.readerOnly') }}</p>
        <RouterLink class="register-guidelines-link" to="/guidelines" target="_blank" rel="noopener noreferrer">
          {{ t('readerRegistration.guidelines') }}
        </RouterLink>
      </div>
      <div class="register-consent-row">
        <ElCheckbox :model-value="agreed" :disabled="busy" @update:model-value="agreed = $event === true">
          {{ t('readerRegistration.consent') }}
        </ElCheckbox>
      </div>
    </div>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElButton native-type="submit" type="primary" size="large" :loading="busy" :disabled="!agreed || busy">
      {{ t('readerRegistration.create') }}
    </ElButton>
  </form>
  <div v-if="!registered" class="auth-footer register-footer">
    <RouterLink to="/login">{{ t('readerRegistration.existingAccount') }}</RouterLink>
  </div>
</template>

<style scoped>
.register-form {
  gap: 1.25rem;
}

.register-consent-panel {
  gap: .875rem;
}

.register-scope {
  display: grid;
  gap: .5rem;
}

.register-guidelines-link {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-block-size: 32px;
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-color-primary);
  text-decoration: none;
}

.register-guidelines-link:hover,
.register-guidelines-link:focus-visible {
  text-decoration: underline;
  text-underline-offset: 4px;
}

.register-consent-row {
  padding-block-start: .75rem;
  border-block-start: 1px solid var(--el-border-color-lighter);
}

.register-next-link {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  font-weight: 500;
  color: var(--el-color-primary);
  text-decoration: none;
}

.register-next-link:hover,
.register-next-link:focus-visible {
  text-decoration: underline;
  text-underline-offset: 4px;
}

.register-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.register-footer a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
  text-decoration: none;
}

.register-footer a:hover,
.register-footer a:focus-visible {
  color: var(--el-text-color-primary);
  text-decoration: underline;
  text-underline-offset: 4px;
}
</style>
