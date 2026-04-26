<template>
  <div
    class="theme-mode-toggle inline-flex items-center rounded-full border border-[#E4E4E7] bg-[var(--fsus-panel-bg)]/80 p-1 text-[10px] font-bold shadow-[0_8px_24px_-20px_rgba(9,9,11,0.45)] backdrop-blur-sm transition-colors dark:border-[#27272A] dark:bg-[#0F0F11]/80"
    role="group"
    aria-label="主题模式"
  >
    <button
      v-for="option in options"
      :key="option.mode"
      type="button"
      :data-fsus-theme-mode="option.mode"
      :aria-pressed="String(isReady && mode === option.mode)"
      class="rounded-full px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
      :class="isReady && mode === option.mode
        ? 'bg-[#0F0F11] text-white dark:bg-[#F4F4F5] dark:text-[#0F0F11]'
        : 'text-[#8E8E93] hover:text-[#0F0F11] dark:text-[#A1A1AA] dark:hover:text-[#FCFCFC]'"
      @click="setThemeMode(option.mode)"
    >
      {{ compact ? option.shortLabel : option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useThemeRuntime, type ThemeMode } from '@/services/themeRuntime'

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: true
})

const { mode, setThemeMode } = useThemeRuntime()
const isReady = ref(false)

onMounted(() => {
  isReady.value = true
})

const options = computed(() => [
  { mode: 'light', label: '浅色', shortLabel: '浅' },
  { mode: 'dark', label: '深色', shortLabel: '暗' },
  { mode: 'system', label: '跟随系统', shortLabel: '系统' }
] satisfies Array<{ mode: ThemeMode; label: string; shortLabel: string }>)
</script>
