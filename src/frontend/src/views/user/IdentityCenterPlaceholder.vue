<template>
  <div class="account-page identity-center-placeholder">
    <FsusUiPageHeader
      :title="section.title"
      :content="section.description"
    />

    <FsusUiSettingsSection
      :title="placeholderCopy.cardTitle"
      :description="section.caption"
      :title-tag="'h2'"
    >
      <div class="identity-center-placeholder__body">
        <p>{{ section.body }}</p>
        <ul>
          <li v-for="item in sectionItems" :key="item">{{ item }}</li>
        </ul>
      </div>
    </FsusUiSettingsSection>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { FsusUiPageHeader } from "@/fsusui"
import { FsusUiSettingsSection } from '@/fsusui'
import { FSUSBLOG_IDENTITY_COPY } from '@/copy'

const placeholderCopy = FSUSBLOG_IDENTITY_COPY.placeholder
const sections = placeholderCopy.sections

type IdentitySectionKey = keyof typeof sections

const route = useRoute()

const section = computed(() => {
  const key = typeof route.name === 'string' && (route.name in sections)
    ? route.name as IdentitySectionKey
    : 'UserIdentityOverview'
  return sections[key]
})

const sectionItems = computed<string[]>(() => {
  try {
    const parsed = JSON.parse(section.value.items) as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
})
</script>

<style scoped>
.identity-center-placeholder__body {
  display: grid;
  gap: 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
}

.identity-center-placeholder__body ul {
  display: grid;
  gap: 0.5rem;
  padding-left: 1rem;
  color: var(--fsusblog-text-muted);
  list-style: disc;
}
</style>