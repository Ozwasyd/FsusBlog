<template>
  <div class="flex flex-col gap-8 text-xs font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
    <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 space-y-3">
        <div class="text-[1.25rem] font-bold tracking-normal text-[var(--fsusblog-text-primary)]">
          {{ siteTitleText }}
        </div>
        <p class="leading-relaxed">
          ©<template v-if="copyrightYearText"> {{ copyrightYearText }}</template> {{ copyrightOwnerText }}。{{ copyrightNoticeText }}
        </p>
        <p v-if="licenseText" class="leading-relaxed">
          除特别注明外，本站内容采用
          <a
            v-if="licenseHref"
            :href="licenseHref"
            class="blog-link-state inline-flex min-h-10 items-center"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="打开内容许可协议"
          >
            {{ licenseText }}
          </a>
          <span v-else>{{ licenseText }}</span>
          许可协议。
        </p>
      </div>

      <div v-if="recordLinks.length" class="flex flex-col items-start gap-2 sm:items-end">
        <a
          v-for="record in recordLinks"
          :key="record.key"
          :href="record.href"
          class="blog-link-state inline-flex min-h-10 max-w-full items-center gap-2 break-all"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="record.ariaLabel"
        >
          <img
            v-if="record.icon"
            :src="record.icon"
            alt="公安备案"
            class="h-4 w-4 shrink-0 object-contain"
            width="16"
            height="16"
            loading="lazy"
            decoding="async"
          />
          <span>{{ record.label }}</span>
        </a>
      </div>
    </div>

    <nav class="flex flex-wrap gap-x-8 gap-y-2" aria-label="站点页脚导航">
      <a :href="PUBLIC_FIXED_PATHS.privacy" class="blog-link-state inline-flex min-h-10 items-center">隐私政策</a>
      <a :href="PUBLIC_FIXED_PATHS.guidelines" class="blog-link-state inline-flex min-h-10 items-center">用户守则</a>
      <a :href="PUBLIC_FIXED_PATHS.copyright" class="blog-link-state inline-flex min-h-10 items-center">版权声明</a>
      <a href="/feed/rss.xml" class="blog-link-state inline-flex min-h-10 items-center" aria-label="打开 RSS 订阅">RSS 订阅</a>
      <a href="#top" class="blog-link-state inline-flex min-h-10 items-center gap-2 group" aria-label="回到页面顶部">
        回到顶部 <el-icon class="transition-transform" aria-hidden="true"><Top /></el-icon>
      </a>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SiteComplianceConfigPublic } from '@/api/system'
import { PUBLIC_FIXED_PATHS } from '@/public-renderers/publicRoutePaths'
import {
  normalizePublicComplianceConfig,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'
import { Top } from '@/fsusui/icons'

const props = defineProps<{
  siteTitle: string
  compliance?: SiteComplianceConfigPublic | null
  renderYear?: number | null
}>()

const currentYear = computed(() => {
  const renderYear = Number(props.renderYear)
  return Number.isInteger(renderYear) && renderYear > 0 ? renderYear : null
})
const normalizedCompliance = computed(() => normalizePublicComplianceConfig(props.compliance))
const siteTitleText = computed(() => normalizePublicSiteTitle(props.siteTitle))
const isComplianceEnabled = computed(() => Boolean(normalizedCompliance.value?.enabled))
const copyrightOwnerText = computed(() => normalizedCompliance.value?.copyrightOwner || siteTitleText.value)
const copyrightNoticeText = computed(() => {
  const text = normalizedCompliance.value?.copyrightText
  return isComplianceEnabled.value && text ? text : '保留所有权利。'
})
const copyrightYearText = computed(() => {
  const startYear = normalizedCompliance.value?.copyrightStartYear
  const renderYear = currentYear.value
  if (!renderYear) {
    return ''
  }

  if (isComplianceEnabled.value && startYear && startYear < renderYear) {
    return `${startYear}-${renderYear}`
  }
  return `${renderYear}`
})
const licenseText = computed(() => {
  const value = normalizedCompliance.value?.contentLicenseName
  return isComplianceEnabled.value && value ? value : ''
})
const licenseHref = computed(() => {
  const value = normalizedCompliance.value?.contentLicenseUrl
  return value && /^https?:\/\//u.test(value) ? value : ''
})

const recordLinks = computed(() => {
  const compliance = normalizedCompliance.value
  if (!isComplianceEnabled.value || !compliance) {
    return []
  }

  const records: Array<{
    key: string
    label: string
    href: string
    ariaLabel: string
    icon?: string
  }> = []
  const icpNumber = compliance.icpRecordNumber
  const policeNumber = compliance.policeRecordNumber

  if (icpNumber) {
    records.push({
      key: 'icp',
      label: icpNumber,
      href: compliance.icpRecordUrl,
      ariaLabel: '打开工信部备案系统'
    })
  }

  if (policeNumber) {
    records.push({
      key: 'police',
      label: policeNumber,
      href: compliance.policeRecordUrl,
      ariaLabel: '打开公安备案平台',
      icon: compliance.policeBadgeIconUrl || undefined
    })
  }

  return records
})
</script>
