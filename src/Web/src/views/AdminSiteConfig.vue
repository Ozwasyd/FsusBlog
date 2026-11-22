<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, shallowRef } from 'vue'
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElFormSection,
  ElInlineActions,
  ElInput,
  ElRadioButton,
  ElRadioGroup,
  ElSettingsSection,
  ElSkeleton,
  ElTabPane,
  ElTabs,
  ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  readAdminSiteConfig,
  saveAdminSiteConfig,
  validCopyrightStartYear,
  validSiteColor,
  validSiteEmail,
  validSiteText,
  validSiteUrl,
  type AdminSiteConfigCommand,
  type AdminSiteConfigState,
  type SiteConfigFieldError,
} from '../../../Contracts/admin-site-config'
import { WireLimits } from '../../../Contracts/wire.generated'
import { applySiteBrand, bumpSiteConfigEpoch, safeBrandAssetUrl } from '../siteBrand'
import { t, type MessageKey } from '../siteLocale'
import { useDelayedBusy } from '../delayedBusy'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()

type ConfigTab = 'seo' | 'brand' | 'compliance'
type FormModel = {
  title: string
  description: string
  author: string
  ogImage: string
  faviconSvgUrl: string
  faviconIcoUrl: string
  faviconPngUrl: string
  appleTouchIconUrl: string
  manifestName: string
  manifestShortName: string
  pwaIcon192Url: string
  pwaIcon512Url: string
  pwaMaskableIconUrl: string
  themeColor: string
  backgroundColor: string
  siteLogoUrl: string
  siteLogoDarkUrl: string
  siteWordmarkUrl: string
  complianceEnabled: boolean
  regionMode: 'global' | 'mainland-cn'
  copyrightStartYear: string
  copyrightOwner: string
  copyrightText: string
  contentLicenseName: string
  contentLicenseUrl: string
  icpRecordNumber: string
  icpRecordUrl: string
  policeRecordNumber: string
  policeRecordUrl: string
  policeBadgeIconUrl: string
  operatorName: string
  contactEmail: string
}
type FieldKey = Exclude<keyof FormModel, 'complianceEnabled' | 'regionMode'>

const fieldTabs: Readonly<Record<FieldKey, ConfigTab>> = {
  title: 'seo',
  author: 'seo',
  description: 'seo',
  ogImage: 'seo',
  siteLogoUrl: 'brand',
  siteLogoDarkUrl: 'brand',
  siteWordmarkUrl: 'brand',
  faviconSvgUrl: 'brand',
  faviconIcoUrl: 'brand',
  faviconPngUrl: 'brand',
  appleTouchIconUrl: 'brand',
  manifestName: 'brand',
  manifestShortName: 'brand',
  themeColor: 'brand',
  backgroundColor: 'brand',
  pwaIcon192Url: 'brand',
  pwaIcon512Url: 'brand',
  pwaMaskableIconUrl: 'brand',
  copyrightOwner: 'compliance',
  copyrightStartYear: 'compliance',
  copyrightText: 'compliance',
  contentLicenseName: 'compliance',
  contentLicenseUrl: 'compliance',
  icpRecordNumber: 'compliance',
  icpRecordUrl: 'compliance',
  policeRecordNumber: 'compliance',
  policeRecordUrl: 'compliance',
  policeBadgeIconUrl: 'compliance',
  operatorName: 'compliance',
  contactEmail: 'compliance',
}

const fieldOrder = Object.keys(fieldTabs) as FieldKey[]
const fieldLabelKeys: Readonly<Record<FieldKey, MessageKey>> = {
  title: 'admin.siteConfig.siteTitle',
  author: 'admin.siteConfig.author',
  description: 'admin.siteConfig.description',
  ogImage: 'admin.siteConfig.ogImage',
  siteLogoUrl: 'admin.siteConfig.siteLogoUrl',
  siteLogoDarkUrl: 'admin.siteConfig.siteLogoDarkUrl',
  siteWordmarkUrl: 'admin.siteConfig.siteWordmarkUrl',
  faviconSvgUrl: 'admin.siteConfig.faviconSvgUrl',
  faviconIcoUrl: 'admin.siteConfig.faviconIcoUrl',
  faviconPngUrl: 'admin.siteConfig.faviconPngUrl',
  appleTouchIconUrl: 'admin.siteConfig.appleTouchIconUrl',
  manifestName: 'admin.siteConfig.manifestName',
  manifestShortName: 'admin.siteConfig.manifestShortName',
  themeColor: 'admin.siteConfig.themeColor',
  backgroundColor: 'admin.siteConfig.backgroundColor',
  pwaIcon192Url: 'admin.siteConfig.pwaIcon192Url',
  pwaIcon512Url: 'admin.siteConfig.pwaIcon512Url',
  pwaMaskableIconUrl: 'admin.siteConfig.pwaMaskableIconUrl',
  copyrightOwner: 'admin.siteConfig.copyrightOwner',
  copyrightStartYear: 'admin.siteConfig.copyrightStartYear',
  copyrightText: 'admin.siteConfig.copyrightText',
  contentLicenseName: 'admin.siteConfig.contentLicenseName',
  contentLicenseUrl: 'admin.siteConfig.contentLicenseUrl',
  icpRecordNumber: 'admin.siteConfig.icpRecordNumber',
  icpRecordUrl: 'admin.siteConfig.icpRecordUrl',
  policeRecordNumber: 'admin.siteConfig.policeRecordNumber',
  policeRecordUrl: 'admin.siteConfig.policeRecordUrl',
  policeBadgeIconUrl: 'admin.siteConfig.policeBadgeIconUrl',
  operatorName: 'admin.siteConfig.operatorName',
  contactEmail: 'admin.siteConfig.contactEmail',
}

const emptyForm = (): FormModel => ({
  title: '',
  description: '',
  author: '',
  ogImage: '',
  faviconSvgUrl: '',
  faviconIcoUrl: '',
  faviconPngUrl: '',
  appleTouchIconUrl: '',
  manifestName: '',
  manifestShortName: '',
  pwaIcon192Url: '',
  pwaIcon512Url: '',
  pwaMaskableIconUrl: '',
  themeColor: '',
  backgroundColor: '',
  siteLogoUrl: '',
  siteLogoDarkUrl: '',
  siteWordmarkUrl: '',
  complianceEnabled: false,
  regionMode: 'global',
  copyrightStartYear: '',
  copyrightOwner: '',
  copyrightText: '',
  contentLicenseName: '',
  contentLicenseUrl: '',
  icpRecordNumber: '',
  icpRecordUrl: '',
  policeRecordNumber: '',
  policeRecordUrl: '',
  policeBadgeIconUrl: '',
  operatorName: '',
  contactEmail: '',
})

const lifetime = new AbortController()
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
let activeRequest: AbortController | undefined
let announceTimer: ReturnType<typeof setTimeout> | undefined
let announcedField: FieldKey | undefined

function selectTab(value: string | number) {
  activeTab.value = value === 'brand' || value === 'compliance' ? value : 'seo'
}

function stateToForm(source: AdminSiteConfigState): FormModel {
  return {
    title: source.title,
    description: source.description,
    author: source.author,
    ogImage: source.ogImage,
    faviconSvgUrl: source.faviconSvgUrl,
    faviconIcoUrl: source.faviconIcoUrl,
    faviconPngUrl: source.faviconPngUrl,
    appleTouchIconUrl: source.appleTouchIconUrl,
    manifestName: source.manifestName,
    manifestShortName: source.manifestShortName,
    pwaIcon192Url: source.pwaIcon192Url,
    pwaIcon512Url: source.pwaIcon512Url,
    pwaMaskableIconUrl: source.pwaMaskableIconUrl,
    themeColor: source.themeColor,
    backgroundColor: source.backgroundColor,
    siteLogoUrl: source.siteLogoUrl,
    siteLogoDarkUrl: source.siteLogoDarkUrl,
    siteWordmarkUrl: source.siteWordmarkUrl,
    complianceEnabled: source.complianceEnabled,
    regionMode: source.regionMode === 'mainland-cn' ? 'mainland-cn' : 'global',
    copyrightStartYear: source.copyrightStartYear > 0 ? String(source.copyrightStartYear) : '',
    copyrightOwner: source.copyrightOwner,
    copyrightText: source.copyrightText,
    contentLicenseName: source.contentLicenseName,
    contentLicenseUrl: source.contentLicenseUrl,
    icpRecordNumber: source.icpRecordNumber,
    icpRecordUrl: source.icpRecordUrl,
    policeRecordNumber: source.policeRecordNumber,
    policeRecordUrl: source.policeRecordUrl,
    policeBadgeIconUrl: source.policeBadgeIconUrl,
    operatorName: source.operatorName,
    contactEmail: source.contactEmail,
  }
}

function applyFormValues(values: FormModel) {
  Object.assign(form, values)
  for (const key of fieldOrder) delete touched[key]
  submitted.value = false
  confirmed.value = false
  brokenPreviewUrls.value = {}
  clearAnnouncement()
}

function parseYear(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^\d{4}$/.test(trimmed)) return -1
  return Number(trimmed)
}

function validateField(field: FieldKey): SiteConfigFieldError | null {
  switch (field) {
    case 'title': return validSiteText(form.title, WireLimits.SiteConfigTitleBytes, true)
    case 'author': return validSiteText(form.author, WireLimits.SiteConfigAuthorBytes, true)
    case 'description': return validSiteText(form.description, WireLimits.SiteConfigDescriptionBytes, false, true)
    case 'ogImage': return validSiteUrl(form.ogImage, { asset: true })
    case 'faviconSvgUrl': return validSiteUrl(form.faviconSvgUrl, { asset: true })
    case 'faviconIcoUrl': return validSiteUrl(form.faviconIcoUrl, { asset: true })
    case 'faviconPngUrl': return validSiteUrl(form.faviconPngUrl, { asset: true })
    case 'appleTouchIconUrl': return validSiteUrl(form.appleTouchIconUrl, { asset: true })
    case 'manifestName': return validSiteText(form.manifestName, WireLimits.SiteConfigShortTextBytes)
    case 'manifestShortName': return validSiteText(form.manifestShortName, WireLimits.SiteConfigShortTextBytes)
    case 'pwaIcon192Url': return validSiteUrl(form.pwaIcon192Url, { asset: true })
    case 'pwaIcon512Url': return validSiteUrl(form.pwaIcon512Url, { asset: true })
    case 'pwaMaskableIconUrl': return validSiteUrl(form.pwaMaskableIconUrl, { asset: true })
    case 'themeColor': return validSiteColor(form.themeColor)
    case 'backgroundColor': return validSiteColor(form.backgroundColor)
    case 'siteLogoUrl': return validSiteUrl(form.siteLogoUrl, { asset: true })
    case 'siteLogoDarkUrl': return validSiteUrl(form.siteLogoDarkUrl, { asset: true })
    case 'siteWordmarkUrl': return validSiteUrl(form.siteWordmarkUrl, { asset: true })
    case 'copyrightOwner': return validSiteText(form.copyrightOwner, WireLimits.SiteConfigShortTextBytes)
    case 'copyrightStartYear': return validCopyrightStartYear(parseYear(form.copyrightStartYear))
    case 'copyrightText': return validSiteText(form.copyrightText, WireLimits.SiteConfigCopyrightTextBytes, false, true)
    case 'contentLicenseName': return validSiteText(form.contentLicenseName, WireLimits.SiteConfigShortTextBytes)
    case 'contentLicenseUrl': return validSiteUrl(form.contentLicenseUrl, { label: form.contentLicenseName })
    case 'icpRecordNumber': return validSiteText(form.icpRecordNumber, WireLimits.SiteConfigRecordNumberBytes)
    case 'icpRecordUrl': return validSiteUrl(form.icpRecordUrl, { label: form.icpRecordNumber })
    case 'policeRecordNumber': return validSiteText(form.policeRecordNumber, WireLimits.SiteConfigRecordNumberBytes)
    case 'policeRecordUrl': return validSiteUrl(form.policeRecordUrl, { label: form.policeRecordNumber })
    case 'policeBadgeIconUrl': return validSiteUrl(form.policeBadgeIconUrl, { asset: true, label: form.policeRecordNumber })
    case 'operatorName': return validSiteText(form.operatorName, WireLimits.SiteConfigShortTextBytes)
    case 'contactEmail': return validSiteEmail(form.contactEmail)
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

function visibleError(field: FieldKey): SiteConfigFieldError | undefined {
  if (!submitted.value && !touched[field]) return undefined
  return allErrors.value[field]
}

function errorMessage(code: SiteConfigFieldError): string {
  return t(`admin.siteConfig.error.${code}` as MessageKey)
}

function fieldInputBind(
  field: FieldKey,
  opts: { hintId?: string; identifier?: boolean; required?: boolean; autocomplete?: string; inputmode?: string } = {},
): Record<string, unknown> {
  const invalid = Boolean(visibleError(field))
  const ids: string[] = []
  if (opts.hintId) ids.push(opts.hintId)
  if (invalid) ids.push(`site-config-error-${field}`)
  const attrs: Record<string, unknown> = {
    name: field,
    'aria-invalid': invalid ? 'true' : 'false',
  }
  if (ids.length) attrs['aria-describedby'] = ids.join(' ')
  if (opts.required) attrs.required = true
  if (opts.autocomplete) attrs.autocomplete = opts.autocomplete
  if (opts.inputmode) attrs.inputmode = opts.inputmode
  if (opts.identifier) {
    attrs.autocorrect = 'off'
    attrs.autocapitalize = 'none'
    attrs.spellcheck = false
  }
  return attrs
}

function clearAnnouncement() {
  if (announceTimer !== undefined) {
    clearTimeout(announceTimer)
    announceTimer = undefined
  }
  liveAnnouncement.value = ''
  announcedField = undefined
}

function onBlur(field: FieldKey) {
  touched[field] = true
  const issue = allErrors.value[field]
  if (issue) {
    clearAnnouncement()
    announcedField = field
    announceTimer = setTimeout(() => {
      liveAnnouncement.value = `${t(fieldLabelKeys[field])}: ${errorMessage(issue)}`
    }, 500)
  } else if (announcedField === field) {
    clearAnnouncement()
  }
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
    expectedRevision: current.revision,
    expectedDigest: current.digest,
    title: form.title.trim(),
    description: form.description.trim(),
    author: form.author.trim(),
    ogImage: form.ogImage.trim(),
    faviconSvgUrl: form.faviconSvgUrl.trim(),
    faviconIcoUrl: form.faviconIcoUrl.trim(),
    faviconPngUrl: form.faviconPngUrl.trim(),
    appleTouchIconUrl: form.appleTouchIconUrl.trim(),
    manifestName: form.manifestName.trim(),
    manifestShortName: form.manifestShortName.trim(),
    pwaIcon192Url: form.pwaIcon192Url.trim(),
    pwaIcon512Url: form.pwaIcon512Url.trim(),
    pwaMaskableIconUrl: form.pwaMaskableIconUrl.trim(),
    themeColor: form.themeColor.trim(),
    backgroundColor: form.backgroundColor.trim(),
    siteLogoUrl: form.siteLogoUrl.trim(),
    siteLogoDarkUrl: form.siteLogoDarkUrl.trim(),
    siteWordmarkUrl: form.siteWordmarkUrl.trim(),
    complianceEnabled: form.complianceEnabled,
    regionMode: form.regionMode,
    copyrightStartYear: year && year > 0 ? year : 0,
    copyrightOwner: form.copyrightOwner.trim(),
    copyrightText: form.copyrightText.trim(),
    contentLicenseName: form.contentLicenseName.trim(),
    contentLicenseUrl: form.contentLicenseUrl.trim(),
    icpRecordNumber: form.icpRecordNumber.trim(),
    icpRecordUrl: form.icpRecordUrl.trim(),
    policeRecordNumber: form.policeRecordNumber.trim(),
    policeRecordUrl: form.policeRecordUrl.trim(),
    policeBadgeIconUrl: form.policeBadgeIconUrl.trim(),
    operatorName: form.operatorName.trim(),
    contactEmail: form.contactEmail.trim(),
  }
}

const isDirty = computed(() => {
  if (!state.value) return false
  const baseline = stateToForm(state.value)
  return (Object.keys(baseline) as (keyof FormModel)[]).some(key => {
    const a = baseline[key]
    const b = form[key]
    if (typeof a === 'string' && typeof b === 'string') return a.trim() !== b.trim()
    return a !== b
  })
})

const tabErrorCount = computed(() => {
  const counts: Record<ConfigTab, number> = { seo: 0, brand: 0, compliance: 0 }
  for (const key of fieldOrder) {
    if (visibleError(key)) counts[fieldTabs[key]] += 1
  }
  return counts
})

const sectionDescription = computed(() => {
  if (!state.value) return ''
  return state.value.revision === 0n
    ? t('admin.siteConfig.baselineDesc')
    : t('admin.siteConfig.overrideDesc', { revision: state.value.revision.toString() })
})

const previewOrigin = computed(() => state.value?.origin || window.location.origin)
const previewOgUrl = computed(() => {
  const url = safeBrandAssetUrl(form.ogImage)
  return url && !brokenPreviewUrls.value[url] ? url : ''
})
const previewLightLogo = computed(() => {
  const url = safeBrandAssetUrl(form.siteLogoUrl)
  return url && !brokenPreviewUrls.value[url] ? url : ''
})
const previewDarkLogo = computed(() => {
  const url = safeBrandAssetUrl(form.siteLogoDarkUrl) || safeBrandAssetUrl(form.siteLogoUrl)
  return url && !brokenPreviewUrls.value[url] ? url : ''
})
const previewWordmark = computed(() => {
  const url = safeBrandAssetUrl(form.siteWordmarkUrl)
  return url && !brokenPreviewUrls.value[url] ? url : ''
})
const previewPoliceBadge = computed(() => {
  const url = safeBrandAssetUrl(form.policeBadgeIconUrl)
  return url && !brokenPreviewUrls.value[url] ? url : ''
})
const manifestPreviewName = computed(() => form.manifestName.trim() || form.title.trim() || "Fsu's Blog")
const manifestPreviewShortName = computed(() => form.manifestShortName.trim() || manifestPreviewName.value)
const manifestIconCount = computed(() =>
  [form.pwaIcon192Url, form.pwaIcon512Url, form.pwaMaskableIconUrl].filter(v => safeBrandAssetUrl(v).length > 0).length)

const currentYear = new Date().getFullYear()
const previewCopyright = computed(() => {
  const start = form.complianceEnabled ? parseYear(form.copyrightStartYear) : null
  const years = start && start >= 1990 && start < currentYear ? `${start}–${currentYear}` : currentYear
  const owner = (form.complianceEnabled ? form.copyrightOwner.trim() : '') || form.author.trim()
  const statement = (form.complianceEnabled ? form.copyrightText.trim() : '') || t('nav.rightsReserved')
  return ['©', years, owner, statement].filter(Boolean).join(' ')
})
const previewIcpUrl = computed(() => {
  const num = form.icpRecordNumber.trim()
  if (!num) return ''
  return form.icpRecordUrl.trim() || 'https://beian.miit.gov.cn/'
})
const previewPoliceUrl = computed(() => {
  const num = form.policeRecordNumber.trim()
  if (!num) return ''
  return form.policeRecordUrl.trim() || 'https://beian.mps.gov.cn/'
})

function markPreviewBroken(url: string) {
  if (!url || brokenPreviewUrls.value[url]) return
  brokenPreviewUrls.value = { ...brokenPreviewUrls.value, [url]: true }
}

function pickerColor(raw: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(raw.trim()) ? raw.trim() : fallback
}

function onColorPicker(field: 'themeColor' | 'backgroundColor', event: Event) {
  const target = event.target as HTMLInputElement
  form[field] = target.value
  touched[field] = true
  onInput(field)
}

function clearColor(field: 'themeColor' | 'backgroundColor') {
  form[field] = ''
  touched[field] = true
  onInput(field)
}

function resetForm() {
  if (!state.value) return
  applyFormValues(stateToForm(state.value))
  error.value = ''
  notice.value = ''
}

function clear() {
  activeRequest?.abort()
  activeRequest = undefined
  state.value = undefined
  applyFormValues(emptyForm())
  loading.value = false
  saving.value = false
  stale.value = false
  error.value = ''
  notice.value = ''
}

async function load() {
  if (props.sessionSignal.aborted) return
  activeRequest?.abort()
  const controller = activeRequest = new AbortController()
  const signal = AbortSignal.any([controller.signal, lifetime.signal, props.sessionSignal])
  loading.value = true
  error.value = ''
  try {
    const next = await readAdminSiteConfig(signal)
    if (signal.aborted) return
    state.value = next
    stale.value = false
    applyFormValues(stateToForm(next))
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else error.value = 'admin.siteConfig.loadFailed'
  } finally {
    if (activeRequest === controller) {
      activeRequest = undefined
      loading.value = false
    }
  }
}

async function focusField(field: FieldKey) {
  activeTab.value = fieldTabs[field]
  await nextTick()
  const el = document.getElementById(`site-config-field-${field}`)
  if (el instanceof HTMLElement) {
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  }
}

async function submit() {
  if (!state.value || saving.value || loading.value || stale.value || !isDirty.value || !confirmed.value) return
  submitted.value = true
  for (const key of fieldOrder) touched[key] = true
  const firstInvalid = fieldOrder.find(key => Boolean(allErrors.value[key]))
  if (firstInvalid) {
    error.value = 'admin.siteConfig.validationSummary'
    await focusField(firstInvalid)
    return
  }

  const current = state.value
  const command = buildCommand(current)
  const controller = activeRequest = new AbortController()
  const signal = AbortSignal.any([controller.signal, lifetime.signal, props.sessionSignal])
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    await saveAdminSiteConfig(command, signal)
    if (signal.aborted) return
    stale.value = true
    applySiteBrand({
      title: command.title,
      author: command.author,
      siteLogoUrl: command.siteLogoUrl,
      siteLogoDarkUrl: command.siteLogoDarkUrl,
      siteWordmarkUrl: command.siteWordmarkUrl,
    })
    bumpSiteConfigEpoch()
    const reloaded = await readAdminSiteConfig(signal)
    if (signal.aborted) return
    state.value = reloaded
    stale.value = false
    applyFormValues(stateToForm(reloaded))
    notice.value = 'admin.siteConfig.saved'
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')) {
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 409) {
      stale.value = true
      confirmed.value = false
      error.value = 'admin.siteConfig.conflict'
    } else if (cause instanceof Error && cause.name === 'NotAllowedError') {
      error.value = 'admin.passkeyCanceled'
    } else {
      error.value = 'admin.siteConfig.saveFailed'
    }
  } finally {
    if (activeRequest === controller) activeRequest = undefined
    saving.value = false
  }
}

watchAdminSessionClear(() => props.sessionSignal, clear, () => lifetime.abort())
onMounted(() => { void load() })
onScopeDispose(() => {
  clearAnnouncement()
  lifetime.abort()
})
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
              <div class="config-field">
                <label for="site-config-field-title">{{ t('admin.siteConfig.siteTitle') }} <span aria-hidden="true">*</span></label>
                <span id="site-config-hint-title" class="config-hint">{{ t('admin.siteConfig.siteTitleHint') }}</span>
                <ElInput id="site-config-field-title" v-model="form.title" :disabled="saving"
                  v-bind="fieldInputBind('title', { hintId: 'site-config-hint-title', required: true, autocomplete: 'organization' })"
                  @blur="onBlur('title')" @input="onInput('title')" />
                <p v-if="visibleError('title')" id="site-config-error-title" class="config-error">{{ errorMessage(visibleError('title')!) }}</p>
              </div>

              <div class="config-field">
                <label for="site-config-field-author">{{ t('admin.siteConfig.author') }} <span aria-hidden="true">*</span></label>
                <span id="site-config-hint-author" class="config-hint">{{ t('admin.siteConfig.authorHint') }}</span>
                <ElInput id="site-config-field-author" v-model="form.author" :disabled="saving"
                  v-bind="fieldInputBind('author', { hintId: 'site-config-hint-author', required: true, autocomplete: 'name' })"
                  @blur="onBlur('author')" @input="onInput('author')" />
                <p v-if="visibleError('author')" id="site-config-error-author" class="config-error">{{ errorMessage(visibleError('author')!) }}</p>
              </div>

              <div class="config-field">
                <label for="site-config-field-description">{{ t('admin.siteConfig.description') }}</label>
                <span id="site-config-hint-description" class="config-hint">{{ t('admin.siteConfig.descriptionHint') }}</span>
                <ElInput id="site-config-field-description" v-model="form.description" type="textarea" :autosize="{ minRows: 3, maxRows: 6 }" :disabled="saving"
                  v-bind="fieldInputBind('description', { hintId: 'site-config-hint-description' })"
                  @blur="onBlur('description')" @input="onInput('description')" />
                <p v-if="visibleError('description')" id="site-config-error-description" class="config-error">{{ errorMessage(visibleError('description')!) }}</p>
              </div>

              <div class="config-field">
                <label for="site-config-field-ogImage">{{ t('admin.siteConfig.ogImage') }}</label>
                <span id="site-config-hint-ogImage" class="config-hint">{{ t('admin.siteConfig.assetUrlHint') }}</span>
                <ElInput id="site-config-field-ogImage" v-model="form.ogImage" placeholder="/assets/og.png" :disabled="saving"
                  v-bind="fieldInputBind('ogImage', { hintId: 'site-config-hint-ogImage', identifier: true })"
                  @blur="onBlur('ogImage')" @input="onInput('ogImage')" />
                <p v-if="visibleError('ogImage')" id="site-config-error-ogImage" class="config-error">{{ errorMessage(visibleError('ogImage')!) }}</p>
              </div>

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
                <div class="config-field">
                  <label for="site-config-field-siteLogoUrl">{{ t('admin.siteConfig.siteLogoUrl') }}</label>
                  <ElInput id="site-config-field-siteLogoUrl" v-model="form.siteLogoUrl" placeholder="/assets/logo.svg" :disabled="saving"
                    v-bind="fieldInputBind('siteLogoUrl', { hintId: 'site-config-hint-brand-urls', identifier: true })"
                    @blur="onBlur('siteLogoUrl')" @input="onInput('siteLogoUrl')" />
                  <p v-if="visibleError('siteLogoUrl')" id="site-config-error-siteLogoUrl" class="config-error">{{ errorMessage(visibleError('siteLogoUrl')!) }}</p>
                </div>
                <div class="config-field">
                  <label for="site-config-field-siteLogoDarkUrl">{{ t('admin.siteConfig.siteLogoDarkUrl') }}</label>
                  <ElInput id="site-config-field-siteLogoDarkUrl" v-model="form.siteLogoDarkUrl" placeholder="/assets/logo-dark.svg" :disabled="saving"
                    v-bind="fieldInputBind('siteLogoDarkUrl', { hintId: 'site-config-hint-brand-urls', identifier: true })"
                    @blur="onBlur('siteLogoDarkUrl')" @input="onInput('siteLogoDarkUrl')" />
                  <p v-if="visibleError('siteLogoDarkUrl')" id="site-config-error-siteLogoDarkUrl" class="config-error">{{ errorMessage(visibleError('siteLogoDarkUrl')!) }}</p>
                </div>
                <div class="config-field">
                  <label for="site-config-field-siteWordmarkUrl">{{ t('admin.siteConfig.siteWordmarkUrl') }}</label>
                  <span id="site-config-hint-siteWordmarkUrl" class="config-hint">{{ t('admin.siteConfig.siteWordmarkHint') }}</span>
                  <ElInput id="site-config-field-siteWordmarkUrl" v-model="form.siteWordmarkUrl" placeholder="/assets/wordmark.svg" :disabled="saving"
                    v-bind="fieldInputBind('siteWordmarkUrl', { hintId: 'site-config-hint-siteWordmarkUrl', identifier: true })"
                    @blur="onBlur('siteWordmarkUrl')" @input="onInput('siteWordmarkUrl')" />
                  <p v-if="visibleError('siteWordmarkUrl')" id="site-config-error-siteWordmarkUrl" class="config-error">{{ errorMessage(visibleError('siteWordmarkUrl')!) }}</p>
                </div>
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.faviconGroup') }}</legend>
                <div class="config-grid-2">
                  <div class="config-field">
                    <label for="site-config-field-faviconSvgUrl">{{ t('admin.siteConfig.faviconSvgUrl') }}</label>
                    <ElInput id="site-config-field-faviconSvgUrl" v-model="form.faviconSvgUrl" placeholder="/assets/favicon.svg" :disabled="saving"
                      v-bind="fieldInputBind('faviconSvgUrl', { identifier: true })"
                      @blur="onBlur('faviconSvgUrl')" @input="onInput('faviconSvgUrl')" />
                    <p v-if="visibleError('faviconSvgUrl')" id="site-config-error-faviconSvgUrl" class="config-error">{{ errorMessage(visibleError('faviconSvgUrl')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-faviconIcoUrl">{{ t('admin.siteConfig.faviconIcoUrl') }}</label>
                    <ElInput id="site-config-field-faviconIcoUrl" v-model="form.faviconIcoUrl" placeholder="/assets/favicon.ico" :disabled="saving"
                      v-bind="fieldInputBind('faviconIcoUrl', { identifier: true })"
                      @blur="onBlur('faviconIcoUrl')" @input="onInput('faviconIcoUrl')" />
                    <p v-if="visibleError('faviconIcoUrl')" id="site-config-error-faviconIcoUrl" class="config-error">{{ errorMessage(visibleError('faviconIcoUrl')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-faviconPngUrl">{{ t('admin.siteConfig.faviconPngUrl') }}</label>
                    <ElInput id="site-config-field-faviconPngUrl" v-model="form.faviconPngUrl" placeholder="/assets/favicon.png" :disabled="saving"
                      v-bind="fieldInputBind('faviconPngUrl', { identifier: true })"
                      @blur="onBlur('faviconPngUrl')" @input="onInput('faviconPngUrl')" />
                    <p v-if="visibleError('faviconPngUrl')" id="site-config-error-faviconPngUrl" class="config-error">{{ errorMessage(visibleError('faviconPngUrl')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-appleTouchIconUrl">{{ t('admin.siteConfig.appleTouchIconUrl') }}</label>
                    <ElInput id="site-config-field-appleTouchIconUrl" v-model="form.appleTouchIconUrl" placeholder="/assets/apple-touch-icon.png" :disabled="saving"
                      v-bind="fieldInputBind('appleTouchIconUrl', { identifier: true })"
                      @blur="onBlur('appleTouchIconUrl')" @input="onInput('appleTouchIconUrl')" />
                    <p v-if="visibleError('appleTouchIconUrl')" id="site-config-error-appleTouchIconUrl" class="config-error">{{ errorMessage(visibleError('appleTouchIconUrl')!) }}</p>
                  </div>
                </div>
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.pwaGroup') }}</legend>
                <div class="config-grid-2">
                  <div class="config-field">
                    <label for="site-config-field-manifestName">{{ t('admin.siteConfig.manifestName') }}</label>
                    <span id="site-config-hint-manifestName" class="config-hint">{{ t('admin.siteConfig.manifestNameHint') }}</span>
                    <ElInput id="site-config-field-manifestName" v-model="form.manifestName" :disabled="saving"
                      v-bind="fieldInputBind('manifestName', { hintId: 'site-config-hint-manifestName' })"
                      @blur="onBlur('manifestName')" @input="onInput('manifestName')" />
                    <p v-if="visibleError('manifestName')" id="site-config-error-manifestName" class="config-error">{{ errorMessage(visibleError('manifestName')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-manifestShortName">{{ t('admin.siteConfig.manifestShortName') }}</label>
                    <span id="site-config-hint-manifestShortName" class="config-hint">{{ t('admin.siteConfig.manifestShortNameHint') }}</span>
                    <ElInput id="site-config-field-manifestShortName" v-model="form.manifestShortName" :disabled="saving"
                      v-bind="fieldInputBind('manifestShortName', { hintId: 'site-config-hint-manifestShortName' })"
                      @blur="onBlur('manifestShortName')" @input="onInput('manifestShortName')" />
                    <p v-if="visibleError('manifestShortName')" id="site-config-error-manifestShortName" class="config-error">{{ errorMessage(visibleError('manifestShortName')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-themeColor">{{ t('admin.siteConfig.themeColor') }}</label>
                    <span id="site-config-hint-themeColor" class="config-hint">{{ t('admin.siteConfig.colorHint') }}</span>
                    <div class="config-color-row">
                      <input class="config-color-picker" type="color" :value="pickerColor(form.themeColor, '#1f4e79')"
                        :aria-label="t('admin.siteConfig.themeColor')" :disabled="saving" @input="onColorPicker('themeColor', $event)">
                      <ElInput id="site-config-field-themeColor" v-model="form.themeColor" placeholder="#1f4e79" :disabled="saving"
                        v-bind="fieldInputBind('themeColor', { hintId: 'site-config-hint-themeColor', identifier: true })"
                        @blur="onBlur('themeColor')" @input="onInput('themeColor')" />
                      <ElButton v-if="form.themeColor" native-type="button" text :disabled="saving" @click="clearColor('themeColor')">
                        {{ t('admin.siteConfig.clearColor') }}
                      </ElButton>
                    </div>
                    <p v-if="visibleError('themeColor')" id="site-config-error-themeColor" class="config-error">{{ errorMessage(visibleError('themeColor')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-backgroundColor">{{ t('admin.siteConfig.backgroundColor') }}</label>
                    <span id="site-config-hint-backgroundColor" class="config-hint">{{ t('admin.siteConfig.colorHint') }}</span>
                    <div class="config-color-row">
                      <input class="config-color-picker" type="color" :value="pickerColor(form.backgroundColor, '#ffffff')"
                        :aria-label="t('admin.siteConfig.backgroundColor')" :disabled="saving" @input="onColorPicker('backgroundColor', $event)">
                      <ElInput id="site-config-field-backgroundColor" v-model="form.backgroundColor" placeholder="#ffffff" :disabled="saving"
                        v-bind="fieldInputBind('backgroundColor', { hintId: 'site-config-hint-backgroundColor', identifier: true })"
                        @blur="onBlur('backgroundColor')" @input="onInput('backgroundColor')" />
                      <ElButton v-if="form.backgroundColor" native-type="button" text :disabled="saving" @click="clearColor('backgroundColor')">
                        {{ t('admin.siteConfig.clearColor') }}
                      </ElButton>
                    </div>
                    <p v-if="visibleError('backgroundColor')" id="site-config-error-backgroundColor" class="config-error">{{ errorMessage(visibleError('backgroundColor')!) }}</p>
                  </div>
                </div>

                <div class="config-field">
                  <label for="site-config-field-pwaIcon192Url">{{ t('admin.siteConfig.pwaIcon192Url') }}</label>
                  <ElInput id="site-config-field-pwaIcon192Url" v-model="form.pwaIcon192Url" placeholder="/assets/icon-192.png" :disabled="saving"
                    v-bind="fieldInputBind('pwaIcon192Url', { identifier: true })"
                    @blur="onBlur('pwaIcon192Url')" @input="onInput('pwaIcon192Url')" />
                  <p v-if="visibleError('pwaIcon192Url')" id="site-config-error-pwaIcon192Url" class="config-error">{{ errorMessage(visibleError('pwaIcon192Url')!) }}</p>
                </div>
                <div class="config-field">
                  <label for="site-config-field-pwaIcon512Url">{{ t('admin.siteConfig.pwaIcon512Url') }}</label>
                  <ElInput id="site-config-field-pwaIcon512Url" v-model="form.pwaIcon512Url" placeholder="/assets/icon-512.png" :disabled="saving"
                    v-bind="fieldInputBind('pwaIcon512Url', { identifier: true })"
                    @blur="onBlur('pwaIcon512Url')" @input="onInput('pwaIcon512Url')" />
                  <p v-if="visibleError('pwaIcon512Url')" id="site-config-error-pwaIcon512Url" class="config-error">{{ errorMessage(visibleError('pwaIcon512Url')!) }}</p>
                </div>
                <div class="config-field">
                  <label for="site-config-field-pwaMaskableIconUrl">{{ t('admin.siteConfig.pwaMaskableIconUrl') }}</label>
                  <ElInput id="site-config-field-pwaMaskableIconUrl" v-model="form.pwaMaskableIconUrl" placeholder="/assets/icon-maskable-512.png" :disabled="saving"
                    v-bind="fieldInputBind('pwaMaskableIconUrl', { identifier: true })"
                    @blur="onBlur('pwaMaskableIconUrl')" @input="onInput('pwaMaskableIconUrl')" />
                  <p v-if="visibleError('pwaMaskableIconUrl')" id="site-config-error-pwaMaskableIconUrl" class="config-error">{{ errorMessage(visibleError('pwaMaskableIconUrl')!) }}</p>
                </div>
              </fieldset>
            </div>

            <aside class="site-config-preview-col" :aria-label="t('admin.siteConfig.brandPreview')">
              <div class="preview-card">
                <h3 class="preview-card-title">{{ t('admin.siteConfig.brandPreview') }}</h3>
                <div class="brand-preview-strip brand-preview-strip--light">
                  <span class="brand-preview-tag">{{ t('admin.siteConfig.previewLight') }}</span>
                  <div class="site-brand-mark">
                    <img v-if="previewLightLogo" class="site-brand-logo" :src="previewLightLogo" alt="" decoding="async" referrerpolicy="no-referrer"
                      @error="markPreviewBroken(previewLightLogo)">
                    <img v-if="previewWordmark" class="site-brand-wordmark" :src="previewWordmark" :alt="form.title.trim() || 'Site'" decoding="async" referrerpolicy="no-referrer"
                      @error="markPreviewBroken(previewWordmark)">
                    <strong v-else class="brand-preview-text">{{ form.title.trim() || "Fsu's Blog" }}</strong>
                  </div>
                </div>
                <div class="brand-preview-strip brand-preview-strip--dark">
                  <span class="brand-preview-tag">{{ t('admin.siteConfig.previewDark') }}</span>
                  <div class="site-brand-mark">
                    <img v-if="previewDarkLogo" class="site-brand-logo" :src="previewDarkLogo" alt="" decoding="async" referrerpolicy="no-referrer"
                      @error="markPreviewBroken(previewDarkLogo)">
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
                  <div v-if="form.themeColor.trim()">
                    <dt>theme_color</dt>
                    <dd class="manifest-swatch-val">
                      <span class="manifest-swatch" :style="{ backgroundColor: pickerColor(form.themeColor, '#1f4e79') }" aria-hidden="true" />
                      <code>{{ form.themeColor.trim() }}</code>
                    </dd>
                  </div>
                  <div v-if="form.backgroundColor.trim()">
                    <dt>background_color</dt>
                    <dd class="manifest-swatch-val">
                      <span class="manifest-swatch" :style="{ backgroundColor: pickerColor(form.backgroundColor, '#ffffff') }" aria-hidden="true" />
                      <code>{{ form.backgroundColor.trim() }}</code>
                    </dd>
                  </div>
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
                  <div class="config-field">
                    <label for="site-config-field-copyrightOwner">{{ t('admin.siteConfig.copyrightOwner') }}</label>
                    <ElInput id="site-config-field-copyrightOwner" v-model="form.copyrightOwner" :disabled="saving"
                      v-bind="fieldInputBind('copyrightOwner')"
                      @blur="onBlur('copyrightOwner')" @input="onInput('copyrightOwner')" />
                    <p v-if="visibleError('copyrightOwner')" id="site-config-error-copyrightOwner" class="config-error">{{ errorMessage(visibleError('copyrightOwner')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-copyrightStartYear">{{ t('admin.siteConfig.copyrightStartYear') }}</label>
                    <span id="site-config-hint-copyrightStartYear" class="config-hint">{{ t('admin.siteConfig.copyrightStartYearHint') }}</span>
                    <ElInput id="site-config-field-copyrightStartYear" v-model="form.copyrightStartYear" placeholder="2024" :disabled="saving"
                      v-bind="fieldInputBind('copyrightStartYear', { hintId: 'site-config-hint-copyrightStartYear', identifier: true, inputmode: 'numeric' })"
                      @blur="onBlur('copyrightStartYear')" @input="onInput('copyrightStartYear')" />
                    <p v-if="visibleError('copyrightStartYear')" id="site-config-error-copyrightStartYear" class="config-error">{{ errorMessage(visibleError('copyrightStartYear')!) }}</p>
                  </div>
                </div>

                <div class="config-field">
                  <label for="site-config-field-copyrightText">{{ t('admin.siteConfig.copyrightText') }}</label>
                  <ElInput id="site-config-field-copyrightText" v-model="form.copyrightText" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :disabled="saving"
                    v-bind="fieldInputBind('copyrightText')"
                    @blur="onBlur('copyrightText')" @input="onInput('copyrightText')" />
                  <p v-if="visibleError('copyrightText')" id="site-config-error-copyrightText" class="config-error">{{ errorMessage(visibleError('copyrightText')!) }}</p>
                </div>

                <div class="config-grid-2">
                  <div class="config-field">
                    <label for="site-config-field-contentLicenseName">{{ t('admin.siteConfig.contentLicenseName') }}</label>
                    <ElInput id="site-config-field-contentLicenseName" v-model="form.contentLicenseName" placeholder="CC BY 4.0" :disabled="saving"
                      v-bind="fieldInputBind('contentLicenseName')"
                      @blur="onBlur('contentLicenseName')" @input="onInput('contentLicenseName')" />
                    <p v-if="visibleError('contentLicenseName')" id="site-config-error-contentLicenseName" class="config-error">{{ errorMessage(visibleError('contentLicenseName')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-contentLicenseUrl">{{ t('admin.siteConfig.contentLicenseUrl') }}</label>
                    <span id="site-config-hint-contentLicenseUrl" class="config-hint">{{ t('admin.siteConfig.httpsUrlHint') }}</span>
                    <ElInput id="site-config-field-contentLicenseUrl" v-model="form.contentLicenseUrl" placeholder="https://creativecommons.org/licenses/by/4.0/" :disabled="saving"
                      v-bind="fieldInputBind('contentLicenseUrl', { hintId: 'site-config-hint-contentLicenseUrl', identifier: true })"
                      @blur="onBlur('contentLicenseUrl')" @input="onInput('contentLicenseUrl')" />
                    <p v-if="visibleError('contentLicenseUrl')" id="site-config-error-contentLicenseUrl" class="config-error">{{ errorMessage(visibleError('contentLicenseUrl')!) }}</p>
                  </div>
                </div>
              </fieldset>

              <fieldset v-if="form.regionMode === 'mainland-cn'" class="config-fieldset">
                <legend>{{ t('admin.siteConfig.cnGroup') }}</legend>
                <p class="config-hint">{{ t('admin.siteConfig.cnHint') }}</p>
                <div class="config-grid-2">
                  <div class="config-field">
                    <label for="site-config-field-icpRecordNumber">{{ t('admin.siteConfig.icpRecordNumber') }}</label>
                    <ElInput id="site-config-field-icpRecordNumber" v-model="form.icpRecordNumber" :disabled="saving"
                      v-bind="fieldInputBind('icpRecordNumber', { identifier: true })"
                      @blur="onBlur('icpRecordNumber')" @input="onInput('icpRecordNumber')" />
                    <p v-if="visibleError('icpRecordNumber')" id="site-config-error-icpRecordNumber" class="config-error">{{ errorMessage(visibleError('icpRecordNumber')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-icpRecordUrl">{{ t('admin.siteConfig.icpRecordUrl') }}</label>
                    <span id="site-config-hint-icpRecordUrl" class="config-hint">{{ t('admin.siteConfig.icpUrlHint') }}</span>
                    <ElInput id="site-config-field-icpRecordUrl" v-model="form.icpRecordUrl" placeholder="https://beian.miit.gov.cn/" :disabled="saving"
                      v-bind="fieldInputBind('icpRecordUrl', { hintId: 'site-config-hint-icpRecordUrl', identifier: true })"
                      @blur="onBlur('icpRecordUrl')" @input="onInput('icpRecordUrl')" />
                    <p v-if="visibleError('icpRecordUrl')" id="site-config-error-icpRecordUrl" class="config-error">{{ errorMessage(visibleError('icpRecordUrl')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-policeRecordNumber">{{ t('admin.siteConfig.policeRecordNumber') }}</label>
                    <ElInput id="site-config-field-policeRecordNumber" v-model="form.policeRecordNumber" :disabled="saving"
                      v-bind="fieldInputBind('policeRecordNumber', { identifier: true })"
                      @blur="onBlur('policeRecordNumber')" @input="onInput('policeRecordNumber')" />
                    <p v-if="visibleError('policeRecordNumber')" id="site-config-error-policeRecordNumber" class="config-error">{{ errorMessage(visibleError('policeRecordNumber')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-policeRecordUrl">{{ t('admin.siteConfig.policeRecordUrl') }}</label>
                    <span id="site-config-hint-policeRecordUrl" class="config-hint">{{ t('admin.siteConfig.policeUrlHint') }}</span>
                    <ElInput id="site-config-field-policeRecordUrl" v-model="form.policeRecordUrl" placeholder="https://beian.mps.gov.cn/" :disabled="saving"
                      v-bind="fieldInputBind('policeRecordUrl', { hintId: 'site-config-hint-policeRecordUrl', identifier: true })"
                      @blur="onBlur('policeRecordUrl')" @input="onInput('policeRecordUrl')" />
                    <p v-if="visibleError('policeRecordUrl')" id="site-config-error-policeRecordUrl" class="config-error">{{ errorMessage(visibleError('policeRecordUrl')!) }}</p>
                  </div>
                </div>
                <div class="config-field">
                  <label for="site-config-field-policeBadgeIconUrl">{{ t('admin.siteConfig.policeBadgeIconUrl') }}</label>
                  <span id="site-config-hint-policeBadgeIconUrl" class="config-hint">{{ t('admin.siteConfig.assetUrlHint') }}</span>
                  <ElInput id="site-config-field-policeBadgeIconUrl" v-model="form.policeBadgeIconUrl" placeholder="/assets/police-badge.png" :disabled="saving"
                    v-bind="fieldInputBind('policeBadgeIconUrl', { hintId: 'site-config-hint-policeBadgeIconUrl', identifier: true })"
                    @blur="onBlur('policeBadgeIconUrl')" @input="onInput('policeBadgeIconUrl')" />
                  <p v-if="visibleError('policeBadgeIconUrl')" id="site-config-error-policeBadgeIconUrl" class="config-error">{{ errorMessage(visibleError('policeBadgeIconUrl')!) }}</p>
                </div>
              </fieldset>

              <fieldset class="config-fieldset">
                <legend>{{ t('admin.siteConfig.operatorGroup') }}</legend>
                <div class="config-grid-2">
                  <div class="config-field">
                    <label for="site-config-field-operatorName">{{ t('admin.siteConfig.operatorName') }}</label>
                    <ElInput id="site-config-field-operatorName" v-model="form.operatorName" :disabled="saving"
                      v-bind="fieldInputBind('operatorName')"
                      @blur="onBlur('operatorName')" @input="onInput('operatorName')" />
                    <p v-if="visibleError('operatorName')" id="site-config-error-operatorName" class="config-error">{{ errorMessage(visibleError('operatorName')!) }}</p>
                  </div>
                  <div class="config-field">
                    <label for="site-config-field-contactEmail">{{ t('admin.siteConfig.contactEmail') }}</label>
                    <span id="site-config-hint-contactEmail" class="config-hint">{{ t('admin.siteConfig.contactEmailHint') }}</span>
                    <ElInput id="site-config-field-contactEmail" v-model="form.contactEmail" type="email" placeholder="contact@example.com" :disabled="saving"
                      v-bind="fieldInputBind('contactEmail', { hintId: 'site-config-hint-contactEmail', identifier: true, autocomplete: 'email' })"
                      @blur="onBlur('contactEmail')" @input="onInput('contactEmail')" />
                    <p v-if="visibleError('contactEmail')" id="site-config-error-contactEmail" class="config-error">{{ errorMessage(visibleError('contactEmail')!) }}</p>
                  </div>
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
.site-config-loading {
  display: grid;
  gap: 8px;
}

.site-config-loading p {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.site-config-form {
  display: grid;
  gap: 16px;
}

.site-config-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.site-config-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 21rem);
  gap: 24px;
  align-items: start;
  padding-block-start: 8px;
}

.site-config-fields {
  display: grid;
  gap: 18px;
  min-inline-size: 0;
}

.config-fieldset {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 10px);
  min-inline-size: 0;
}

.config-fieldset legend {
  padding-inline: 6px;
  font-size: var(--el-font-size-small);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.config-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 14px 16px;
}

.config-field {
  display: grid;
  align-content: start;
  gap: 4px;
  min-inline-size: 0;
}

.config-field label,
.config-readonly-label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.config-hint {
  margin: 0;
  font-size: var(--el-font-size-extra-small);
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}

.config-error {
  margin: 2px 0 0;
  font-size: var(--el-font-size-extra-small);
  line-height: 1.4;
  color: var(--el-color-danger);
}

.config-origin-value {
  display: block;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-regular);
  overflow-wrap: anywhere;
}

.config-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-color-picker {
  inline-size: 36px;
  block-size: 32px;
  padding: 2px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
  cursor: pointer;
  flex-shrink: 0;
}

.config-toggle-block {
  padding-block: 4px;
}

.site-config-preview-col {
  display: grid;
  gap: 14px;
  min-inline-size: 0;
}

.preview-card {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 10px);
  background: var(--el-bg-color);
}

.preview-card-title {
  margin: 0;
  font-size: var(--el-font-size-small);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.search-preview-box {
  display: grid;
  gap: 4px;
}

.search-preview-url {
  margin: 0;
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}

.search-preview-title {
  margin: 0;
  font-size: var(--el-font-size-medium);
  font-weight: 600;
  color: var(--el-color-primary);
  overflow-wrap: anywhere;
}

.search-preview-desc {
  margin: 0;
  font-size: var(--el-font-size-small);
  line-height: 1.5;
  color: var(--el-text-color-regular);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.search-preview-og {
  margin-block-start: 6px;
  inline-size: 100%;
  max-block-size: 150px;
  object-fit: cover;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-lighter);
}

.brand-preview-strip {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-lighter);
}

.brand-preview-strip--light {
  background: #ffffff;
  color: #1c1917;
}

.brand-preview-strip--dark {
  background: #141413;
  color: #f4f2ee;
}

.brand-preview-tag {
  font-size: var(--el-font-size-extra-small);
  opacity: 0.7;
}

.brand-preview-text {
  font-size: var(--el-font-size-medium);
  font-weight: 700;
  line-height: 1.25;
}

.manifest-summary-list {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: var(--el-font-size-small);
}

.manifest-summary-list > div {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.manifest-summary-list dt {
  color: var(--el-text-color-secondary);
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  font-size: var(--el-font-size-extra-small);
}

.manifest-summary-list dd {
  margin: 0;
  color: var(--el-text-color-primary);
  text-align: end;
  overflow-wrap: anywhere;
}

.manifest-swatch-val {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.manifest-swatch {
  inline-size: 14px;
  block-size: 14px;
  border-radius: 3px;
  border: 1px solid var(--el-border-color);
  flex-shrink: 0;
}

.manifest-meta {
  margin: 0;
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-secondary);
}

.manifest-link {
  font-size: var(--el-font-size-small);
  color: var(--el-color-primary);
  text-decoration: none;
}

.manifest-link:hover,
.manifest-link:focus-visible {
  text-decoration: underline;
}

.footer-preview-box {
  display: grid;
  gap: 6px;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.footer-preview-brand {
  color: var(--el-text-color-primary);
}

.footer-preview-copyright,
.footer-preview-note {
  margin: 0;
  line-height: 1.5;
}

.footer-preview-note {
  font-size: var(--el-font-size-extra-small);
}

.footer-preview-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: var(--el-font-size-extra-small);
}

.site-config-commit {
  padding-block-start: 12px;
  border-block-start: 1px solid var(--el-border-color-lighter);
}

.site-config-dirty-row {
  display: flex;
  align-items: center;
}

@media (max-width: 900px) {
  .site-config-split {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .config-grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
