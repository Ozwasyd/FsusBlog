<template>
  <Transition name="toast-slide" @after-leave="handleAfterLeave">
    <div 
      v-if="visible" 
      class="w-full flex justify-center subpixel-antialiased pointer-events-none mt-6 sm:mt-10"
      :role="type === 'error' ? 'alert' : 'status'"
      :aria-live="type === 'error' ? 'assertive' : 'polite'"
      aria-atomic="true"
    >
      <div 
        ref="toastEl"
        @click="handleClick"
        @keydown.enter.space.prevent="handleClick"
        :tabindex="onClick ? 0 : -1"
        :class="[
          'flex items-center gap-4 px-6 py-4 bg-zinc-950 text-white shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] border border-zinc-800/50 max-w-sm w-full mx-4 sm:w-auto sm:min-w-[18rem] transition-all outline-none',
          onClick ? 'pointer-events-auto cursor-pointer hover:bg-zinc-900 active:scale-95 focus-visible:ring-2 focus-visible:ring-zinc-400' : 'pointer-events-none'
        ]"
      >
        <span :class="['text-[10px] font-mono font-black tracking-[0.2em] shrink-0 uppercase', typeColor]">
          {{ typePrefix }}
        </span>
        
        <span class="text-[11px] font-medium tracking-wide leading-snug truncate max-w-48 sm:max-w-xs">
          {{ displayMessage }}
        </span>

        <span v-if="onClick" class="ml-auto text-zinc-500 text-[10px]" aria-hidden="true">→</span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue' // [修复 2026-02-23] 移除 defineExpose 的导入，消除 TS 2440 冲突

const props = defineProps<{
  message: string
  type?: 'success' | 'error' | 'info' | 'article'
  duration?: number
  onClick?: () => void
  onDestroy?: () => void
}>()

const visible = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * [修复 2026-02-23] 逻辑自洽：暴露隐藏句柄
 * 注意：在 script setup 中直接使用 defineExpose 全局宏
 */
const hide = () => {
  visible.value = false
}

defineExpose({ hide })

const displayMessage = computed(() => {
  const msg = String(props.message || '')
  if (props.type === 'article' && msg.length > 30) {
    return msg.slice(0, 30) + '...'
  }
  return msg
})

const typePrefix = computed(() => {
  switch (props.type) {
    case 'success': return 'DONE'
    case 'error': return 'FAIL'
    case 'article': return 'NEW'
    default: return 'INFO'
  }
})

const typeColor = computed(() => {
  switch (props.type) {
    case 'error': return 'text-red-500'
    case 'article': return 'text-amber-400'
    default: return 'text-zinc-500'
  }
})

const handleClick = () => {
  if (props.onClick) {
    props.onClick()
    hide()
  }
}

onMounted(() => {
  // 性能优化：确保在下一帧开始动画
  requestAnimationFrame(() => {
    visible.value = true
  })

  if (props.duration !== 0) {
    timer = setTimeout(hide, props.duration || 3000)
  }
})

onUnmounted(() => {
  if (timer) clearTimeout(timer)
})

const handleAfterLeave = () => { 
  if (props.onDestroy) props.onDestroy() 
}
</script>

<style scoped>
.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
}

.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.98);
}
</style>