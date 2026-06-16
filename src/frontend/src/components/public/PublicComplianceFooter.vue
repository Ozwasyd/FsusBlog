<template>
  <div class="flex flex-col gap-8 text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
    <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 space-y-3">
        <div class="text-[1.25rem] font-bold tracking-normal text-[var(--fsusblog-text-primary)]">
          {{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
        </div>
        <p class="leading-relaxed">
          © {{ copyrightYearText }} {{ copyrightOwnerText }}。{{ copyrightNoticeText }}
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
      <a :href="PUBLIC_FIXED_PATHS.archive" class="blog-link-state inline-flex min-h-10 items-center">归档</a>
      <a :href="PUBLIC_FIXED_PATHS.about" class="blog-link-state inline-flex min-h-10 items-center">关于</a>
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
import { Top } from '@/fsusui/icons'

const props = defineProps<{
  siteTitle: string
  compliance?: SiteComplianceConfigPublic | null
  renderYear?: number | null
}>()

const currentYear = computed(() => Number.isInteger(props.renderYear) ? Number(props.renderYear) : new Date().getFullYear())
const siteTitleText = computed(() => props.siteTitle.trim() || '站点')
const isComplianceEnabled = computed(() => Boolean(props.compliance?.enabled))
const copyrightOwnerText = computed(() => props.compliance?.copyrightOwner?.trim() || siteTitleText.value)
const copyrightNoticeText = computed(() => {
  const text = props.compliance?.copyrightText?.trim()
  return isComplianceEnabled.value && text ? text : '保留所有权利。'
})
const copyrightYearText = computed(() => {
  const startYear = props.compliance?.copyrightStartYear
  if (isComplianceEnabled.value && startYear && startYear < currentYear.value) {
    return `${startYear}-${currentYear.value}`
  }
  return `${currentYear.value}`
})
const licenseText = computed(() => {
  const value = props.compliance?.contentLicenseName?.trim()
  return isComplianceEnabled.value && value ? value : ''
})
const licenseHref = computed(() => {
  const value = props.compliance?.contentLicenseUrl?.trim()
  return value && /^https?:\/\//u.test(value) ? value : ''
})

const recordLinks = computed(() => {
  if (!isComplianceEnabled.value || !props.compliance) {
    return []
  }

  const records: Array<{
    key: string
    label: string
    href: string
    ariaLabel: string
    icon?: string
  }> = []
  const icpNumber = props.compliance.icpRecordNumber.trim()
  const policeNumber = props.compliance.policeRecordNumber.trim()

  if (icpNumber) {
    records.push({
      key: 'icp',
      label: icpNumber,
      href: props.compliance.icpRecordUrl.trim() || 'https://beian.miit.gov.cn/',
      ariaLabel: '打开工信部备案系统'
    })
  }

  if (policeNumber) {
    records.push({
      key: 'police',
      label: policeNumber,
      href: props.compliance.policeRecordUrl.trim() || 'https://beian.mps.gov.cn/',
      ariaLabel: '打开公安备案平台',
      icon: props.compliance.policeBadgeIconUrl.trim() || undefined
    })
  }

  return records
})
</script>
