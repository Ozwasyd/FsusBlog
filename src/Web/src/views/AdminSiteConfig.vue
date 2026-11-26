<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, shallowRef } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElFormSection, ElInlineActions, ElInput, ElRadioButton, ElRadioGroup,
  ElSettingsSection, ElSkeleton, ElTabPane, ElTabs, ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  readAdminSiteConfig, saveAdminSiteConfig, validCopyrightStartYear, validSiteColor, validSiteEmail, validSiteText, validSiteUrl,
  type AdminSiteConfigCommand, type AdminSiteConfigState, type SiteConfigFieldError,
} from '../../../Contracts/admin-site-config'
import { WireLimits } from '../../../Contracts/wire.generated'
import { applySiteBrand, bumpSiteConfigEpoch, safeBrandAssetUrl } from '../siteBrand'
import { t, type MessageKey } from '../siteLocale'
import { useDelayedBusy } from '../delayedBusy'
import { isAdminSessionLost, useAdminRequests } from './adminSessionClear'
import AdminSiteConfigFields from './AdminSiteConfigFields.vue'
import { fieldId, fieldInputAttrs, fieldLabel, type FieldKey, type SiteConfigField, type SiteConfigFieldControls } from './siteConfigFields'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()

type ConfigTab = 'seo' | 'brand' | 'compliance'
type FormModel = Record<FieldKey, string> & { complianceEnabled: boolean; regionMode: 'global' | 'mainland-cn' }

const shortTextFields = new Set<FieldKey>(['manifestName', 'manifestShortName', 'copyrightOwner', 'contentLicenseName', 'operatorName'])
const assetUrlFields = new Set<FieldKey>([
  'ogImage', 'faviconSvgUrl', 'faviconIcoUrl', 'faviconPngUrl', 'appleTouchIconUrl',
  'pwaIcon192Url', 'pwaIcon512Url', 'pwaMaskableIconUrl', 'siteLogoUrl', 'siteLogoDarkUrl', 'siteWordmarkUrl',
])
const seoFields: readonly SiteConfigField[] = [
  { key: 'title', hint: 'admin.siteConfig.siteTitleHint', autocomplete: 'organization', required: true },
  { key: 'author', hint: 'admin.siteConfig.authorHint', autocomplete: 'name', required: true },
  { key: 'description', hint: 'admin.siteConfig.descriptionHint', type: 'textarea', autosize: { minRows: 3, maxRows: 6 } },
  { key: 'ogImage', hint: 'admin.siteConfig.assetUrlHint', placeholder: '/assets/og.png', identifier: true },
]
const brandLogos: readonly SiteConfigField[] = [
  { key: 'siteLogoUrl', placeholder: '/assets/logo.svg', hintId: 'site-config-hint-brand-urls', identifier: true },
  { key: 'siteLogoDarkUrl', placeholder: '/assets/logo-dark.svg', hintId: 'site-config-hint-brand-urls', identifier: true },
  { key: 'siteWordmarkUrl', hint: 'admin.siteConfig.siteWordmarkHint', placeholder: '/assets/wordmark.svg', identifier: true },
]
const favicons: readonly SiteConfigField[] = [
  { key: 'faviconSvgUrl', placeholder: '/assets/favicon.svg', identifier: true },
  { key: 'faviconIcoUrl', placeholder: '/assets/favicon.ico', identifier: true },
  { key: 'faviconPngUrl', placeholder: '/assets/favicon.png', identifier: true },
  { key: 'appleTouchIconUrl', placeholder: '/assets/apple-touch-icon.png', identifier: true },
]
const pwaIcons: readonly SiteConfigField[] = [
  { key: 'pwaIcon192Url', placeholder: '/assets/icon-192.png', identifier: true },
  { key: 'pwaIcon512Url', placeholder: '/assets/icon-512.png', identifier: true },
  { key: 'pwaMaskableIconUrl', placeholder: '/assets/icon-maskable-512.png', identifier: true },
]
const manifestColors = { themeColor: { fallback: '#1f4e79', manifestKey: 'theme_color' }, backgroundColor: { fallback: '#ffffff', manifestKey: 'background_color' } } as const
const manifestNames: readonly SiteConfigField[] = [
  { key: 'manifestName', hint: 'admin.siteConfig.manifestNameHint' },
  { key: 'manifestShortName', hint: 'admin.siteConfig.manifestShortNameHint' },
]
const registrationFields: readonly SiteConfigField[] = [
  { key: 'icpRecordNumber', identifier: true },
  { key: 'icpRecordUrl', hint: 'admin.siteConfig.icpUrlHint', placeholder: 'https://beian.miit.gov.cn/', identifier: true },
  { key: 'policeRecordNumber', identifier: true },
  { key: 'policeRecordUrl', hint: 'admin.siteConfig.policeUrlHint', placeholder: 'https://beian.mps.gov.cn/', identifier: true },
]
const policeBadgeFields: readonly SiteConfigField[] = [
  { key: 'policeBadgeIconUrl', hint: 'admin.siteConfig.assetUrlHint', placeholder: '/assets/police-badge.png', identifier: true },
]
const copyrightFields: readonly SiteConfigField[] = [
  { key: 'copyrightOwner' },
  { key: 'copyrightStartYear', hint: 'admin.siteConfig.copyrightStartYearHint', placeholder: '2024', identifier: true, inputmode: 'numeric' },
]
const copyrightTextFields: readonly SiteConfigField[] = [
  { key: 'copyrightText', type: 'textarea', autosize: { minRows: 2, maxRows: 4 } },
]
const licenseFields: readonly SiteConfigField[] = [
  { key: 'contentLicenseName', placeholder: 'CC BY 4.0' },
  { key: 'contentLicenseUrl', hint: 'admin.siteConfig.httpsUrlHint', placeholder: 'https://creativecommons.org/licenses/by/4.0/', identifier: true },
]
const operatorFields: readonly SiteConfigField[] = [
  { key: 'operatorName' },
  { key: 'contactEmail', type: 'email', hint: 'admin.siteConfig.contactEmailHint', placeholder: 'contact@example.com', identifier: true, autocomplete: 'email' },
]

const fieldKeys = (fields: readonly SiteConfigField[]) => fields.map(({ key }) => key)
const tabFields: Record<ConfigTab, readonly FieldKey[]> = {
  seo: fieldKeys(seoFields),
  brand: [...fieldKeys([...brandLogos, ...favicons, ...manifestNames]), 'themeColor', 'backgroundColor', ...fieldKeys(pwaIcons)],
  compliance: fieldKeys([...copyrightFields, ...copyrightTextFields, ...licenseFields, ...registrationFields, ...policeBadgeFields, ...operatorFields]),
}
const fieldTabs = Object.fromEntries(
  (Object.entries(tabFields) as [ConfigTab, readonly FieldKey[]][]).flatMap(([tab, keys]) => keys.map(key => [key, tab])),
) as Readonly<Record<FieldKey, ConfigTab>>
const fieldOrder = Object.values(tabFields).flat()
const textFields = (read: (field: FieldKey) => string) =>
  Object.fromEntries(fieldOrder.map(field => [field, read(field)])) as Record<FieldKey, string>
const emptyForm = (): FormModel => ({ ...textFields(() => ''), complianceEnabled: false, regionMode: 'global' })

const state = shallowRef<AdminSiteConfigState>()
const form = reactive<FormModel>(emptyForm())
const activeTab = ref<ConfigTab>('seo')
const loading = ref(false)
const refreshLoading = useDelayedBusy(() => loading.value)
const saving = ref(false)
const stale = ref(false)
const confirmed = ref(false)
const submitted = ref(false)
const error = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const touched = reactive<Partial<Record<FieldKey, boolean>>>({})
const brokenPreviewUrls = ref<Record<string, boolean>>({})
const liveAnnouncement = ref('')
let announceTimer: ReturnType<typeof setTimeout> | undefined
let announcedField: FieldKey | undefined

const selectTab = (value: string | number) => { activeTab.value = value === 'brand' || value === 'compliance' ? value : 'seo' }

function stateToForm(source: AdminSiteConfigState): FormModel {
  return {
    ...textFields(field => field === 'copyrightStartYear' ? (source.copyrightStartYear > 0 ? String(source.copyrightStartYear) : '') : source[field]),
    complianceEnabled: source.complianceEnabled,
    regionMode: source.regionMode === 'mainland-cn' ? 'mainland-cn' : 'global',
  }
}

function applyFormValues(values: FormModel) {
  Object.assign(form, values)
  for (const key of fieldOrder) delete touched[key]
  submitted.value = confirmed.value = false
  brokenPreviewUrls.value = {}
  clearAnnouncement()
}

function parseYear(raw: string): number | null {
  const trimmed = raw.trim()
  return !trimmed ? null : /^\d{4}$/.test(trimmed) ? Number(trimmed) : -1
}

function validateField(field: FieldKey): SiteConfigFieldError | null {
  if (shortTextFields.has(field)) return validSiteText(form[field], WireLimits.SiteConfigShortTextBytes)
  if (assetUrlFields.has(field)) return validSiteUrl(form[field], { asset: true })
  switch (field) {
    case 'themeColor': case 'backgroundColor': return validSiteColor(form[field])
    case 'icpRecordNumber': case 'policeRecordNumber': return validSiteText(form[field], WireLimits.SiteConfigRecordNumberBytes)
    case 'title': return validSiteText(form.title, WireLimits.SiteConfigTitleBytes, true)
    case 'author': return validSiteText(form.author, WireLimits.SiteConfigAuthorBytes, true)
    case 'description': return validSiteText(form.description, WireLimits.SiteConfigDescriptionBytes, false, true)
    case 'copyrightStartYear': return validCopyrightStartYear(parseYear(form.copyrightStartYear))
    case 'copyrightText': return validSiteText(form.copyrightText, WireLimits.SiteConfigCopyrightTextBytes, false, true)
    case 'contentLicenseUrl': return validSiteUrl(form.contentLicenseUrl, { label: form.contentLicenseName })
    case 'icpRecordUrl': return validSiteUrl(form.icpRecordUrl, { label: form.icpRecordNumber })
    case 'policeRecordUrl': return validSiteUrl(form.policeRecordUrl, { label: form.policeRecordNumber })
    case 'policeBadgeIconUrl': return validSiteUrl(form.policeBadgeIconUrl, { asset: true, label: form.policeRecordNumber })
    case 'contactEmail': return validSiteEmail(form.contactEmail)
    default: return null
  }
}

const allErrors = computed(() => {
  const map: Partial<Record<FieldKey, SiteConfigFieldError>> = {}
  for (const key of fieldOrder) {
    const issue = validateField(key)
    if (issue) map[key] = issue
  }
  return map
})

const visibleError = (field: FieldKey) => (submitted.value || touched[field]) ? allErrors.value[field] : undefined
const errorMessage = (code: SiteConfigFieldError) => t(`admin.siteConfig.error.${code}` as MessageKey)

const fieldControls: SiteConfigFieldControls = {
  values: form,
  get disabled() { return saving.value },
  error(field) {
    const issue = visibleError(field)
    return issue ? errorMessage(issue) : ''
  },
  change(field, value) { form[field] = value },
  input: onInput,
  blur: onBlur,
}

function clearAnnouncement() {
  if (announceTimer !== undefined) { clearTimeout(announceTimer); announceTimer = undefined }
  liveAnnouncement.value = ''
  announcedField = undefined
}

function onBlur(field: FieldKey) {
  touched[field] = true
  const issue = allErrors.value[field]
  if (issue) {
    clearAnnouncement()
    announcedField = field
    announceTimer = setTimeout(() => { liveAnnouncement.value = `${t(fieldLabel(field))}: ${errorMessage(issue)}` }, 500)
  } else if (announcedField === field) clearAnnouncement()
}

function onInput(field: FieldKey) {
  confirmed.value = false
  notice.value = ''
  if (error.value === 'admin.siteConfig.validationSummary') error.value = ''
  if (announcedField === field && !allErrors.value[field]) clearAnnouncement()
}

function buildCommand(current: AdminSiteConfigState): AdminSiteConfigCommand {
  const year = parseYear(form.copyrightStartYear)
  return {
    expectedRevision: current.revision, expectedDigest: current.digest,
    ...textFields(field => form[field].trim()),
    complianceEnabled: form.complianceEnabled, regionMode: form.regionMode,
    copyrightStartYear: year && year > 0 ? year : 0,
  }
}

const isDirty = computed(() => {
  if (!state.value) return false
  const baseline = stateToForm(state.value)
  return (Object.keys(baseline) as (keyof FormModel)[]).some(key => {
    const a = baseline[key], b = form[key]
    return typeof a === 'string' && typeof b === 'string' ? a.trim() !== b.trim() : a !== b
  })
})

const tabErrorCount = computed(() => {
  const counts: Record<ConfigTab, number> = { seo: 0, brand: 0, compliance: 0 }
  for (const key of fieldOrder) if (visibleError(key)) counts[fieldTabs[key]] += 1
  return counts
})

const sectionDescription = computed(() => !state.value ? '' : state.value.revision === 0n
  ? t('admin.siteConfig.baselineDesc')
  : t('admin.siteConfig.overrideDesc', { revision: state.value.revision.toString() }))

const activePreview = (url: string) => (url && !brokenPreviewUrls.value[url] ? url : '')
const previewOrigin = computed(() => state.value?.origin || window.location.origin)
const previewOgUrl = computed(() => activePreview(safeBrandAssetUrl(form.ogImage)))
const previewLightLogo = computed(() => activePreview(safeBrandAssetUrl(form.siteLogoUrl)))
const previewDarkLogo = computed(() => activePreview(safeBrandAssetUrl(form.siteLogoDarkUrl) || safeBrandAssetUrl(form.siteLogoUrl)))
const brandPreviews = { light: { label: 'admin.siteConfig.previewLight', logo: previewLightLogo }, dark: { label: 'admin.siteConfig.previewDark', logo: previewDarkLogo } } as const
const previewWordmark = computed(() => activePreview(safeBrandAssetUrl(form.siteWordmarkUrl)))
const previewPoliceBadge = computed(() => activePreview(safeBrandAssetUrl(form.policeBadgeIconUrl)))
const manifestPreviewName = computed(() => form.manifestName.trim() || form.title.trim() || "Fsu's Blog")
const manifestPreviewShortName = computed(() => form.manifestShortName.trim() || manifestPreviewName.value)
const manifestIconCount = computed(() => [form.pwaIcon192Url, form.pwaIcon512Url, form.pwaMaskableIconUrl].filter(v => safeBrandAssetUrl(v).length > 0).length)

const currentYear = new Date().getFullYear()
const previewCopyright = computed(() => {
  const start = form.complianceEnabled ? parseYear(form.copyrightStartYear) : null
  const years = start && start >= 1990 && start < currentYear ? `${start}–${currentYear}` : currentYear
  const owner = (form.complianceEnabled ? form.copyrightOwner.trim() : '') || form.author.trim()
  const statement = (form.complianceEnabled ? form.copyrightText.trim() : '') || t('nav.rightsReserved')
  return ['©', years, owner, statement].filter(Boolean).join(' ')
})
const registrationUrl = (number: string, url: string, fallback: string) => number.trim() ? url.trim() || fallback : ''
const previewIcpUrl = computed(() => registrationUrl(form.icpRecordNumber, form.icpRecordUrl, 'https://beian.miit.gov.cn/'))
const previewPoliceUrl = computed(() => registrationUrl(form.policeRecordNumber, form.policeRecordUrl, 'https://beian.mps.gov.cn/'))

function markPreviewBroken(url: string) {
  if (url && !brokenPreviewUrls.value[url]) brokenPreviewUrls.value = { ...brokenPreviewUrls.value, [url]: true }
}

const pickerColor = (raw: string, fallback: string) => (/^#[0-9a-fA-F]{6}$/.test(raw.trim()) ? raw.trim() : fallback)
function setColor(field: 'themeColor' | 'backgroundColor', value: string) {
  form[field] = value; touched[field] = true; onInput(field)
}
const onColorPicker = (field: 'themeColor' | 'backgroundColor', event: Event) => setColor(field, (event.target as HTMLInputElement).value)
const clearColor = (field: 'themeColor' | 'backgroundColor') => setColor(field, '')

function resetForm() {
  if (!state.value) return
  applyFormValues(stateToForm(state.value))
  error.value = notice.value = ''
}

function clear() {
  state.value = undefined
  applyFormValues(emptyForm())
  loading.value = saving.value = stale.value = false
  error.value = notice.value = ''
}

const requests = useAdminRequests(() => props.sessionSignal, clear)

async function load() {
  if (props.sessionSignal.aborted) return
  const req = requests.start()
  loading.value = true; error.value = ''
  try {
    const next = await readAdminSiteConfig(req.signal)
    if (req.signal.aborted) return
    state.value = next; stale.value = false
    applyFormValues(stateToForm(next))
  } catch (cause) {
    if (req.signal.aborted) return
    if (isAdminSessionLost(cause)) emit('session-lost', cause)
    else error.value = 'admin.siteConfig.loadFailed'
  } finally {
    if (req.isCurrent()) { req.finish(); loading.value = false }
  }
}

async function focusField(field: FieldKey) {
  activeTab.value = fieldTabs[field]
  await nextTick()
  const el = document.getElementById(`site-config-field-${field}`)
  if (el instanceof HTMLElement) { el.focus(); el.scrollIntoView({ block: 'nearest' }) }
}

async function submit() {
  if (!state.value || saving.value || loading.value || stale.value || !isDirty.value || !confirmed.value) return
  submitted.value = true
  for (const key of fieldOrder) touched[key] = true
  const firstInvalid = fieldOrder.find(key => Boolean(allErrors.value[key]))
  if (firstInvalid) { error.value = 'admin.siteConfig.validationSummary'; await focusField(firstInvalid); return }

  const command = buildCommand(state.value)
  const req = requests.start()
  saving.value = true; error.value = notice.value = ''
  try {
    await saveAdminSiteConfig(command, req.signal)
    if (req.signal.aborted) return
    stale.value = true
    applySiteBrand({
      title: command.title, author: command.author, siteLogoUrl: command.siteLogoUrl,
      siteLogoDarkUrl: command.siteLogoDarkUrl, siteWordmarkUrl: command.siteWordmarkUrl,
    })
    bumpSiteConfigEpoch()
    const reloaded = await readAdminSiteConfig(req.signal)
    if (req.signal.aborted) return
    state.value = reloaded; stale.value = false
    applyFormValues(stateToForm(reloaded))
    notice.value = 'admin.siteConfig.saved'
  } catch (cause) {
    if (req.signal.aborted) return
    if (isAdminSessionLost(cause)) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 409) {
      stale.value = true; confirmed.value = false; error.value = 'admin.siteConfig.conflict'
    } else if (cause instanceof Error && cause.name === 'NotAllowedError') error.value = 'admin.passkeyCanceled'
    else error.value = 'admin.siteConfig.saveFailed'
  } finally {
    req.finish(); saving.value = false
  }
}

onMounted(() => { void load() })
onScopeDispose(clearAnnouncement)
</script>

<template>
  <ElSettingsSection class="admin-site-config" ariaLabelledby="admin-site-config-heading" :description="sectionDescription || undefined" v-bind="{ 'aria-busy': loading || saving }" density="compact">
    <template #title>
      <span id="admin-site-config-heading">{{ t('admin.siteConfig.title') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" :loading="refreshLoading" :disabled="saving" @click="load">{{ t('admin.siteConfig.refresh') }}</ElButton>
    </template>

    <div class="visually-hidden" aria-live="polite">{{ liveAnnouncement }}</div>

    <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="t(notice)" type="success" :closable="false" show-icon />

    <div v-if="loading && !state" class="site-config-loading" role="status">
      <p>{{ t('admin.siteConfig.loading') }}</p>
      <ElSkeleton :rows="5" />
    </div>

    <form v-else-if="state" class="site-config-form" aria-labelledby="admin-site-config-heading" novalidate @submit.prevent="submit">
      <ElTabs :model-value="activeTab" class="site-config-tabs" @update:model-value="selectTab">
        <ElTabPane name="seo">
          <template #label>
            <span class="site-config-tab-label">
              {{ t('admin.siteConfig.tabSeo') }}
              <ElTag v-if="tabErrorCount.seo > 0" type="danger" size="small">{{ tabErrorCount.seo }}</ElTag>
            </span>
          </template>
          <div class="site-config-split">
            <div class="site-config-fields">
              <AdminSiteConfigFields :fields="seoFields" :controls="fieldControls" />

              <div class="config-field">
                <span class="config-readonly-label">{{ t('admin.siteConfig.canonicalOrigin') }}</span>
                <span class="config-hint">{{ t('admin.siteConfig.canonicalOriginHint') }}</span>
                <code class="config-origin-value">{{ state.origin || t('admin.siteConfig.canonicalOriginUnset') }}</code>
              </div>
            </div>

            <aside class="site-config-preview-col" :aria-label="t('admin.siteConfig.searchPreview')">
              <div class="preview-card">
                <h3 class="preview-card-title">{{ t('admin.siteConfig.searchPreview') }}</h3>
                <div class="search-preview-box">
                  <p class="search-preview-url">{{ previewOrigin }}</p>
                  <p class="search-preview-title">{{ form.title.trim() || "Fsu's Blog" }}</p>
                  <p class="search-preview-desc">{{ form.description.trim() || t('admin.siteConfig.descriptionHint') }}</p>
                  <img v-if="previewOgUrl" class="search-preview-og" :src="previewOgUrl" alt="" decoding="async" referrerpolicy="no-referrer"
                    @error="markPreviewBroken(previewOgUrl)">
                </div>
              </div>
            </aside>
          </div>
        </ElTabPane>

        <ElTabPane name="brand">
          <template #label>
            <span class="site-config-tab-label">
              {{ t('admin.siteConfig.tabBrand') }}
              <ElTag v-if="tabErrorCount.brand > 0" type="danger" size="small">{{ tabErrorCount.brand }}</ElTag>
            </span>
          </template>
          <div class="site-config-split">
            <div class="site-config-fields">
              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.brandGroup') }}</legend>
                <p id="site-config-hint-brand-urls" class="config-hint">{{ t('admin.siteConfig.assetUrlHint') }}</p>
                <AdminSiteConfigFields :fields="brandLogos" :controls="fieldControls" />
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.faviconGroup') }}</legend>
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="favicons" :controls="fieldControls" />
                </div>
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.pwaGroup') }}</legend>
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="manifestNames" :controls="fieldControls" />
                  <div v-for="({ fallback }, field) in manifestColors" :key="field" class="config-field">
                    <label :for="`site-config-field-${field}`">{{ t(fieldLabel(field)) }}</label>
                    <span :id="`site-config-hint-${field}`" class="config-hint">{{ t('admin.siteConfig.colorHint') }}</span>
                    <div class="config-color-row">
                      <input class="config-color-picker" type="color" :value="pickerColor(form[field], fallback)"
                        :aria-label="t(fieldLabel(field))" :disabled="saving" @input="onColorPicker(field, $event)">
                      <ElInput :id="`site-config-field-${field}`" v-model="form[field]" :placeholder="fallback" :disabled="saving"
                        v-bind="fieldInputAttrs(field, !!visibleError(field), { hintId: fieldId('hint', field), identifier: true })"
                        @blur="onBlur(field)" @input="onInput(field)" />
                      <ElButton v-if="form[field]" native-type="button" text :disabled="saving" @click="clearColor(field)">
                        {{ t('admin.siteConfig.clearColor') }}
                      </ElButton>
                    </div>
                    <p v-if="visibleError(field)" :id="`site-config-error-${field}`" class="config-error">{{ errorMessage(visibleError(field)!) }}</p>
                  </div>
                </div>

                <AdminSiteConfigFields :fields="pwaIcons" :controls="fieldControls" />
              </fieldset>
            </div>

            <aside class="site-config-preview-col" :aria-label="t('admin.siteConfig.brandPreview')">
              <div class="preview-card">
                <h3 class="preview-card-title">{{ t('admin.siteConfig.brandPreview') }}</h3>
                <div v-for="({ label, logo }, mode) in brandPreviews" :key="mode"
                  class="brand-preview-strip" :class="`brand-preview-strip--${mode}`">
                  <span class="brand-preview-tag">{{ t(label) }}</span>
                  <div class="site-brand-mark">
                    <img v-if="logo.value" class="site-brand-logo" :src="logo.value" alt="" decoding="async" referrerpolicy="no-referrer"
                      @error="markPreviewBroken(logo.value)">
                    <img v-if="previewWordmark" class="site-brand-wordmark" :src="previewWordmark" :alt="form.title.trim() || 'Site'" decoding="async" referrerpolicy="no-referrer"
                      @error="markPreviewBroken(previewWordmark)">
                    <strong v-else class="brand-preview-text">{{ form.title.trim() || "Fsu's Blog" }}</strong>
                  </div>
                </div>
              </div>

              <div class="preview-card">
                <h3 class="preview-card-title">{{ t('admin.siteConfig.manifestPreview') }}</h3>
                <dl class="manifest-summary-list">
                  <div>
                    <dt>name</dt>
                    <dd>{{ manifestPreviewName }}</dd>
                  </div>
                  <div>
                    <dt>short_name</dt>
                    <dd>{{ manifestPreviewShortName }}</dd>
                  </div>
                  <template v-for="({ fallback, manifestKey }, field) in manifestColors" :key="field">
                    <div v-if="form[field].trim()">
                      <dt>{{ manifestKey }}</dt>
                      <dd class="manifest-swatch-val">
                        <span class="manifest-swatch" :style="{ backgroundColor: pickerColor(form[field], fallback) }" aria-hidden="true" />
                        <code>{{ form[field].trim() }}</code>
                      </dd>
                    </div>
                  </template>
                </dl>
                <p class="manifest-meta">{{ t('admin.siteConfig.manifestIconsCount', { count: String(manifestIconCount) }) }}</p>
                <a class="manifest-link" href="/manifest.webmanifest" target="_blank" rel="noopener">{{ t('admin.siteConfig.viewManifest') }}</a>
              </div>
            </aside>
          </div>
        </ElTabPane>

        <ElTabPane name="compliance">
          <template #label>
            <span class="site-config-tab-label">
              {{ t('admin.siteConfig.tabCompliance') }}
              <ElTag v-if="tabErrorCount.compliance > 0" type="danger" size="small">{{ tabErrorCount.compliance }}</ElTag>
            </span>
          </template>
          <div class="site-config-split">
            <div class="site-config-fields">
              <div class="config-toggle-block">
                <ElCheckbox :model-value="form.complianceEnabled" :disabled="saving"
                  @update:model-value="form.complianceEnabled = $event === true; confirmed = false; notice = ''">
                  {{ t('admin.siteConfig.complianceEnabled') }}
                </ElCheckbox>
              </div>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.regionMode') }}</legend>
                <ElRadioGroup :model-value="form.regionMode" :disabled="saving"
                  @update:model-value="form.regionMode = $event === 'mainland-cn' ? 'mainland-cn' : 'global'; confirmed = false; notice = ''">
                  <ElRadioButton value="global">{{ t('admin.siteConfig.regionGlobal') }}</ElRadioButton>
                  <ElRadioButton value="mainland-cn">{{ t('admin.siteConfig.regionMainland') }}</ElRadioButton>
                </ElRadioGroup>
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.copyrightGroup') }}</legend>
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="copyrightFields" :controls="fieldControls" />
                </div>
                <AdminSiteConfigFields :fields="copyrightTextFields" :controls="fieldControls" />
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="licenseFields" :controls="fieldControls" />
                </div>
              </fieldset>

              <fieldset v-if="form.regionMode === 'mainland-cn'" class="config-fieldset">
                <legend>{{ t('admin.siteConfig.cnGroup') }}</legend>
                <p class="config-hint">{{ t('admin.siteConfig.cnHint') }}</p>
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="registrationFields" :controls="fieldControls" />
                </div>
                <AdminSiteConfigFields :fields="policeBadgeFields" :controls="fieldControls" />
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.operatorGroup') }}</legend>
                <div class="config-grid-2">
                  <AdminSiteConfigFields :fields="operatorFields" :controls="fieldControls" />
                </div>
              </fieldset>
            </div>

            <aside class="site-config-preview-col" :aria-label="t('admin.siteConfig.footerPreview')">
              <div class="preview-card">
                <h3 class="preview-card-title">{{ t('admin.siteConfig.footerPreview') }}</h3>
                <div class="footer-preview-box">
                  <strong class="footer-preview-brand">{{ form.title.trim() || "Fsu's Blog" }}</strong>
                  <p class="footer-preview-copyright">{{ previewCopyright }}</p>
                  <p v-if="!form.complianceEnabled" class="footer-preview-note">{{ t('admin.siteConfig.footerPreviewDisabled') }}</p>
                  <div v-else class="footer-preview-links">
                    <span v-if="form.contentLicenseName.trim()">{{ form.contentLicenseName.trim() }}</span>
                    <template v-if="form.regionMode === 'mainland-cn'">
                      <span v-if="form.icpRecordNumber.trim() && previewIcpUrl">{{ form.icpRecordNumber.trim() }}</span>
                      <span v-if="form.policeRecordNumber.trim() && previewPoliceUrl" class="site-police-link">
                        <img v-if="previewPoliceBadge" class="site-police-badge" :src="previewPoliceBadge" alt="" decoding="async" referrerpolicy="no-referrer"
                          @error="markPreviewBroken(previewPoliceBadge)">
                        <span>{{ form.policeRecordNumber.trim() }}</span>
                      </span>
                    </template>
                    <span v-if="form.operatorName.trim()">{{ form.operatorName.trim() }}</span>
                    <span v-if="form.contactEmail.trim()">{{ form.contactEmail.trim() }}</span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </ElTabPane>
      </ElTabs>

      <ElFormSection class="site-config-commit" density="compact">
        <div v-if="isDirty" class="site-config-dirty-row">
          <ElTag type="warning" size="small">{{ t('admin.siteConfig.unsaved') }}</ElTag>
        </div>
        <ElCheckbox v-if="!stale" :model-value="confirmed" :disabled="saving || !isDirty" @update:model-value="confirmed = $event === true">
          {{ t('admin.siteConfig.confirmSave') }}
        </ElCheckbox>
        <ElInlineActions>
          <ElButton v-if="!stale" native-type="submit" type="primary" :loading="saving" :disabled="loading || saving || !isDirty || !confirmed">
            {{ t('admin.siteConfig.savePasskey') }}
          </ElButton>
          <ElButton v-if="isDirty && !stale" native-type="button" :disabled="loading || saving" @click="resetForm">
            {{ t('admin.siteConfig.discard') }}
          </ElButton>
          <ElButton v-if="stale" native-type="button" :loading="loading" @click="load">
            {{ t('admin.siteConfig.reload') }}
          </ElButton>
        </ElInlineActions>
      </ElFormSection>
    </form>
  </ElSettingsSection>
</template>

<style scoped>
.site-config-loading { display: grid; gap: 8px; }
.site-config-loading p { margin: 0; font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.site-config-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-inline-size: 0; }
.site-config-tabs { min-inline-size: 0; }
.site-config-tab-label, .manifest-swatch-val { display: inline-flex; align-items: center; gap: 6px; }
.site-config-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 21rem); gap: 24px; align-items: start; padding-block-start: 8px; }
.site-config-fields { display: grid; gap: 18px; min-inline-size: 0; }
.config-fieldset { display: grid; gap: 14px; margin: 0; padding: 14px 16px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--fsus-radius-panel, 10px); min-inline-size: 0; }
.config-fieldset legend { padding-inline: 6px; font-size: var(--el-font-size-small); font-weight: 600; color: var(--el-text-color-primary); }
.config-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 14px 16px; }
.site-config-fields :deep(.config-field) { display: grid; align-content: start; gap: 4px; min-inline-size: 0; }
.site-config-fields :deep(.config-field label), .config-readonly-label { font-size: var(--el-font-size-small); font-weight: 500; color: var(--el-text-color-primary); }
.site-config-fields :deep(.config-hint) { margin: 0; font-size: var(--el-font-size-extra-small); line-height: 1.45; color: var(--el-text-color-secondary); }
.site-config-fields :deep(.config-error) { margin: 2px 0 0; font-size: var(--el-font-size-extra-small); line-height: 1.4; color: var(--el-color-danger); }
.config-origin-value { display: block; padding: 8px 10px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); background: var(--el-fill-color-light); font-size: var(--el-font-size-small); color: var(--el-text-color-regular); overflow-wrap: anywhere; }
.config-color-row { display: flex; align-items: center; gap: 8px; }
.config-color-picker { inline-size: 36px; block-size: 32px; padding: 2px; border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base); background: var(--el-bg-color); cursor: pointer; flex-shrink: 0; }
.config-toggle-block { padding-block: 4px; }
.site-config-preview-col { display: grid; gap: 14px; min-inline-size: 0; }
.preview-card { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--fsus-radius-panel, 10px); background: var(--el-bg-color); }
.preview-card-title { margin: 0; font-size: var(--el-font-size-small); font-weight: 600; color: var(--el-text-color-primary); }
.search-preview-box { display: grid; gap: 4px; }
.search-preview-url { margin: 0; font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.search-preview-title { margin: 0; font-size: var(--el-font-size-medium); font-weight: 600; color: var(--el-color-primary); overflow-wrap: anywhere; }
.search-preview-desc { margin: 0; font-size: var(--el-font-size-small); line-height: 1.5; color: var(--el-text-color-regular); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.search-preview-og { margin-block-start: 6px; inline-size: 100%; max-block-size: 150px; object-fit: cover; border-radius: var(--el-border-radius-base); border: 1px solid var(--el-border-color-lighter); }
.brand-preview-strip { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--el-border-radius-base); border: 1px solid var(--el-border-color-lighter); }
.brand-preview-strip--light { background: #ffffff; color: #1c1917; }
.brand-preview-strip--dark { background: #141413; color: #f4f2ee; }
.brand-preview-tag { font-size: var(--el-font-size-extra-small); opacity: 0.7; }
.brand-preview-text { font-size: var(--el-font-size-medium); font-weight: 700; line-height: 1.25; }
.manifest-summary-list { display: grid; gap: 6px; margin: 0; font-size: var(--el-font-size-small); }
.manifest-summary-list > div { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.manifest-summary-list dt { color: var(--el-text-color-secondary); font-family: var(--el-font-family-mono, ui-monospace, monospace); font-size: var(--el-font-size-extra-small); }
.manifest-summary-list dd { margin: 0; color: var(--el-text-color-primary); text-align: end; overflow-wrap: anywhere; }
.manifest-swatch { inline-size: 14px; block-size: 14px; border-radius: 3px; border: 1px solid var(--el-border-color); flex-shrink: 0; }
.manifest-meta { margin: 0; font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.manifest-link { font-size: var(--el-font-size-small); color: var(--el-color-primary); text-decoration: none; }
.manifest-link:hover, .manifest-link:focus-visible { text-decoration: underline; }
.footer-preview-box { display: grid; gap: 6px; font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.footer-preview-brand { color: var(--el-text-color-primary); }
.footer-preview-copyright, .footer-preview-note { margin: 0; line-height: 1.5; }
.footer-preview-note { font-size: var(--el-font-size-extra-small); }
.footer-preview-links { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--el-font-size-extra-small); }
.site-config-commit { padding-block-start: 12px; border-block-start: 1px solid var(--el-border-color-lighter); }
.site-config-dirty-row { display: flex; align-items: center; }
@media (max-width: 900px) { .site-config-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .config-grid-2 { grid-template-columns: minmax(0, 1fr); } }
</style>
