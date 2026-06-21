<template>
  <FsusUiSectionNav
    :items="sectionNavItems"
    :aria-label="ariaLabel"
    :density="density"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter, type RouteRecordName } from 'vue-router'
import { FsusUiSectionNav } from '@/fsusui'

export type AdminSystemTab = {
  label: string
  name: RouteRecordName
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  items: readonly AdminSystemTab[]
  ariaLabel?: string
  density?: 'default' | 'compact'
}>(), {
  ariaLabel: '系统栏目',
  density: 'default'
})

const route = useRoute()
const router = useRouter()

const sectionNavItems = computed(() =>
  props.items.map((item) => ({
    key: String(item.name),
    label: item.label,
    href: router.resolve({ name: item.name }).href,
    current: route.name === item.name,
    disabled: item.disabled
  }))
)
</script>
