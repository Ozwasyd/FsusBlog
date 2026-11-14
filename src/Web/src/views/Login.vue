<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElThemeModeToggle } from '@ozwasyd/element-plus'
import type { ThemeMode } from '@ozwasyd/element-plus/theme'
import { WireLimits } from '../../../Contracts/wire.generated'
import { ApiError } from '../../../Contracts/client'
import { currentSession, signIn } from '../session'

const props = defineProps<{ themeMode?: ThemeMode }>()
const emit = defineEmits<{ theme: [mode: ThemeMode] }>()
const ticket = ref('')
const validTicket = computed(() => /^[A-Za-z0-9_-]+$/.test(ticket.value.trim()) && ticket.value.trim().length <= WireLimits.TicketBytes)
const busy = ref(false)
const failure = ref('')
const canContinue = computed(() => currentSession.value?.canAuthor)
const router = useRouter()
const lifetime = new AbortController()
onUnmounted(() => lifetime.abort())

async function submit() {
  if (busy.value || !validTicket.value) return
  busy.value = true
  failure.value = ''
  try {
    await signIn(ticket.value.trim(), lifetime.signal)
    if (!lifetime.signal.aborted && currentSession.value) {
      await router.replace({ name: 'write' })
    }
  } catch (error) {
    if (!lifetime.signal.aborted) {
      failure.value = error instanceof ApiError && error.status === 401
        ? 'This owner access key was not accepted.'
        : 'Could not log in. Try again.'
    }
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}
</script>

<template>
  <main class="auth-page">
    <div class="auth-heading">
      <div>
        <h1>Log in</h1>
        <p>Write and publish articles.</p>
      </div>
      <ElThemeModeToggle :model-value="props.themeMode" variant="menu-button" @update:model-value="emit('theme', $event)" />
    </div>
    <p v-if="canContinue"><RouterLink :to="{ name: 'write' }">Continue to writing</RouterLink></p>
    <form v-else class="auth-form" @submit.prevent="submit">
      <label for="owner-key">Owner access key</label>
      <ElInput
        id="owner-key"
        v-model="ticket"
        type="password"
        autocomplete="current-password"
        size="large"
        :disabled="busy"
      />
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
      <ElButton native-type="submit" size="large" type="primary" :loading="busy" :disabled="!validTicket">
        Log in
      </ElButton>
    </form>
    <div class="auth-footer"><RouterLink to="/">Cancel</RouterLink></div>
  </main>
</template>
