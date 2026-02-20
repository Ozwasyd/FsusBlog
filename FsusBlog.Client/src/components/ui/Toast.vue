<template>
  <Transition name="toast-slide" @after-leave="destroy">
    <div 
      v-if="visible" 
      class="fixed top-8 left-0 right-0 z-9999 pointer-events-none flex justify-center subpixel-antialiased"
    >
      <div 
        @click="handleClick"
        :class="[
          'flex items-center gap-4 px-6 py-4 bg-zinc-950 text-white shadow-2xl max-w-sm w-full mx-4 sm:w-auto sm:min-w-75 transition-all',
          onClick ? 'pointer-events-auto cursor-pointer hover:bg-zinc-900 active:scale-95' : 'pointer-events-none'
        ]"
      >
        <span :class="['text-[10px] font-mono font-bold tracking-[0.2em] shrink-0', typeColor]">
          {{ typePrefix }}
        </span>
        
        <span class="text-xs font-medium tracking-wide leading-snug truncate max-w-50 sm:max-w-xs">
          {{ displayMessage }}
        </span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

const props = defineProps<{
  message: string
  type?: 'success' | 'error' | 'info' | 'article'
  duration?: number
  onClick?: () => void
  onDestroy?: () => void
}>()

const visible = ref(false)

// 🌟 企划要求：针对长标题采取核心保留+末尾截断 (Max 25 字符)
const displayMessage = computed(() => {
  if (props.type === 'article' && props.message.length > 25) {
    return props.message.slice(0, 25) + '...'
  }
  return props.message
})

const typePrefix = computed(() => {
  switch (props.type) {
    case 'success': return '[ OK ]'
    case 'error': return '[ 错误 ]'
    case 'article': return '[ NEW ]'
    default: return '[ 通知 ]'
  }
})

const typeColor = computed(() => {
  switch (props.type) {
    case 'error': return 'text-red-500'
    case 'article': return 'text-amber-400' // 文章推送使用明亮的琥珀色点缀
    default: return 'text-zinc-400'
  }
})

const handleClick = () => {
  if (props.onClick) {
    props.onClick()
    visible.value = false // 点击后立即消失
  }
}

onMounted(() => {
  visible.value = true
  setTimeout(() => { visible.value = false }, props.duration || 3000)
})

const destroy = () => { if (props.onDestroy) props.onDestroy() }
</script>

<style scoped>
.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: opacity 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  will-change: transform, opacity;
}
.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>