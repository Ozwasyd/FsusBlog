<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElAlert, ElButton, ElInput, ElSettingsSection, ElSkeleton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { readSiteDisplayName, updateSiteDisplayName, validSiteDisplayName } from '../../../Contracts/site-display-name'
import { WireLimits } from '../../../Contracts/wire.generated'
import { useDelayedBusy } from '../delayedBusy'
import { currentSession, identityEpoch } from '../session'
import { t, type MessageKey } from '../siteLocale'

const savedName = ref<string | null>(null)
const draft = ref('')
const loading = ref(false)
const saving = ref(false)
const touched = ref(false)
const failure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
let operation: AbortController | undefined

const showSkeleton = useDelayedBusy(() => loading.value && savedName.value === null)
const trimmed = computed(() => draft.value.trim())
const isValid = computed(() => validSiteDisplayName(trimmed.value))
const showValidation = computed(() => touched.value && trimmed.value.length > 0 && !isValid.value)
const isDirty = computed(() => savedName.value !== null && trimmed.value !== savedName.value)
const canSave = computed(() => !loading.value && !saving.value && isDirty.value && isValid.value)

function reset() {
  operation?.abort()
  operation = undefined
  savedName.value = null
  draft.value = ''
  loading.value = false
  saving.value = false
  touched.value = false
  failure.value = ''
  notice.value = ''
}

async function load() {
  const id = currentSession.value?.siteSessionId
  if (!id) return
  operation?.abort()
  const epoch = identityEpoch.value
  const request = new AbortController()
  operation = request
  loading.value = true
  failure.value = ''
  const isCurrent = () => !request.signal.aborted && epoch === identityEpoch.value
  try {
    const name = await readSiteDisplayName(id, request.signal)
    if (!isCurrent()) return
    savedName.value = name
    draft.value = name
  } catch (error) {
    if (!isCurrent()) return
    failure.value = error instanceof ApiError && (error.status === 401 || error.status === 409)
      ? 'account.displayNameSessionChanged'
      : 'account.displayNameLoadFailed'
  } finally {
    if (operation === request) {
      operation = undefined
      loading.value = false
    }
  }
}

async function save() {
  const id = currentSession.value?.siteSessionId
  if (!id || !canSave.value) return
  touched.value = true
  const epoch = identityEpoch.value
  const request = new AbortController()
  operation = request
  saving.value = true
  failure.value = ''
  notice.value = ''
  const isCurrent = () => !request.signal.aborted && epoch === identityEpoch.value
  try {
    const updated = await updateSiteDisplayName(id, trimmed.value, request.signal)
    if (!isCurrent()) return
    savedName.value = updated
    draft.value = updated
    touched.value = false
    notice.value = 'account.displayNameSaved'
  } catch (error) {
    if (!isCurrent()) return
    if (error instanceof ApiError && (error.status === 401 || error.status === 409))
      failure.value = 'account.displayNameSessionChanged'
    else if (error instanceof ApiError && error.status === 400)
      failure.value = 'account.displayNameInvalid'
    else
      failure.value = 'account.displayNameSaveFailed'
  } finally {
    if (operation === request) {
      operation = undefined
      saving.value = false
    }
  }
}

onUnmounted(() => operation?.abort())
watch(identityEpoch, () => {
  reset()
  void load()
}, { immediate: true, flush: 'sync' })
</script>

<template>
  <ElSettingsSection
    v-if="currentSession?.siteSessionId"
    class="site-display-name"
    ariaLabelledby="site-display-name-heading"
    :description="t('account.displayNameSummary')"
    density="compact"
  >
    <template #title>
      <span id="site-display-name-heading">{{ t('account.displayNameTitle') }}</span>
    </template>

    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" show-icon />
    <p v-if="notice" class="display-name-notice" role="status">{{ t(notice) }}</p>

    <ElSkeleton v-if="showSkeleton" :rows="1" animated />

    <form v-else-if="savedName !== null" class="display-name-form" @submit.prevent="save">
      <div class="display-name-field">
        <label for="site-display-name-input">{{ t('account.displayNameLabel') }}</label>
        <div class="display-name-row">
          <ElInput
            id="site-display-name-input"
            v-model="draft"
            :placeholder="t('account.displayNamePlaceholder')"
            :disabled="saving"
            v-bind="{
              maxlength: WireLimits.SiteDisplayNameChars,
              autocomplete: 'nickname',
              'aria-describedby': 'site-display-name-hint',
              'aria-invalid': showValidation ? 'true' : undefined,
            }"
            @input="notice = ''; failure = ''"
            @blur="touched = true"
          />
          <ElButton
            native-type="submit"
            type="primary"
            :loading="saving"
            :disabled="!canSave"
          >{{ t('account.displayNameSave') }}</ElButton>
        </div>
        <p id="site-display-name-hint" :class="showValidation ? 'display-name-validation' : 'display-name-hint'">
          {{ t(showValidation ? 'account.displayNameInvalid' : 'account.displayNameHint') }}
        </p>
      </div>
    </form>
  </ElSettingsSection>
</template>

<style scoped>
.site-display-name {
  min-width: 0;
}
.display-name-notice {
  margin: 0;
  color: var(--el-color-success);
  font-size: var(--el-font-size-small);
}
.display-name-form {
  display: grid;
  gap: var(--fsus-space-3);
  max-inline-size: 32rem;
}
.display-name-field {
  display: grid;
  gap: 6px;
}
.display-name-field label {
  color: var(--el-text-color-regular);
  font-size: var(--el-font-size-small);
  font-weight: 500;
}
.display-name-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--fsus-space-2);
}
.display-name-hint,
.display-name-validation {
  margin: 0;
  font-size: var(--el-font-size-small);
  line-height: 1.5;
}
.display-name-hint {
  color: var(--el-text-color-secondary);
}
.display-name-validation {
  color: var(--el-color-danger);
}
@media (max-width: 30rem) {
  .display-name-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
