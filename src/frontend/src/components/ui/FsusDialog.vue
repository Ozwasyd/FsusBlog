<template>
  <FsusUiDialog
    v-model="visible"
    :title="title"
    :width="resolvedWidth"
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
import {
  FsusUiDialog,
  fsusDialogClass,
  fsusDialogModalClass,
  fsusDialogWidths,
  isFsusDialogWidth,
  type FsusDialogWidth
} from '@/fsusui/dialog'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  width?: FsusDialogWidth
  destroyOnClose?: boolean
  closeOnClickModal?: boolean
  showClose?: boolean
  modalClass?: string
}>(), {
  title: '',
  width: fsusDialogWidths.default,
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

const resolvedWidth = computed<FsusDialogWidth>(() =>
  isFsusDialogWidth(props.width) ? props.width : fsusDialogWidths.default
)

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
  padding: var(--fsus-space-4);
  overflow: auto;
}

:global(.fsusblog-dialog-overlay .fsusblog-dialog) {
  --el-dialog-padding-primary: var(--fsus-space-6);
  display: flex;
  flex-direction: column;
  max-width: var(--fsus-dialog-mobile-max-width);
  max-height: calc(100dvh - var(--fsus-space-8));
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
</style>
