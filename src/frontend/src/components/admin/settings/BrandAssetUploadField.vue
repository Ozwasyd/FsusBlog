<template>
  <el-form-item :label="label">
    <div class="brand-asset-upload-field min-w-0 space-y-3">
      <el-upload
        class="brand-asset-upload-field__upload"
        action="#"
        :http-request="handleUpload"
        :show-file-list="false"
        :disabled="disabled || uploading"
        :accept="accept"
      >
        <div
          v-loading="uploading"
          class="brand-asset-upload-field__preview group"
          :class="`brand-asset-upload-field__preview--${previewVariant}`"
        >
          <img
            v-if="hasPreviewCandidate"
            :src="previewUrl"
            :alt="`${label}预览`"
            class="brand-asset-upload-field__image"
            :class="{ 'brand-asset-upload-field__image--loaded': previewLoaded }"
            @load="handlePreviewLoad"
            @error="handlePreviewError"
          />
          <button
            v-if="!canShowPreview"
            type="button"
            class="brand-asset-upload-field__empty"
            :aria-label="uploadText"
          >
            <el-icon :size="18" aria-hidden="true"><Plus /></el-icon>
            <span>{{ uploadText }}</span>
          </button>
          <div
            v-if="canShowPreview"
            class="image-replace-overlay absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 flex items-center justify-center"
          >
            <span class="text-xs font-medium normal-case tracking-normal">点击更换</span>
          </div>
        </div>
      </el-upload>
      <el-input
        class="min-w-0 flex-1"
        :model-value="modelValue"
        maxlength="256"
        :disabled="disabled"
        :placeholder="placeholder"
        @update:model-value="updateValue"
      />
    </div>
    <slot />
  </el-form-item>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { type UploadRequestOptions } from '@ozwasyd/element-plus'
import { Plus } from '@/fsusui/icons'

const props = withDefaults(defineProps<{
  label: string
  modelValue: string
  targetField: string
  disabled?: boolean
  uploading?: boolean
  placeholder?: string
  previewUrl?: string
  previewVariant?: 'wide' | 'logo' | 'icon'
  accept?: string
  uploadText?: string
}>(), {
  disabled: false,
  uploading: false,
  placeholder: '',
  previewUrl: '',
  previewVariant: 'logo',
  accept: 'image/png,image/jpeg,image/webp',
  uploadText: '上传'
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'upload', options: UploadRequestOptions, targetField: string): void
}>()

const previewLoaded = ref(false)
const previewFailed = ref(false)
const hasPreviewCandidate = computed(() => Boolean(props.previewUrl) && !previewFailed.value)
const canShowPreview = computed(() => hasPreviewCandidate.value && previewLoaded.value)

watch(() => props.previewUrl, () => {
  previewLoaded.value = false
  previewFailed.value = false
})

const updateValue = (value: string | number): void => {
  emit('update:modelValue', String(value))
}

const handleUpload = async (options: UploadRequestOptions): Promise<void> => {
  emit('upload', options, props.targetField)
}

const handlePreviewLoad = (): void => {
  previewLoaded.value = true
  previewFailed.value = false
}

const handlePreviewError = (): void => {
  previewLoaded.value = false
  previewFailed.value = true
}
</script>

<style scoped>
.brand-asset-upload-field__upload {
  display: block;
  width: 100%;
}

.brand-asset-upload-field__preview {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border-strong);
  border-radius: var(--fsus-radius-popover);
  background: var(--fsusblog-page-bg);
  transition:
    background-color var(--blog-motion-fast) var(--blog-motion-ease),
    border-color var(--blog-motion-fast) var(--blog-motion-ease),
    opacity var(--blog-motion-fast) var(--blog-motion-ease);
}

.brand-asset-upload-field__preview:hover {
  border-color: var(--fsusblog-color-primary);
}

.brand-asset-upload-field__preview--wide {
  aspect-ratio: 16 / 9;
}

.brand-asset-upload-field__preview--logo {
  aspect-ratio: 5 / 2;
  min-height: 5.5rem;
}

.brand-asset-upload-field__preview--icon {
  aspect-ratio: 1 / 1;
  max-width: 8rem;
}

.brand-asset-upload-field__image {
  max-height: 78%;
  max-width: 86%;
  opacity: 0;
  object-fit: contain;
}

.brand-asset-upload-field__image--loaded {
  opacity: 1;
}

.brand-asset-upload-field__empty {
  display: flex;
  min-height: 4.5rem;
  width: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--fsus-space-2);
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.image-replace-overlay {
  background: var(--fsus-overlay-color, transparent);
  color: var(--fsusblog-page-bg);
}
</style>
