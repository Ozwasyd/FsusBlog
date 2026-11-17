<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox } from '@ozwasyd/element-plus'
import { readerRegistrationAvailable, registerReaderPasskey } from '../../../Contracts/reader-registration'
import { t, type MessageKey } from '../siteLocale'

const checking = ref(true)
const available = ref(false)
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

onMounted(() => { void checkAvailability() })
</script>

<template>
  <div class="auth-heading">
    <h1>{{ t('page.register') }}</h1>
    <p>{{ t('readerRegistration.subtitle') }}</p>
  </div>
  <div v-if="registered" class="auth-form" role="status">
    <ElAlert :title="t('readerRegistration.created')" type="success" :closable="false" show-icon />
    <RouterLink to="/login">{{ t('readerRegistration.login') }}</RouterLink>
  </div>
  <div v-else-if="checking" class="auth-form" role="status">{{ t('readerRegistration.checking') }}</div>
  <div v-else-if="!available" class="auth-form">
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <p v-else role="status">{{ t('readerRegistration.unavailable') }}</p>
    <ElButton native-type="button" @click="checkAvailability">{{ t('readerRegistration.checkAgain') }}</ElButton>
  </div>
  <form v-else class="auth-form" @submit.prevent="register">
    <p>{{ t('readerRegistration.readerOnly') }}</p>
    <p>
      <RouterLink to="/guidelines" target="_blank" rel="noopener noreferrer">{{ t('readerRegistration.guidelines') }}</RouterLink>
    </p>
    <ElCheckbox :model-value="agreed" :disabled="busy" @update:model-value="agreed = $event === true">
      {{ t('readerRegistration.consent') }}
    </ElCheckbox>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <ElButton native-type="submit" type="primary" size="large" :loading="busy" :disabled="!agreed || busy">
      {{ t('readerRegistration.create') }}
    </ElButton>
  </form>
  <div v-if="!registered" class="auth-footer">
    <RouterLink to="/login">{{ t('readerRegistration.existingAccount') }}</RouterLink>
  </div>
</template>
