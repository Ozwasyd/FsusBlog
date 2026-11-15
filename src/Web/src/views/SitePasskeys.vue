<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { sitePasskeys, type SitePasskey } from '../../../Contracts/site-passkeys'
import { currentSession, identityEpoch } from '../session'
import { readSiteAuthority } from '../site-refresh-coordination'

const passkeys = shallowRef<readonly SitePasskey[]>()
const failed = ref(false)
const busy = ref(false)
const sessionId = computed(() => currentSession.value?.siteSessionId)
let request: AbortController | undefined
let active = false

function clear() {
  request?.abort()
  request = undefined
  passkeys.value = undefined
  failed.value = false
  busy.value = false
}

function pause() {
  active = false
  clear()
}

function resume() {
  active = true
  void load()
}

function restore(event: PageTransitionEvent) {
  if (event.persisted) resume()
}

onMounted(() => {
  window.addEventListener('pagehide', pause)
  window.addEventListener('pageshow', restore)
  resume()
})
onUnmounted(() => {
  window.removeEventListener('pagehide', pause)
  window.removeEventListener('pageshow', restore)
  pause()
})
watch([identityEpoch, sessionId], () => {
  clear()
  void load()
}, { flush: 'sync' })

async function load() {
  const expected = currentSession.value
  if (!active || !expected?.siteSessionId || request) return
  const id = expected.siteSessionId
  const epoch = identityEpoch.value
  const operation = new AbortController()
  request = operation
  busy.value = true
  const live = () => request === operation && !operation.signal.aborted &&
    epoch === identityEpoch.value && sessionId.value === id
  try {
    const entries = await sitePasskeys(id, operation.signal)
    if (!live()) return
    const observed = await readSiteAuthority(operation.signal)
    if (!live()) return
    failed.value = false
    passkeys.value = observed?.siteSessionId === id && observed.generation === expected.generation ? entries : undefined
  } catch (error) {
    if (!live()) return
    passkeys.value = undefined
    failed.value = !(error instanceof ApiError && (error.status === 401 || error.status === 404 || error.status === 409))
  } finally {
    if (request === operation) {
      request = undefined
      busy.value = false
    }
  }
}
</script>

<template>
  <section v-if="passkeys || failed" class="auth-form site-passkeys" aria-labelledby="site-passkeys-heading">
    <h2 id="site-passkeys-heading">Passkeys</h2>
    <template v-if="failed">
      <ElAlert title="Could not load Passkeys." type="error" :closable="false" show-icon />
      <ElButton native-type="button" :loading="busy" @click="load">Reload Passkeys</ElButton>
    </template>
    <ul v-else class="passkey-list">
      <li v-for="(item, index) in passkeys" :key="index">
        <strong>{{ item.current ? 'Current session passkey' : 'Passkey' }}</strong>
        <dl class="passkey-metadata">
          <dt>Created</dt><dd><time :datetime="item.createdAt.toISOString()">{{ item.createdAt.toLocaleString() }}</time></dd>
          <dt>Last used</dt><dd>
            <time v-if="item.lastUsedAt" :datetime="item.lastUsedAt.toISOString()">{{ item.lastUsedAt.toLocaleString() }}</time>
            <span v-else>Not used yet</span>
          </dd>
          <dt>Backup eligible</dt><dd>{{ item.backupEligible ? 'Yes' : 'No' }}</dd>
          <dt>Backed up</dt><dd>{{ item.backedUp ? 'Yes' : 'No' }}</dd>
        </dl>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.site-passkeys { margin-block-start: 1.5rem; }
.passkey-list { display: grid; gap: 1rem; margin: 0; padding-inline-start: 1rem; }
.passkey-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 0.75rem; margin-block: 0.5rem 0; }
.passkey-metadata dd { margin: 0; overflow-wrap: anywhere; }
</style>
