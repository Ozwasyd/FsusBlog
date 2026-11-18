<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElCopyableDetail, ElEmptyState, ElFormSection, ElInlineActions,
  ElKeyValueGrid, ElKeyValueItem, ElOption,
  ElResourceList, ElResourceListItem, ElSelect, ElSettingsSection,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { applyAppearance, readAdminAppearance, readAppearanceCatalog, readAppearanceFontDetail, readAppearanceHistory } from '../../../Contracts/admin-appearance'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const lifetime = new AbortController()
const signal = () => AbortSignal.any([lifetime.signal, props.sessionSignal])
const state = shallowRef<Awaited<ReturnType<typeof readAdminAppearance>>>()
const catalog = shallowRef<Awaited<ReturnType<typeof readAppearanceCatalog>>>()
const history = shallowRef<Awaited<ReturnType<typeof readAppearanceHistory>>>()
const historyBefore = shallowRef<bigint>()
const historyHeading = ref<HTMLElement>()
const fontDetail = shallowRef<Awaited<ReturnType<typeof readAppearanceFontDetail>>>()
const fontDetailHeading = ref<HTMLElement>()
const theme = ref('')
const font = ref('')
const busy = ref(false)
const notice = ref<MessageKey | ''>('')
const error = ref<MessageKey | ''>('')
const selectedFont = computed(() => catalog.value?.find(item => item.font && item.archive === font.value))
const canApply = computed(() => state.value && (theme.value !== state.value.theme || font.value !== state.value.font) &&
  (!theme.value || catalog.value?.some(item => !item.font && item.archive === theme.value)) &&
  (!font.value || selectedFont.value))

async function read(request: AbortSignal) {
  const [next, packages] = await Promise.all([readAdminAppearance(request), readAppearanceCatalog(request)])
  if (request.aborted) return
  state.value = next
  catalog.value = packages
  fontDetail.value = undefined
  history.value = undefined
  historyBefore.value = undefined
  theme.value = next.theme
  font.value = next.font
}

function readFontDetail(archive: string) {
  return run(async request => {
    fontDetail.value = undefined
    const detail = await readAppearanceFontDetail(archive, request)
    if (request.aborted || selectedFont.value?.archive !== archive) return
    fontDetail.value = detail
    await nextTick()
    if (!request.aborted) fontDetailHeading.value?.focus()
  }, 'admin.fontDetailsForbidden', 'admin.fontPackageUnavailable')
}

function readHistory(before?: bigint) {
  return run(async request => {
    const next = await readAppearanceHistory(before, request)
    if (request.aborted) return
    history.value = next
    historyBefore.value = before
    await nextTick()
    if (!request.aborted) historyHeading.value?.focus()
  }, 'admin.appearanceHistoryForbidden')
}

function historyTime(unixMs: bigint) {
  return new Date(Number(unixMs)).toISOString()
}

function name(digest: string) {
  return digest.length ? catalog.value?.find(item => item.archive === digest)?.id ?? t('admin.unavailablePackage') : t('admin.builtIn')
}

async function run(action: (request: AbortSignal) => Promise<void>,
  forbidden: MessageKey = 'admin.appearanceForbidden',
  unavailable: MessageKey = 'admin.appearanceUnavailable') {
  if (busy.value || props.sessionSignal.aborted) return
  const request = signal()
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action(request)
  } catch (cause) {
    if (request.aborted) return
    if (cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')) {
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 404) {
      error.value = unavailable
    } else if (cause instanceof ApiError && cause.status === 403) {
      error.value = forbidden
    } else if (cause instanceof ApiError && cause.status === 409) {
      state.value = undefined
      error.value = 'admin.appearanceChanged'
    } else {
      error.value = 'admin.appearanceRequestFailed'
    }
  } finally {
    busy.value = false
  }
}

function apply(rollback: boolean) {
  const current = state.value
  if (!current || (rollback ? !current.canRollback : !canApply.value)) return
  return run(async request => {
    await applyAppearance({ expectedRevision: current.revision, currentTheme: current.theme, currentFont: current.font,
      theme: rollback ? current.previousTheme : theme.value, font: rollback ? current.previousFont : font.value, rollback }, request)
    await read(request)
    if (!request.aborted) notice.value = rollback ? 'admin.appearanceRestored' : 'admin.appearanceApplied'
  })
}

watch(font, () => { fontDetail.value = undefined }, { flush: 'sync' })
function clear() {
  state.value = undefined
  catalog.value = undefined
  history.value = undefined
  historyBefore.value = undefined
  fontDetail.value = undefined
  theme.value = ''
  font.value = ''
  notice.value = ''
  error.value = ''
}
watchAdminSessionClear(() => props.sessionSignal, clear, () => lifetime.abort())
</script>

<template>
  <ElSettingsSection ariaLabelledby="admin-appearance" density="compact">
    <template #title>
      <span id="admin-appearance">{{ t('admin.siteAppearance') }}</span>
    </template>
    <template #actions>
      <ElButton :loading="busy" native-type="button" @click="run(read)">{{ t('admin.checkAppearance') }}</ElButton>
    </template>

    <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" />
    <p v-if="notice" class="appearance-status" role="status">{{ t(notice) }}</p>

    <template v-if="state && catalog">
      <div class="appearance-summary">
        <p class="appearance-active">{{ t('admin.activeAppearance', { theme: name(state.theme), font: name(state.font) }) }}</p>
        <ElAlert v-if="!state.serving" :title="t('admin.appearanceFallback')" type="warning" :closable="false" />
      </div>

      <ElFormSection density="compact">
        <div class="appearance-fields">
          <div class="appearance-field">
            <label for="admin-appearance-theme">{{ t('admin.theme') }}</label>
            <ElSelect id="admin-appearance-theme" v-model="theme" :ariaLabel="t('admin.theme')" :disabled="busy">
              <ElOption v-if="state.theme && !catalog.some(item => item.archive === state?.theme)" :value="state.theme" :label="t('admin.unavailablePackage')" disabled />
              <ElOption value="" :label="t('admin.builtIn')" />
              <ElOption v-for="item in catalog.filter(item => !item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
            </ElSelect>
          </div>
          <div class="appearance-field">
            <label for="admin-appearance-font">{{ t('admin.font') }}</label>
            <ElSelect id="admin-appearance-font" v-model="font" :ariaLabel="t('admin.font')" :disabled="busy">
              <ElOption v-if="state.font && !catalog.some(item => item.archive === state?.font)" :value="state.font" :label="t('admin.unavailablePackage')" disabled />
              <ElOption value="" :label="t('admin.builtIn')" />
              <ElOption v-for="item in catalog.filter(item => item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
            </ElSelect>
          </div>
        </div>
        <ElInlineActions>
          <ElButton type="primary" :disabled="busy || !canApply" native-type="button" @click="apply(false)">{{ t('admin.applyAppearance') }}</ElButton>
          <ElButton v-if="state.canRollback" :disabled="busy" native-type="button" @click="apply(true)">
            {{ t('admin.restoreAppearance', { theme: name(state.previousTheme), font: name(state.previousFont) }) }}
          </ElButton>
          <ElButton v-if="selectedFont" :disabled="busy" native-type="button" @click="readFontDetail(selectedFont.archive)">
            {{ t('admin.fontDetails') }}
          </ElButton>
          <ElButton :disabled="busy" native-type="button" @click="readHistory()">
            {{ historyBefore === undefined ? t('admin.checkAppearanceHistory') : t('admin.latestAppearance') }}
          </ElButton>
        </ElInlineActions>
      </ElFormSection>

      <ElSettingsSection v-if="fontDetail" class="font-details" title-tag="h3" ariaLabelledby="admin-font-details" density="compact">
        <template #title>
          <span id="admin-font-details" ref="fontDetailHeading" tabindex="-1">{{ t('admin.fontDetails') }}</span>
        </template>
        <template #description>{{ fontDetail.name || fontDetail.id }} {{ fontDetail.version }}</template>
        <ElKeyValueGrid density="compact">
          <ElKeyValueItem v-if="fontDetail.family" :label="t('admin.fontFamily')" :value="fontDetail.family" />
          <ElKeyValueItem :label="t('admin.archiveSha')" monospace>
            <ElCopyableDetail :value="fontDetail.archiveDigest" />
          </ElKeyValueItem>
          <ElKeyValueItem
            :label="t('admin.fontFace')"
            :value="t('admin.fontFaceDescription', { weight: fontDetail.faceWeight, style: fontDetail.faceStyle, bytes: fontDetail.faceBytes })"
          />
          <ElKeyValueItem :label="t('admin.faceSha')" monospace>
            <ElCopyableDetail :value="fontDetail.faceDigest" />
          </ElKeyValueItem>
          <ElKeyValueItem v-if="fontDetail.unicodeRange" :label="t('admin.unicodeRange')" monospace>
            <code>{{ fontDetail.unicodeRange }}</code>
          </ElKeyValueItem>
          <ElKeyValueItem
            v-if="fontDetail.sourceKind"
            :label="t('admin.source')"
            :value="`${fontDetail.sourcePackage} ${fontDetail.sourceVersion} · ${fontDetail.sourceUpstream} (${fontDetail.sourceKind})`"
          />
          <ElKeyValueItem :label="t('admin.license')" :value="fontDetail.licenseName" />
        </ElKeyValueGrid>
        <pre class="font-license-text">{{ fontDetail.licenseText }}</pre>
      </ElSettingsSection>

      <ElSettingsSection v-if="history" title-tag="h3" ariaLabelledby="admin-appearance-history" density="compact">
        <template #title>
          <span id="admin-appearance-history" ref="historyHeading" tabindex="-1">{{ t('admin.appearanceHistory') }}</span>
        </template>
        <ElEmptyState v-if="history.items.length === 0" size="inline" :title="t('admin.noAppearanceHistory')" />
        <ElResourceList v-else class="appearance-history" density="compact">
          <ElResourceListItem
            v-for="change in history.items"
            :key="String(change.revision)"
            :title="t('admin.appearanceRevision', { action: change.rollback ? t('admin.rolledBack') : t('admin.applied'), revision: String(change.revision) })"
          >
            <template #meta>
              <span>
                <time :datetime="historyTime(change.happenedUnixMs)">{{ historyTime(change.happenedUnixMs) }}</time>
                · {{ change.actor }}
              </span>
            </template>
            <ElKeyValueGrid density="compact">
              <ElKeyValueItem :label="t('admin.themeArchive')">
                <code>{{ change.previousTheme || t('admin.builtIn') }}</code> → <code>{{ change.theme || t('admin.builtIn') }}</code>
              </ElKeyValueItem>
              <ElKeyValueItem :label="t('admin.fontArchive')">
                <code>{{ change.previousFont || t('admin.builtIn') }}</code> → <code>{{ change.font || t('admin.builtIn') }}</code>
              </ElKeyValueItem>
            </ElKeyValueGrid>
          </ElResourceListItem>
        </ElResourceList>
        <div v-if="history.nextBefore" class="appearance-history-more">
          <ElButton :disabled="busy" native-type="button" @click="readHistory(history.nextBefore ?? undefined)">
            {{ t('admin.earlierAppearance') }}
          </ElButton>
        </div>
      </ElSettingsSection>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.appearance-status,
.appearance-active {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-regular);
}

.appearance-summary {
  display: grid;
  gap: 8px;
}

.appearance-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.appearance-field {
  display: grid;
  gap: 6px;
}

.appearance-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.font-license-text {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 16rem;
  overflow: auto;
}

.appearance-history-more {
  display: flex;
  justify-content: flex-start;
}
</style>
