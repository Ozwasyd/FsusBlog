<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert,
  ElButton,
  ElInlineActions,
  ElInput,
  ElMetadataItem,
  ElMetadataRow,
  ElResourceList,
  ElResourceListItem,
  ElRiskNotice,
  ElSettingsSection,
  ElTag,
} from '@ozwasyd/element-plus'
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
watch([identityEpoch, sessionId], ([nextEpoch, nextSessionId], [prevEpoch]) => {
  if (!nextSessionId || nextEpoch !== prevEpoch) {
    clear()
    void load()
    return
  }
  request?.abort()
  request = undefined
  busy.value = false
  adding.value = false
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
  <ElSettingsSection
    v-if="passkeys || failed"
    class="site-passkeys"
    ariaLabelledby="site-passkeys-heading"
    density="compact"
  >
    <template #title>
      <span id="site-passkeys-heading">{{ t('account.message25') }}</span>
    </template>
    <template #actions>
      <ElButton
        v-if="canAddPasskey"
        native-type="button"
        type="primary"
        :loading="adding"
        :disabled="busy || !!edit"
        @click="addPasskey"
      >{{ t('account.message26') }}</ElButton>
    </template>

    <p v-if="notice" class="passkey-notice" role="status">{{ notice }}</p>

    <template v-if="failed">
      <ElAlert :title="failed" type="error" :closable="false" show-icon />
      <ElInlineActions class="passkey-inline-start" density="compact">
        <ElButton native-type="button" :loading="busy" @click="load">{{ t('account.message27') }}</ElButton>
      </ElInlineActions>
    </template>

    <ElResourceList v-else density="compact">
      <ElResourceListItem
        v-for="(item, index) in passkeys"
        :key="item.reference ?? index"
        :title="item.name || (item.current ? t('account.message28') : t('account.message29'))"
        density="compact"
      >
        <template v-if="item.name && item.current" #badge>
          <ElTag size="small" type="success">{{ t('account.message28') }}</ElTag>
        </template>

        <template v-if="item.reference && edit?.reference !== item.reference" #actions>
          <ElInlineActions density="compact">
            <ElButton native-type="button" text :disabled="busy || !!edit" @click="openEdit(item, 'rename')">
              {{ t('account.message42') }}
            </ElButton>
            <ElButton
              v-if="passkeys && passkeys.length > 1"
              native-type="button"
              text
              type="danger"
              :disabled="busy || !!edit"
              @click="openEdit(item, 'remove')"
            >{{ item.current ? t('account.message43') : t('account.message44') }}</ElButton>
          </ElInlineActions>
        </template>

        <ElMetadataRow density="compact">
          <ElMetadataItem :label="t('account.message30')">
            <time :datetime="item.createdAt.toISOString()">{{ item.createdAt.toLocaleString() }}</time>
          </ElMetadataItem>
          <ElMetadataItem :label="t('account.message31')">
            <time v-if="item.lastUsedAt" :datetime="item.lastUsedAt.toISOString()">{{ item.lastUsedAt.toLocaleString() }}</time>
            <span v-else>{{ t('account.message32') }}</span>
          </ElMetadataItem>
          <ElMetadataItem
            :label="t('account.message33')"
            :value="item.backupEligible ? t('account.message35') : t('account.message36')"
          />
          <ElMetadataItem
            :label="t('account.message34')"
            :value="item.backedUp ? t('account.message35') : t('account.message36')"
          />
        </ElMetadataRow>

        <form
          v-if="edit?.action === 'rename' && edit.reference === item.reference"
          class="passkey-inline-form"
          @submit.prevent="saveName"
        >
          <div class="passkey-field">
            <label for="site-passkey-name">{{ t('account.message37') }}</label>
            <ElInput
              id="site-passkey-name"
              v-model="name"
              v-bind="{ maxlength: WireLimits.SitePasskeyNameChars }"
              autocomplete="off"
              autofocus
              :disabled="busy"
            />
          </div>
          <ElInlineActions class="passkey-inline-start" density="compact">
            <ElButton native-type="submit" type="primary" :loading="busy" :disabled="busy || !name.trim()">
              {{ t('account.message38') }}
            </ElButton>
            <ElButton native-type="button" :disabled="busy" @click="closeEdit">{{ t('account.message39') }}</ElButton>
          </ElInlineActions>
        </form>

        <form
          v-else-if="edit?.action === 'remove' && edit.reference === item.reference"
          class="passkey-inline-form"
          aria-labelledby="site-passkey-remove-label"
          @submit.prevent="removePasskey"
        >
          <ElRiskNotice type="danger">
            <p id="site-passkey-remove-label" class="passkey-remove-title">
              {{ t('account.removePasskeyConfirm', { name: edit.label }) }}
            </p>
            <p v-if="edit.current" class="passkey-remove-copy">{{ t('account.message40') }}</p>
          </ElRiskNotice>
          <ElInlineActions class="passkey-inline-start" density="compact">
            <ElButton native-type="submit" type="danger" :loading="busy" :disabled="busy">
              {{ t('account.message41') }}
            </ElButton>
            <ElButton native-type="button" autofocus :disabled="busy" @click="closeEdit">{{ t('account.message39') }}</ElButton>
          </ElInlineActions>
        </form>
      </ElResourceListItem>
    </ElResourceList>
  </ElSettingsSection>
</template>

<style scoped>
.site-passkeys {
  min-width: 0;
}

.passkey-notice {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.passkey-inline-form {
  display: grid;
  gap: 10px;
  margin-block-start: 10px;
  padding-block-start: 10px;
  border-block-start: 1px solid var(--el-border-color-lighter);
  max-inline-size: 26rem;
}

.passkey-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
}

.passkey-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.passkey-remove-title {
  margin: 0;
  font-weight: 700;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}

.passkey-remove-copy {
  margin: 4px 0 0;
}

.passkey-inline-start {
  justify-content: flex-start;
}
</style>
