<template>
  <div class="upload-options-panel-minimal">
    <header class="flex items-center justify-between mb-10 pb-4 border-b border-[var(--fsusblog-panel-border)]">
      <h3 class="section-title section-title--inline">上传与输出策略</h3>
      <el-button
        type="primary"
        plain
        size="small"
        @click="resetOptions"
      >
        Reset
      </el-button>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-16 gap-y-10">
      <el-form-item label="输出格式">
        <el-select
          :model-value="options.format"
          @update:model-value="updateFormat"
        >
          <el-option label="WebP" value="webp" />
          <el-option label="AVIF" value="avif" />
          <el-option label="PNG" value="png" />
          <el-option label="JPEG" value="jpeg" />
          <el-option label="GIF (Original)" value="gif" />
        </el-select>
      </el-form-item>

      <el-form-item label="压缩质量">
        <el-slider
          :model-value="options.quality"
          :min="1"
          :max="100"
          :show-input="true"
          @update:model-value="updateQuality"
        />
      </el-form-item>

      <el-form-item label="缩放倍率">
        <el-slider
          :model-value="options.scaleRatio"
          :min="0.1"
          :max="1"
          :step="0.05"
          :show-input="true"
          @update:model-value="updateScaleRatio"
        />
      </el-form-item>

      <el-form-item label="最大边长">
        <el-slider
          :model-value="options.maxEdge"
          :min="256"
          :max="4096"
          :step="64"
          :show-input="true"
          @update:model-value="updateMaxEdge"
        />
      </el-form-item>

      <div class="flex flex-col gap-8 lg:col-span-2">
        <div class="flex items-center justify-between py-4 border-y border-[var(--fsusblog-panel-border)]">
          <div>
            <div class="text-[11px] font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">透明通道 (Alpha Channel)</div>
            <p class="text-[12px] text-[var(--fsusblog-text-tertiary)] mt-1">保留图片原始透明度信息。</p>
          </div>
          <el-switch :model-value="options.preserveAlpha" @update:model-value="updatePreserveAlpha" />
        </div>

        <div class="flex items-center justify-between py-4 border-b border-[var(--fsusblog-panel-border)]">
          <div>
            <div class="text-[11px] font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">WASM-only 模式</div>
            <p class="text-[12px] text-[var(--fsusblog-color-warning-text)] mt-1 italic">仅使用 WASM codec；不支持时直接报错。</p>
          </div>
          <el-switch :model-value="wasmOnly" @update:model-value="updateWasmOnly" />
        </div>
      </div>
    </div>

    <!-- 状态与预览 -->
    <footer class="mt-12 space-y-6">
      <div v-if="statusText" class="flex items-center gap-4 py-3 px-4 bg-[var(--fsusblog-page-bg)] border border-[var(--fsusblog-panel-border-strong)] rounded-[var(--fsus-radius-control)]">
        <span class="text-[10px] tabular-nums font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">{{ statusText }}</span>
        <el-button v-if="canResume" link type="primary" @click="$emit('resume')">Resume</el-button>
        <el-button v-if="canAbort" link type="danger" @click="$emit('abandon')">Abort</el-button>
      </div>

      <div v-if="preview" class="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-6 border-t border-[var(--fsusblog-panel-border)]">
        <div class="preview-metric">
          <label>Estimated</label>
          <span>{{ preview.width }} × {{ preview.height }}</span>
        </div>
        <div class="preview-metric">
          <label>Format</label>
          <span>{{ preview.format.toUpperCase() }}</span>
        </div>
        <div class="preview-metric">
          <label>Size Change</label>
          <span class="tabular-nums">{{ formatBytes(preview.originalBytes) }} → {{ formatBytes(preview.compressedBytes) }}</span>
        </div>
        <div class="preview-metric">
          <label>Pipeline</label>
          <span>{{ preview.pipeline }}</span>
        </div>
        <div class="preview-metric">
          <label>Capability</label>
          <span class="text-[var(--fsusblog-text-primary)]">{{ preview.wasmCapability.toUpperCase() }}</span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] tabular-nums">
        <span class="font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">WASM Support:</span>
        <div class="flex gap-2">
          <span
            v-for="format in wasmSupportedFormatsDisplay"
            :key="format"
            class="px-2 py-0.5 border border-[var(--fsusblog-panel-border)] text-[var(--fsusblog-text-secondary)] rounded-[var(--fsus-radius-control-small)] normal-case"
          >
            {{ format }}
          </span>
        </div>
      </div>
    </footer>
  </div>
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

function updateFormat(value: string | number | boolean): void {
  if (value === 'webp' || value === 'avif' || value === 'png' || value === 'jpeg' || value === 'gif') {
    updateOption('format', value)
  }
}

function updateQuality(value: string | number | boolean): void {
  updateOption('quality', Number(value))
}

function updateScaleRatio(value: string | number | boolean): void {
  updateOption('scaleRatio', Number(value))
}

function updateMaxEdge(value: string | number | boolean): void {
  updateOption('maxEdge', Number(value))
}

function updatePreserveAlpha(value: string | number | boolean): void {
  updateOption('preserveAlpha', Boolean(value))
}

function resetOptions(): void {
  emit('reset')
}

function updateWasmOnly(value: string | number | boolean): void {
  emit('update:wasm-only', Boolean(value))
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}
</script>

<style scoped>
@reference "@/assets/main.css";

.section-title {
  @apply text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-primary)] normal-case;
  position: relative;
}

.section-title::before {
  content: "";
  @apply absolute bottom-[-4px] left-0 h-[2px] w-6 bg-[var(--fsusblog-text-primary)];
}

.section-title--inline {
  @apply mb-0 border-none pb-0;
}

.preview-metric {
  @apply flex flex-col gap-1;
}

.preview-metric label {
  @apply text-[9px] font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal;
}

.preview-metric span {
  @apply text-[12px] tabular-nums font-medium text-[var(--fsusblog-text-primary)];
}

</style>
