<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { renameSitePasskey, sitePasskeyManagement } from '../../../Contracts/site-passkey-names'
import { sitePasskeys, type SitePasskey } from '../../../Contracts/site-passkeys'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'
import { readSiteAuthority } from '../site-refresh-coordination'

type PasskeyEntry = SitePasskey & { reference?: string; revision?: bigint; name?: string }
type RenameTarget = { reference: string; revision: bigint }
type Rename = RenameTarget & { name: string }

const passkeys = shallowRef<readonly PasskeyEntry[]>()
const edit = shallowRef<RenameTarget>()
const name = ref('')
const failed = ref('')
const saved = ref(false)
const busy = ref(false)
const sessionId = computed(() => currentSession.value?.siteSessionId)
let request: AbortController | undefined
let active = false

function clear() {
  request?.abort()
  request = undefined
  passkeys.value = undefined
  closeRename()
  failed.value = ''
  saved.value = false
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

function load() { return run() }

function openRename(item: PasskeyEntry) {
  if (busy.value || !item.reference || item.revision === undefined) return
  edit.value = { reference: item.reference, revision: item.revision }
  name.value = item.name ?? ''
  saved.value = false
}

function closeRename() {
  edit.value = undefined
  name.value = ''
}

function saveName() {
  if (!edit.value || !name.value.trim() || name.value.length > WireLimits.SitePasskeyNameChars) return
  return run({ ...edit.value, name: name.value })
}

async function readEntries(id: string, signal: AbortSignal) {
  try { return await sitePasskeyManagement(id, signal) }
  catch (error) {
    if (!signal.aborted && error instanceof ApiError && error.status === 404) return await sitePasskeys(id, signal)
    throw error
  }
}

async function run(rename?: Rename) {
  const expected = currentSession.value
  if (!active || !expected?.siteSessionId || request) return
  const id = expected.siteSessionId
  const generation = expected.generation
  const epoch = identityEpoch.value
  const operation = new AbortController()
  request = operation
  busy.value = true
  failed.value = ''
  saved.value = false
  const live = () => request === operation && !operation.signal.aborted &&
    epoch === identityEpoch.value && sessionId.value === id
  async function confirmAuthority() {
    if (!live()) return false
    const observed = await readSiteAuthority(operation.signal)
    if (!live()) return false
    if (observed?.siteSessionId === id && observed.generation === generation) return true
    clear()
    return false
  }
  try {
    if (rename) {
      if (!await confirmAuthority()) return
      await renameSitePasskey(rename.reference, rename.revision, rename.name, id, operation.signal)
      if (!live()) return
    }
    const entries = await (rename ? sitePasskeyManagement(id, operation.signal) : readEntries(id, operation.signal))
    if (!await confirmAuthority()) return
    passkeys.value = entries
    closeRename()
    saved.value = !!rename
  } catch (error) {
    if (!live()) return
    passkeys.value = undefined
    closeRename()
    const status = error instanceof ApiError ? error.status : undefined
    if (status !== 401 && (rename || (status !== 404 && status !== 409))) {
      failed.value = rename ? 'Could not confirm the new Passkey name. Reload Passkeys to check.' : 'Could not load Passkeys.'
    }
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
    <p v-if="saved" role="status">Passkey name saved.</p>
    <template v-if="failed">
      <ElAlert :title="failed" type="error" :closable="false" show-icon />
      <ElButton native-type="button" :loading="busy" @click="load">Reload Passkeys</ElButton>
    </template>
    <ul v-else class="passkey-list">
      <li v-for="(item, index) in passkeys" :key="item.reference ?? index">
        <strong class="passkey-name">{{ item.name || (item.current ? 'Current session passkey' : 'Passkey') }}</strong>
        <div v-if="item.name && item.current">Current session passkey</div>
        <dl class="passkey-metadata">
          <dt>Created</dt><dd><time :datetime="item.createdAt.toISOString()">{{ item.createdAt.toLocaleString() }}</time></dd>
          <dt>Last used</dt><dd>
            <time v-if="item.lastUsedAt" :datetime="item.lastUsedAt.toISOString()">{{ item.lastUsedAt.toLocaleString() }}</time>
            <span v-else>Not used yet</span>
          </dd>
          <dt>Backup eligible</dt><dd>{{ item.backupEligible ? 'Yes' : 'No' }}</dd>
          <dt>Backed up</dt><dd>{{ item.backedUp ? 'Yes' : 'No' }}</dd>
        </dl>
        <form v-if="item.reference && edit?.reference === item.reference" class="rename-passkey" @submit.prevent="saveName">
          <label for="site-passkey-name">Passkey name</label>
          <ElInput id="site-passkey-name" v-model="name" v-bind="{ maxlength: WireLimits.SitePasskeyNameChars }"
            autocomplete="off" autofocus :disabled="busy" />
          <div class="rename-actions">
            <ElButton native-type="submit" type="primary" :loading="busy" :disabled="busy || !name.trim()">Save with Passkey</ElButton>
            <ElButton native-type="button" :disabled="busy" @click="closeRename">Cancel</ElButton>
          </div>
        </form>
        <ElButton v-else-if="item.reference" native-type="button" :disabled="busy" @click="openRename(item)">Rename Passkey</ElButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.site-passkeys { margin-block-start: 1.5rem; }
.passkey-name { overflow-wrap: anywhere; }
.passkey-list { display: grid; gap: 1rem; margin: 0; padding-inline-start: 1rem; }
.passkey-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 0.75rem; margin-block: 0.5rem 0; }
.passkey-metadata dd { margin: 0; overflow-wrap: anywhere; }
.rename-passkey { display: grid; gap: 0.5rem; }
.rename-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.rename-actions > * { margin-inline-start: 0; }
</style>
