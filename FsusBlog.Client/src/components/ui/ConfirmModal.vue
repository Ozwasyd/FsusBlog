<template>
  <Teleport to="body">
    <transition 
      name="modal-fade" 
      @after-enter="handleAfterEnter"
      @after-leave="handleAfterLeave"
    >
      <div 
        v-if="visible" 
        id="confirm-modal-overlay"
        class="fixed inset-0 z-400 flex items-center justify-center px-4 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-content"
        @keydown="handleTabKey"
      >
        <div 
          class="absolute inset-0 bg-white/80 backdrop-blur-sm transition-opacity" 
          @click.self="handleCancel"
        ></div>

        <div 
          ref="modalContainer"
          class="relative w-full max-w-sm bg-white border border-zinc-100 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] rounded-2xl p-6 sm:p-8 transform transition-all animate-in fade-in zoom-in-95 duration-300"
        >
          <h3 
            id="confirm-modal-title"
            class="text-lg font-bold text-zinc-950 tracking-tight mb-2"
          >
            {{ title || '确认操作' }}
          </h3>
          <p 
            id="confirm-modal-content"
            class="text-sm text-zinc-500 leading-relaxed mb-8"
          >
            {{ content || '此操作无法撤销，请谨慎处理。' }}
          </p>

          <div class="flex gap-3 justify-end">
            <button 
              type="button"
              @click="handleCancel"
              class="px-5 py-2.5 text-[11px] font-bold text-zinc-400 hover:text-zinc-600 uppercase tracking-widest transition-colors outline-none focus-visible:ring-2 focus-visible:ring-zinc-200 rounded-md"
            >
              取消
            </button>
            <button 
              type="button"
              ref="confirmBtn"
              @click="handleConfirm"
              class="px-6 py-2.5 bg-zinc-950 text-white text-[11px] font-bold uppercase tracking-widest rounded-lg hover:bg-zinc-800 active:scale-95 transition-all shadow-lg shadow-zinc-200 outline-none focus:ring-2 focus:ring-zinc-950 focus:ring-offset-2"
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
import { ref, watch, onUnmounted } from 'vue'
import { useSiteStore } from '@/store/site'

const props = defineProps<{
  visible: boolean
  title?: string
  content?: string
}>()

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])

const siteStore = useSiteStore()

// 引用管理
const modalContainer = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
let previousActiveElement: HTMLElement | null = null

const handleCancel = () => {
  emit('update:visible', false)
  emit('cancel')
}

const handleConfirm = () => {
  emit('update:visible', false)
  emit('confirm')
}

/**
 * 辅助方法：获取可聚焦元素
 */
const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(el => {
    const isVisible = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
    const isNotDisabled = !(el as any).disabled;
    return isVisible && isNotDisabled;
  });
};

/**
 * [修复 2026-02-23] P0 修复：Focus Trap 逻辑
 * 核心修复 TS 18048: 通过对 first/last 进行显式真值校验，消除索引访问的潜在 undefined 风险
 */
const handleTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !modalContainer.value) return;

    const focusables = getFocusableElements(modalContainer.value);
    
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // 类型收窄：物理保证元素存在后再处理焦点流转
    if (!first || !last) return;

    if (e.shiftKey) {
        if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
        }
    } else {
        if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
        }
    }
};

const handleAfterEnter = () => {
    confirmBtn.value?.focus();
}

const handleAfterLeave = () => {
    // 生命周期占位
}

const handleGlobalKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.visible) {
    handleCancel()
  }
}

/**
 * [修复 2026-02-23] P0 修复：ARIA 隔离
 */
const toggleBackgroundInert = (isInert: boolean) => {
    const root = document.getElementById('app');
    if (!root) return;
    if (isInert) {
        root.setAttribute('aria-hidden', 'true');
        if ('inert' in root) (root as any).inert = true;
    } else {
        root.removeAttribute('aria-hidden');
        if ('inert' in root) (root as any).inert = false;
    }
};

/**
 * 监听器：状态协调
 */
watch(() => props.visible, (val) => {
  if (val) {
    previousActiveElement = document.activeElement as HTMLElement;
    siteStore.lockScroll();
    toggleBackgroundInert(true);
    window.addEventListener('keydown', handleGlobalKeyDown);
  } else {
    siteStore.unlockScroll();
    toggleBackgroundInert(false);
    window.removeEventListener('keydown', handleGlobalKeyDown);
    
    if (previousActiveElement && document.contains(previousActiveElement)) {
        previousActiveElement.focus();
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown);
  toggleBackgroundInert(false);
  siteStore.forceUnlockScroll();
})
</script>

<style scoped>
@reference "@/assets/main.css";

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