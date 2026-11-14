<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { listSiteSessions, revokeSiteSessions, type SessionList } from '../../../Contracts/site-sessions'
import { ApiError } from '../../../Contracts/client'
import { currentSession, identityEpoch } from '../session'

const list = shallowRef<SessionList | null>(null)
const error = ref('')
const busy = ref(false)
let operation: AbortController | undefined

onUnmounted(() => operation?.abort())
watch(identityEpoch, () => {
  operation?.abort()
  operation = undefined
  list.value = null
  error.value = ''
  busy.value = false
  void load()
}, { immediate: true, flush: 'sync' })

function load() {
  return run(async (id, signal) => listSiteSessions(id, signal))
}

async function revoke(target?: string) {
  if (!list.value) return
  await run(async (id, signal) => {
    await revokeSiteSessions(id, target, signal)
    return listSiteSessions(id, signal)
  })
}

async function run(action: (id: string, signal: AbortSignal) => Promise<SessionList>) {
  const id = currentSession.value?.siteSessionId
  if (!id || busy.value) return
  const epoch = identityEpoch.value
  const request = new AbortController()
  operation = request
  busy.value = true
  error.value = ''
  const isCurrent = () => !request.signal.aborted && epoch === identityEpoch.value
  try {
    const result = await action(id, request.signal)
    if (isCurrent()) list.value = result
  } catch (failure) {
    if (!isCurrent()) return
    list.value = null
    error.value = failure instanceof ApiError && (failure.status === 409 || failure.status === 401)
      ? 'The current browser session changed. Reload this page.'
      : 'Could not update active sessions. Reload the list to try again.'
  } finally {
    if (operation === request) {
      operation = undefined
      busy.value = false
    }
  }
}
</script>

<template>
  <section v-if="currentSession?.siteSessionId" class="auth-form site-sessions" aria-labelledby="active-sessions-heading">
    <h2 id="active-sessions-heading">Active sessions</h2>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <p v-if="list?.hasMore">Showing your current session and up to 100 other sessions.</p>
    <ul v-if="list" class="session-list">
      <li v-for="item in list.sessions" :key="item.id">
        <div class="session-label"><strong>{{ item.current ? 'This browser' : 'Other session' }}</strong> <code>{{ item.id.slice(0, 10) }}</code></div>
        <span>{{ item.method === 'ticket' ? 'Access key' : item.mfa ? 'Passkey and authenticator verification' : 'Passkey' }}</span>
        <time :datetime="new Date(item.expiresAt).toISOString()">Expires {{ new Date(item.expiresAt).toLocaleString() }}</time>
        <ElButton v-if="!item.current" native-type="button" :disabled="busy" @click="revoke(item.id)">Revoke session</ElButton>
      </li>
    </ul>
    <div class="session-actions">
      <ElButton class="session-action" native-type="button" :loading="busy" @click="load">Reload list</ElButton>
      <ElButton v-if="list && list.sessions.length > 1" class="session-action" native-type="button" :disabled="busy" @click="revoke()">Revoke other sessions</ElButton>
    </div>
  </section>
</template>

<style scoped>
.session-list { display: grid; gap: 1em; margin: 0; padding-inline-start: 1em; }
.session-list li > * { display: block; margin-block-end: 0.3em; }
.site-sessions { margin-block-start: 1.5em; }
.session-label code { margin-inline-start: 0.4em; }
.session-actions { display: flex; flex-wrap: wrap; gap: 0.5em; }
.session-actions .session-action { margin-inline-start: 0; }
</style>
