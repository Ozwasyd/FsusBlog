<template>
  <FsusUiDialog
    v-model="visible"
    :title="title"
    :width="width"
    :destroy-on-close="destroyOnClose"
    :close-on-click-modal="closeOnClickModal"
    :show-close="showClose"
    :modal-class="resolvedModalClass"
    :class="fsusDialogClass"
    align-center
    append-to-body
    @close="emit('close')"
    @closed="emit('closed')"
    @opened="emit('opened')"
  >
    <div class="fsus-dialog__content">
      <slot />
    </div>
    <template v-if="$slots.footer" #footer>
      <div class="fsus-dialog__footer">
        <slot name="footer" />
      </div>
    </template>
  </FsusUiDialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FsusUiDialog, fsusDialogClass, fsusDialogModalClass } from '@/fsusui/dialog'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  width?: string | number
  destroyOnClose?: boolean
  closeOnClickModal?: boolean
  showClose?: boolean
  modalClass?: string
}>(), {
  title: '',
  width: 'min(30rem, calc(100vw - 2rem))',
  destroyOnClose: false,
  closeOnClickModal: true,
  showClose: true,
  modalClass: ''
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  close: []
  closed: []
  opened: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const resolvedModalClass = computed(() =>
  [fsusDialogModalClass, props.modalClass].filter(Boolean).join(' ')
)
</script>

<style scoped>
:global(.fsusblog-dialog-overlay) {
  box-sizing: border-box;
}

:global(.fsusblog-dialog-overlay .el-overlay-dialog) {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: clamp(1rem, 4vh, 2rem);
  overflow: auto;
}

:global(.fsusblog-dialog-overlay .fsusblog-dialog) {
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 2rem);
  max-height: calc(100dvh - 2rem);
  margin: 0 !important;
  overflow: hidden;
}

:global(.fsusblog-dialog .el-dialog__header),
:global(.fsusblog-dialog .el-dialog__footer) {
  flex: 0 0 auto;
}

:global(.fsusblog-dialog .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.fsus-dialog__content {
  min-width: 0;
}

.fsus-dialog__footer {
  border-top: 1px solid var(--fsusblog-panel-border);
  padding-top: 1.5rem;
}

@media (max-width: 639px) {
  :global(.fsusblog-dialog-overlay .el-overlay-dialog) {
    padding: 1rem;
  }

  :global(.fsusblog-dialog-overlay .fsusblog-dialog) {
    width: calc(100vw - 2rem) !important;
  }
}
</style>
