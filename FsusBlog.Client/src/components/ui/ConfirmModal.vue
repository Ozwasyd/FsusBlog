<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div 
        v-if="visible" 
        class="fixed inset-0 z-999 flex items-center justify-center sm:items-center px-4"
        role="dialog"
        aria-modal="true"
      >
        <div class="absolute inset-0 bg-white/80 backdrop-blur-sm transition-opacity" @click="handleCancel"></div>

        <div class="relative w-full max-w-sm bg-white border border-zinc-100 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] rounded-2xl p-6 sm:p-8 transform transition-all">
          <h3 class="text-lg font-bold text-zinc-950 tracking-tight mb-2">
            {{ title || '确认操作' }}
          </h3>
          <p class="text-sm text-zinc-500 leading-relaxed mb-8">
            {{ content || '此操作无法撤销，请谨慎处理。' }}
          </p>

          <div class="flex gap-3 justify-end">
            <button 
              @click="handleCancel"
              class="px-5 py-2.5 text-[11px] font-bold text-zinc-400 hover:text-zinc-600 uppercase tracking-widest transition-colors"
            >
              取消
            </button>
            <button 
              @click="handleConfirm"
              class="px-6 py-2.5 bg-zinc-950 text-white text-[11px] font-bold uppercase tracking-widest rounded-lg hover:bg-zinc-800 active:scale-95 transition-all shadow-lg shadow-zinc-200"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { watch, onUnmounted } from 'vue'

const props = defineProps<{
  visible: boolean
  title?: string
  content?: string
}>()

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])

const handleCancel = () => {
  emit('update:visible', false)
  emit('cancel')
}

const handleConfirm = () => {
  emit('update:visible', false)
  emit('confirm')
}

// 滚动锁定逻辑
watch(() => props.visible, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.removeProperty('overflow')
  }
})

onUnmounted(() => {
  document.body.style.removeProperty('overflow')
})
</script>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.3s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .relative,
.modal-fade-leave-active .relative {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
}

.modal-fade-enter-from .relative,
.modal-fade-leave-to .relative {
  opacity: 0;
  transform: scale(0.95) translateY(10px);
}
</style>