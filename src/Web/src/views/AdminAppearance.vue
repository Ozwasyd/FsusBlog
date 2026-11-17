<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCard, ElOption, ElSelect } from '@ozwasyd/element-plus'
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
  <section class="auth-form" aria-labelledby="admin-appearance">
    <h2 id="admin-appearance">{{ t('admin.siteAppearance') }}</h2>
    <ElButton :loading="busy" native-type="button" @click="run(read)">{{ t('admin.checkAppearance') }}</ElButton>
    <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" />
    <p v-if="notice" role="status">{{ t(notice) }}</p>
    <template v-if="state && catalog">
      <p>{{ t('admin.activeAppearance', { theme: name(state.theme), font: name(state.font) }) }}</p>
      <p v-if="!state.serving" role="status">{{ t('admin.appearanceFallback') }}</p>
      <label for="admin-appearance-theme">{{ t('admin.theme') }}</label>
      <ElSelect id="admin-appearance-theme" v-model="theme" :ariaLabel="t('admin.theme')" :disabled="busy">
        <ElOption v-if="state.theme && !catalog.some(item => item.archive === state?.theme)" :value="state.theme" :label="t('admin.unavailablePackage')" disabled />
        <ElOption value="" :label="t('admin.builtIn')" />
        <ElOption v-for="item in catalog.filter(item => !item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
      </ElSelect>
      <label for="admin-appearance-font">{{ t('admin.font') }}</label>
      <ElSelect id="admin-appearance-font" v-model="font" :ariaLabel="t('admin.font')" :disabled="busy">
        <ElOption v-if="state.font && !catalog.some(item => item.archive === state?.font)" :value="state.font" :label="t('admin.unavailablePackage')" disabled />
        <ElOption value="" :label="t('admin.builtIn')" />
        <ElOption v-for="item in catalog.filter(item => item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
      </ElSelect>
      <ElButton v-if="selectedFont" :disabled="busy" native-type="button" @click="readFontDetail(selectedFont.archive)">
        {{ t('admin.fontDetails') }}
      </ElButton>
      <section v-if="fontDetail" class="font-details" aria-labelledby="admin-font-details">
        <h3 id="admin-font-details" ref="fontDetailHeading" tabindex="-1">{{ t('admin.fontDetails') }}</h3>
        <p>{{ fontDetail.name || fontDetail.id }} {{ fontDetail.version }}</p>
        <dl>
          <template v-if="fontDetail.family">
            <dt>{{ t('admin.fontFamily') }}</dt>
            <dd>{{ fontDetail.family }}</dd>
          </template>
          <dt>{{ t('admin.archiveSha') }}</dt>
          <dd><code>{{ fontDetail.archiveDigest }}</code></dd>
          <dt>{{ t('admin.fontFace') }}</dt>
          <dd>{{ t('admin.fontFaceDescription', { weight: fontDetail.faceWeight, style: fontDetail.faceStyle, bytes: fontDetail.faceBytes }) }}</dd>
          <dt>{{ t('admin.faceSha') }}</dt>
          <dd><code>{{ fontDetail.faceDigest }}</code></dd>
          <template v-if="fontDetail.unicodeRange">
            <dt>{{ t('admin.unicodeRange') }}</dt>
            <dd><code>{{ fontDetail.unicodeRange }}</code></dd>
          </template>
          <template v-if="fontDetail.sourceKind">
            <dt>{{ t('admin.source') }}</dt>
            <dd>{{ fontDetail.sourcePackage }} {{ fontDetail.sourceVersion }} · {{ fontDetail.sourceUpstream }} ({{ fontDetail.sourceKind }})</dd>
          </template>
          <dt>{{ t('admin.license') }}</dt>
          <dd>{{ fontDetail.licenseName }}</dd>
        </dl>
        <pre>{{ fontDetail.licenseText }}</pre>
      </section>
      <ElButton type="primary" :disabled="busy || !canApply" native-type="button" @click="apply(false)">{{ t('admin.applyAppearance') }}</ElButton>
      <ElButton v-if="state.canRollback" :disabled="busy" native-type="button" @click="apply(true)">
        {{ t('admin.restoreAppearance', { theme: name(state.previousTheme), font: name(state.previousFont) }) }}
      </ElButton>
      <ElButton :disabled="busy" native-type="button" @click="readHistory()">
        {{ historyBefore === undefined ? t('admin.checkAppearanceHistory') : t('admin.latestAppearance') }}
      </ElButton>
      <section v-if="history" aria-labelledby="admin-appearance-history">
        <h3 id="admin-appearance-history" ref="historyHeading" tabindex="-1">{{ t('admin.appearanceHistory') }}</h3>
        <p v-if="history.items.length === 0">{{ t('admin.noAppearanceHistory') }}</p>
        <ol v-else class="appearance-history">
          <li v-for="change in history.items" :key="String(change.revision)">
            <ElCard shadow="never">
              <strong>{{ t('admin.appearanceRevision', { action: change.rollback ? t('admin.rolledBack') : t('admin.applied'), revision: String(change.revision) }) }}</strong>
              <p><time :datetime="historyTime(change.happenedUnixMs)">{{ historyTime(change.happenedUnixMs) }}</time> · {{ change.actor }}</p>
              <dl>
                <dt>{{ t('admin.themeArchive') }}</dt>
                <dd><code>{{ change.previousTheme || t('admin.builtIn') }}</code> → <code>{{ change.theme || t('admin.builtIn') }}</code></dd>
                <dt>{{ t('admin.fontArchive') }}</dt>
                <dd><code>{{ change.previousFont || t('admin.builtIn') }}</code> → <code>{{ change.font || t('admin.builtIn') }}</code></dd>
              </dl>
            </ElCard>
          </li>
        </ol>
        <ElButton v-if="history.nextBefore" :disabled="busy" native-type="button" @click="readHistory(history.nextBefore ?? undefined)">
          {{ t('admin.earlierAppearance') }}
        </ElButton>
      </section>
    </template>
  </section>
</template>

<style scoped>
.appearance-history { display: grid; gap: .75rem; padding: 0; list-style: none; }
.appearance-history dd, .font-details dd { margin-inline-start: 0; overflow-wrap: anywhere; }
.font-details pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
