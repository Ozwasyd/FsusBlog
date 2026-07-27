<template>
  <FsusUiDialog
    v-model="visible"
    :title="title"
    :width="resolvedWidth"
    :destroy-on-close="destroyOnClose"
    :close-on-click-modal="closeOnClickModal"
    :show-close="showClose"
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
}>(), {
  title: '',
  width: fsusDialogWidths.default,
  destroyOnClose: false,
  closeOnClickModal: true,
  showClose: true
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
</script>

<style scoped>
.fsus-dialog__content {
  min-width: 0;
}
</style>
