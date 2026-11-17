<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { enrollSitePasskey } from '../../../Contracts/passkey'
import { removeSitePasskey, renameSitePasskey, sitePasskeyManagement } from '../../../Contracts/site-passkey-names'
import { sitePasskeys, type SitePasskey } from '../../../Contracts/site-passkeys'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch, refreshSession } from '../session'
import { announceSiteAuthChange, readSiteAuthority, withSiteAuthMutation } from '../site-refresh-coordination'

type PasskeyEntry = SitePasskey & { reference?: string; revision?: bigint; name?: string }
type Target = { reference: string; revision: bigint }
type Remove = Target & { action: 'remove'; current: boolean }
type Edit = (Target & { action: 'rename' }) | (Remove & { label: string })
type Change = (Target & { action: 'rename'; name: string }) | Remove

const passkeys = shallowRef<readonly PasskeyEntry[]>()
const edit = shallowRef<Edit>()
const name = ref('')
const failed = ref('')
const notice = ref('')
const busy = ref(false)
const adding = ref(false)
const canAddPasskey = computed(() => {
  const entries = passkeys.value
  return !!entries?.[0]?.reference && entries.length < WireLimits.SitePasskeyListSize
})
const sessionId = computed(() => currentSession.value?.siteSessionId)
let request: AbortController | undefined
let active = false

function clear() {
  request?.abort()
  request = undefined
  passkeys.value = undefined
  closeEdit()
  failed.value = ''
  notice.value = ''
  busy.value = false
  adding.value = false
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

function addPasskey() {
  if (canAddPasskey.value && !edit.value) return run('enroll')
}

function openEdit(item: PasskeyEntry, action: Edit['action']) {
  if (busy.value || !item.reference || item.revision === undefined) return
  const target = { reference: item.reference, revision: item.revision }
  if (action === 'remove') {
    if ((passkeys.value?.length ?? 0) < 2) return
    edit.value = { ...target, action, current: item.current, label: item.name || t('account.passkeyCreated', { date: item.createdAt.toLocaleString() }) }
  } else {
    edit.value = { ...target, action }
    name.value = item.name ?? ''
  }
  notice.value = ''
}

function closeEdit() {
  edit.value = undefined
  name.value = ''
}

function saveName() {
  if (edit.value?.action !== 'rename' || !name.value.trim() || name.value.length > WireLimits.SitePasskeyNameChars) return
  return run({ ...edit.value, name: name.value })
}

function removePasskey() {
  if (edit.value?.action === 'remove') return run(edit.value)
}

async function readEntries(id: string, signal: AbortSignal) {
  try { return await sitePasskeyManagement(id, signal) }
  catch (error) {
    if (!signal.aborted && error instanceof ApiError && error.status === 404) return await sitePasskeys(id, signal)
    throw error
  }
}

async function run(change?: Change | 'enroll') {
  const expected = currentSession.value
  if (!active || !expected?.siteSessionId || request) return
  const id = expected.siteSessionId
  const generation = expected.generation
  const epoch = identityEpoch.value
  const operation = new AbortController()
  request = operation
  const enrolling = change === 'enroll'
  const removing = typeof change === 'object' && change.action === 'remove'
  busy.value = true
  adding.value = enrolling
  failed.value = ''
  notice.value = ''
  const live = () => request === operation && !operation.signal.aborted &&
    epoch === identityEpoch.value && sessionId.value === id && currentSession.value?.generation === generation
  async function confirmAuthority() {
    if (!live()) return false
    const observed = await readSiteAuthority(operation.signal)
    if (!live()) return false
    if (observed?.siteSessionId === id && observed.generation === generation) return true
    clear()
    return false
  }
  try {
    if (change) {
      if (!await confirmAuthority()) return
      try {
        if (enrolling) await enrollSitePasskey(id, operation.signal)
        else if (change.action === 'remove') {
          const remove = () => removeSitePasskey(change.reference, change.revision, id, operation.signal)
          if (change.current) {
            const removed = await withSiteAuthMutation(operation.signal, async () => {
              if (!await confirmAuthority()) return false
              await remove()
              return true
            })
            if (removed && live()) {
              announceSiteAuthChange()
              await refreshSession(operation.signal, false)
            }
            return
          }
          await remove()
        } else await renameSitePasskey(change.reference, change.revision, change.name, id, operation.signal)
      } catch (error) {
        if ((!enrolling && !removing) || !(error instanceof DOMException) ||
            (error.name !== 'NotAllowedError' && error.name !== 'AbortError')) throw error
        if (await confirmAuthority()) {
          closeEdit()
          notice.value = enrolling ? t('account.message45') : t('account.message46')
        }
        return
      }
      if (!live()) return
    }
    const entries = await (change ? sitePasskeyManagement(id, operation.signal) : readEntries(id, operation.signal))
    if (!await confirmAuthority()) return
    passkeys.value = entries
    closeEdit()
    if (change) notice.value = enrolling ? t('account.message47') : removing ? t('account.message48') : t('account.message49')
  } catch (error) {
    if (!live()) return
    passkeys.value = undefined
    closeEdit()
    const status = error instanceof ApiError ? error.status : undefined
    if (status !== 401 && (change || (status !== 404 && status !== 409))) {
      if (enrolling) failed.value = t('account.message50')
      else if (removing) failed.value = t('account.message51')
      else if (change) failed.value = t('account.message52')
      else failed.value = t('account.message53')
    }
  } finally {
    if (request === operation) {
      request = undefined
      busy.value = false
      adding.value = false
    }
  }
}
</script>

<template>
  <section v-if="passkeys || failed" class="auth-form site-passkeys" aria-labelledby="site-passkeys-heading">
    <h2 id="site-passkeys-heading">{{ t('account.message25') }}</h2>
    <p v-if="notice" role="status">{{ notice }}</p>
    <ElButton v-if="canAddPasskey" class="passkey-add" native-type="button" :loading="adding"
      :disabled="busy || !!edit" @click="addPasskey">{{ t('account.message26') }}</ElButton>
    <template v-if="failed">
      <ElAlert :title="failed" type="error" :closable="false" show-icon />
      <ElButton native-type="button" :loading="busy" @click="load">{{ t('account.message27') }}</ElButton>
    </template>
    <ul v-else class="passkey-list">
      <li v-for="(item, index) in passkeys" :key="item.reference ?? index">
        <strong class="passkey-name">{{ item.name || (item.current ? t('account.message28') : t('account.message29')) }}</strong>
        <div v-if="item.name && item.current">{{ t('account.message28') }}</div>
        <dl class="passkey-metadata">
          <dt>{{ t('account.message30') }}</dt><dd><time :datetime="item.createdAt.toISOString()">{{ item.createdAt.toLocaleString() }}</time></dd>
          <dt>{{ t('account.message31') }}</dt><dd>
            <time v-if="item.lastUsedAt" :datetime="item.lastUsedAt.toISOString()">{{ item.lastUsedAt.toLocaleString() }}</time>
            <span v-else>{{ t('account.message32') }}</span>
          </dd>
          <dt>{{ t('account.message33') }}</dt><dd>{{ item.backupEligible ? t('account.message35') : t('account.message36') }}</dd>
          <dt>{{ t('account.message34') }}</dt><dd>{{ item.backedUp ? t('account.message35') : t('account.message36') }}</dd>
        </dl>
        <form v-if="edit?.action === 'rename' && edit.reference === item.reference" class="rename-passkey" @submit.prevent="saveName">
          <label for="site-passkey-name">{{ t('account.message37') }}</label>
          <ElInput id="site-passkey-name" v-model="name" v-bind="{ maxlength: WireLimits.SitePasskeyNameChars }"
            autocomplete="off" autofocus :disabled="busy" />
          <div class="rename-actions">
            <ElButton native-type="submit" type="primary" :loading="busy" :disabled="busy || !name.trim()">{{ t('account.message38') }}</ElButton>
            <ElButton native-type="button" :disabled="busy" @click="closeEdit">{{ t('account.message39') }}</ElButton>
          </div>
        </form>
        <form v-else-if="edit?.action === 'remove' && edit.reference === item.reference" class="rename-passkey"
          aria-labelledby="site-passkey-remove-label" @submit.prevent="removePasskey">
          <p id="site-passkey-remove-label" class="passkey-name">{{ t('account.removePasskeyConfirm', { name: edit.label }) }}</p>
          <p v-if="edit.current">{{ t('account.message40') }}</p>
          <div class="rename-actions">
            <ElButton native-type="submit" type="danger" :loading="busy" :disabled="busy">{{ t('account.message41') }}</ElButton>
            <ElButton native-type="button" autofocus :disabled="busy" @click="closeEdit">{{ t('account.message39') }}</ElButton>
          </div>
        </form>
        <div v-else-if="item.reference" class="rename-actions">
          <ElButton native-type="button" :disabled="busy || !!edit" @click="openEdit(item, 'rename')">{{ t('account.message42') }}</ElButton>
          <ElButton v-if="passkeys && passkeys.length > 1" native-type="button"
            :disabled="busy || !!edit" @click="openEdit(item, 'remove')">
            {{ item.current ? t('account.message43') : t('account.message44') }}
          </ElButton>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.site-passkeys { margin-block-start: 1.5rem; }
.passkey-name { overflow-wrap: anywhere; }
.passkey-add { margin-block-end: 1rem; }
.passkey-list { display: grid; gap: 1rem; margin: 0; padding-inline-start: 1rem; }
.passkey-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 0.75rem; margin-block: 0.5rem 0; }
.passkey-metadata dd { margin: 0; overflow-wrap: anywhere; }
.rename-passkey { display: grid; gap: 0.5rem; }
.rename-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.rename-actions > * { margin-inline-start: 0; }
</style>
