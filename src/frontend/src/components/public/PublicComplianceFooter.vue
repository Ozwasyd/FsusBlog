<template>
  <div class="public-colophon">
    <div class="public-colophon__primary">
      <p class="public-colophon__identity">
        <strong class="public-colophon__brand">{{ siteTitleText }}</strong>
        <span class="public-colophon__separator" aria-hidden="true">·</span>
        <span>
          ©<template v-if="copyrightYearText"> {{ copyrightYearText }}</template> {{ copyrightOwnerText }}。{{ copyrightNoticeText }}
        </span>
      </p>
      <a
        href="/feed/rss.xml"
        class="blog-link-state public-colophon__link public-colophon__rss"
        aria-label="打开 RSS 订阅"
      >
        RSS
      </a>
    </div>

    <div class="public-colophon__secondary">
      <p v-if="licenseText" class="public-colophon__license">
        除特别注明外，内容采用
        <a
          v-if="licenseHref"
          :href="licenseHref"
          class="blog-link-state public-colophon__link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开内容许可协议"
        >
          {{ licenseText }}
        </a>
        <span v-else>{{ licenseText }}</span>
        许可。
      </p>

      <nav class="public-colophon__policy-links" aria-label="站点政策">
        <a :href="PUBLIC_FIXED_PATHS.privacy" class="blog-link-state public-colophon__link">隐私</a>
        <a :href="PUBLIC_FIXED_PATHS.guidelines" class="blog-link-state public-colophon__link">守则</a>
        <a :href="PUBLIC_FIXED_PATHS.copyright" class="blog-link-state public-colophon__link">版权</a>
      </nav>

      <div
        v-if="recordLinks.length"
        class="public-colophon__records"
        role="group"
        aria-label="站点备案"
      >
        <a
          v-for="record in recordLinks"
          :key="record.key"
          :href="record.href"
          class="blog-link-state public-colophon__link public-colophon__record-link"
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

      <a href="#top" class="blog-link-state public-colophon__link" aria-label="回到页面顶部">回到顶部</a>
    </div>
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
