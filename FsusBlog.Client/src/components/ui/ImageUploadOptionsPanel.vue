<template>
  <el-card shadow="never" class="upload-options-panel">
    <template #header>
      <div class="upload-options-panel__header">
        <span class="upload-options-panel__title">图片上传策略</span>
        <el-button size="small" text @click="resetOptions">重置</el-button>
      </div>
    </template>

    <div class="upload-options-panel__grid">
      <el-form-item label="输出格式" class="mb-0!">
        <el-select :model-value="options.format" @update:model-value="(value) => updateOption('format', value)">
          <el-option label="WebP" value="webp" />
          <el-option label="AVIF" value="avif" />
          <el-option label="PNG" value="png" />
          <el-option label="JPEG" value="jpeg" />
          <el-option label="GIF(原格式)" value="gif" />
        </el-select>
      </el-form-item>

      <el-form-item label="质量" class="mb-0!">
        <el-slider :model-value="options.quality" :min="1" :max="100" :show-input="true" @update:model-value="(value) => updateOption('quality', value)" />
      </el-form-item>

      <el-form-item label="缩放倍率" class="mb-0!">
        <el-slider :model-value="options.scaleRatio" :min="0.1" :max="1" :step="0.05" :show-input="true" @update:model-value="(value) => updateOption('scaleRatio', value)" />
      </el-form-item>

      <el-form-item label="最大边长" class="mb-0!">
        <el-slider :model-value="options.maxEdge" :min="256" :max="4096" :step="64" :show-input="true" @update:model-value="(value) => updateOption('maxEdge', value)" />
      </el-form-item>

      <el-form-item label="透明通道" class="mb-0!">
        <el-switch :model-value="options.preserveAlpha" @update:model-value="(value) => updateOption('preserveAlpha', value)" />
      </el-form-item>

      <el-form-item label="WASM-only 模式" class="mb-0!">
        <div class="upload-options-panel__wasm-only">
          <el-switch :model-value="wasmOnly" @update:model-value="updateWasmOnly" />
          <span class="upload-options-panel__hint">仅使用 WASM codec；未支持格式会直接失败，不再回退 Canvas。</span>
        </div>
      </el-form-item>
    </div>

    <div v-if="statusText" class="upload-options-panel__status">
      <el-tag size="small" type="info" effect="light">{{ statusText }}</el-tag>
      <el-button v-if="canResume" size="small" text type="primary" @click="$emit('resume')">继续上传</el-button>
      <el-button v-if="canAbort" size="small" text type="danger" @click="$emit('abandon')">放弃上传</el-button>
    </div>

    <div v-if="preview" class="upload-options-panel__preview">
      <span>预估 {{ preview.width }}x{{ preview.height }}</span>
      <span>{{ preview.format.toUpperCase() }}</span>
      <span>{{ formatBytes(preview.originalBytes) }} -> {{ formatBytes(preview.compressedBytes) }}</span>
      <span>管线 {{ preview.pipeline }}</span>
      <span>WASM 能力 {{ preview.wasmCapability.toUpperCase() }}</span>
    </div>
    <div class="upload-options-panel__preview">
      <span>WASM codec 支持输出</span>
      <el-tag v-for="format in wasmSupportedFormatsDisplay" :key="format" size="small" type="success" effect="light">{{ format.toUpperCase() }}</el-tag>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ImageCompressionOptions } from '@/api/upload'
import type { ImageCompressionPreview } from '@/utils/imageCompression'

const props = defineProps<{
  options: ImageCompressionOptions
  statusText?: string
  canAbort?: boolean
  canResume?: boolean
  preview?: ImageCompressionPreview | null
  wasmOnly?: boolean
  wasmSupportedFormats?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:options', value: Partial<ImageCompressionOptions>): void
  (e: 'update:wasm-only', value: boolean): void
  (e: 'reset'): void
  (e: 'resume'): void
  (e: 'abandon'): void
}>()

const wasmOnly = computed(() => Boolean(props.wasmOnly))
const wasmSupportedFormatsDisplay = computed(() => {
  const declared = props.wasmSupportedFormats?.filter(Boolean) ?? []
  if (declared.length > 0) {
    return declared
  }
  return ['png']
})

function updateOption<K extends keyof ImageCompressionOptions>(key: K, value: ImageCompressionOptions[K]): void {
  emit('update:options', { [key]: value } as Partial<ImageCompressionOptions>)
}

function resetOptions(): void {
  emit('reset')
}

function updateWasmOnly(value: boolean): void {
  emit('update:wasm-only', value)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}
</script>

<style scoped>
.upload-options-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.upload-options-panel__title {
  font-weight: 700;
  color: #18181b;
}

.upload-options-panel__grid {
  display: grid;
  gap: 1rem;
}

.upload-options-panel__status,
.upload-options-panel__preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  font-size: 0.82rem;
  color: #52525b;
}

.upload-options-panel__wasm-only {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.upload-options-panel__hint {
  color: #a16207;
  font-size: 0.78rem;
  line-height: 1.3;
}

:deep(.el-slider) {
  min-width: 0;
}

:deep(.el-slider__runway) {
  min-width: 7rem;
}

:deep(.el-slider__input) {
  width: 5.5rem;
  flex: 0 0 5.5rem;
}

:deep(.el-slider__input .el-input-number),
:deep(.el-slider__input .el-input),
:deep(.el-slider__input .el-input__wrapper),
:deep(.el-slider__input .el-input__inner) {
  width: 100%;
  min-width: 4rem;
}

@media (max-width: 640px) {
  :deep(.el-slider) {
    align-items: stretch;
    flex-direction: column;
    gap: 0.75rem;
  }

  :deep(.el-slider__runway) {
    width: 100%;
    margin-right: 0;
  }

  :deep(.el-slider__input) {
    width: 100%;
    flex-basis: auto;
    margin-left: 0;
  }
}
</style>
