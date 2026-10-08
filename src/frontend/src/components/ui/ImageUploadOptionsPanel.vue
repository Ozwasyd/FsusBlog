<template>
    <div class="upload-options-panel-minimal">
        <slot
            name="header"
            :reset="resetOptions"
        >
            <FsusUiSectionHeader
                title="上传与输出策略"
                title-tag="h3"
            >
                <template #actions>
                    <ElButton
                        type="primary"
                        plain
                        size="small"
                        @click="resetOptions"
                    >
                        重置
                    </ElButton>
                </template>
            </FsusUiSectionHeader>
        </slot>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-[var(--fsus-space-6)] gap-y-[var(--fsus-space-4)]">
            <ElFormItem label="输出格式">
                <ElSelect
                    :model-value="options.format"
                    @update:model-value="updateFormat"
                >
                    <ElOption
                        label="WebP"
                        value="webp"
                    />
                    <ElOption
                        label="AVIF"
                        value="avif"
                    />
                    <ElOption
                        label="PNG"
                        value="png"
                    />
                    <ElOption
                        label="JPEG"
                        value="jpeg"
                    />
                    <ElOption
                        label="GIF（原图）"
                        value="gif"
                    />
                </ElSelect>
            </ElFormItem>

            <ElFormItem label="压缩质量">
                <div class="upload-options-value-group">
                    <ElSlider
                        :model-value="options.quality"
                        :min="1"
                        :max="100"
                        @update:model-value="updateQuality"
                    />
                    <ElInputNumber
                        class="upload-options-value-input"
                        :model-value="options.quality"
                        :min="1"
                        :max="100"
                        label="压缩质量"
                        @update:model-value="updateQuality"
                    />
                </div>
            </ElFormItem>

            <ElFormItem label="缩放倍率">
                <div class="upload-options-value-group">
                    <ElSlider
                        :model-value="options.scaleRatio"
                        :min="0.1"
                        :max="1"
                        :step="0.05"
                        @update:model-value="updateScaleRatio"
                    />
                    <ElInputNumber
                        class="upload-options-value-input"
                        :model-value="options.scaleRatio"
                        :min="0.1"
                        :max="1"
                        :step="0.05"
                        label="缩放倍率"
                        @update:model-value="updateScaleRatio"
                    />
                </div>
            </ElFormItem>

            <ElFormItem label="最大边长">
                <div class="upload-options-value-group">
                    <ElSlider
                        :model-value="options.maxEdge"
                        :min="256"
                        :max="4096"
                        :step="64"
                        @update:model-value="updateMaxEdge"
                    />
                    <ElInputNumber
                        class="upload-options-value-input"
                        :model-value="options.maxEdge"
                        :min="256"
                        :max="4096"
                        :step="64"
                        label="最大边长"
                        @update:model-value="updateMaxEdge"
                    />
                </div>
            </ElFormItem>

            <div class="flex flex-col gap-8 lg:col-span-2">
                <div class="flex items-center justify-between py-4 border-y border-[var(--fsusblog-panel-border)]">
                    <div>
                        <div class="text-xs font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">透明通道 (Alpha Channel)</div>
                        <p class="text-xs text-[var(--fsusblog-text-tertiary)] mt-1">保留图片原始透明度信息。</p>
                    </div>
                    <ElSwitch
                        :model-value="options.preserveAlpha"
                        @update:model-value="updatePreserveAlpha"
                    />
                </div>

                <div class="flex items-center justify-between py-4 border-b border-[var(--fsusblog-panel-border)]">
                    <div>
                        <div class="text-xs font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">WASM-only 模式</div>
                        <p class="text-xs text-[var(--fsusblog-color-warning-text)] mt-1 italic">仅使用 WASM codec；不支持时直接报错。</p>
                    </div>
                    <ElSwitch
                        :model-value="wasmOnly"
                        @update:model-value="updateWasmOnly"
                    />
                </div>
            </div>
        </div>

        <!-- 状态与预览 -->
        <footer class="mt-6 space-y-4">
            <div
                v-if="statusText"
                class="flex items-center gap-4 py-3 px-4 bg-[var(--fsusblog-page-bg)] border border-[var(--fsusblog-panel-border-strong)] rounded-[var(--fsus-radius-control)]"
            >
                <span class="text-xs tabular-nums font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">{{ statusText }}</span>
                <ElButton
                    v-if="canResume"
                    link
                    type="primary"
                    @click="$emit('resume')"
                >继续上传</ElButton>
                <ElButton
                    v-if="canAbort"
                    link
                    type="danger"
                    @click="$emit('abandon')"
                >中止上传</ElButton>
            </div>

            <div
                v-if="preview"
                class="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-6 border-t border-[var(--fsusblog-panel-border)]"
            >
                <div class="preview-metric">
                    <label>预计尺寸</label>
                    <span>{{ preview.width }} × {{ preview.height }}</span>
                </div>
                <div class="preview-metric">
                    <label>格式</label>
                    <span>{{ preview.format.toUpperCase() }}</span>
                </div>
                <div class="preview-metric">
                    <label>大小变化</label>
                    <span class="tabular-nums">{{ formatBytes(preview.originalBytes) }} → {{ formatBytes(preview.compressedBytes) }}</span>
                </div>
                <div class="preview-metric">
                    <label>处理链路</label>
                    <span>{{ preview.pipeline }}</span>
                </div>
                <div class="preview-metric">
                    <label>能力</label>
                    <span class="text-[var(--fsusblog-text-primary)]">{{ preview.wasmCapability.toUpperCase() }}</span>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums">
                <span class="font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">WASM 支持：</span>
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
import { computed } from 'vue';

import type { ImageCompressionOptions } from '@/api/upload';
import { FsusUiSectionHeader } from '@/fsusui';
import type { ImageCompressionPreview } from '@/utils/imageCompression';

const props = defineProps<{
    options: ImageCompressionOptions;
    statusText?: string;
    canAbort?: boolean;
    canResume?: boolean;
    preview?: ImageCompressionPreview | null;
    wasmOnly?: boolean;
    wasmSupportedFormats?: string[];
}>();

const emit = defineEmits<{
    (e: 'update:options', value: Partial<ImageCompressionOptions>): void;
    (e: 'update:wasm-only', value: boolean): void;
    (e: 'reset'): void;
    (e: 'resume'): void;
    (e: 'abandon'): void;
}>();

const wasmOnly = computed(() => Boolean(props.wasmOnly));
const wasmSupportedFormatsDisplay = computed(() =>
{
    const declared = props.wasmSupportedFormats?.filter(Boolean) ?? [];
    if (declared.length > 0)
    {
        return declared;
    }
    return ['png'];
});

function updateOption<K extends keyof ImageCompressionOptions>(key: K, value: ImageCompressionOptions[K]): void
{
    const patch: Partial<ImageCompressionOptions> = {};
    patch[key] = value;
    emit('update:options', patch);
}

function updateFormat(value: string | number | boolean): void
{
    if (value === 'webp' || value === 'avif' || value === 'png' || value === 'jpeg' || value === 'gif')
    {
        updateOption('format', value);
    }
}

function updateQuality(value: string | number | boolean | undefined): void
{
    updateOption('quality', Number(value));
}

function updateScaleRatio(value: string | number | boolean | undefined): void
{
    updateOption('scaleRatio', Number(value));
}

function updateMaxEdge(value: string | number | boolean | undefined): void
{
    updateOption('maxEdge', Number(value));
}

function updatePreserveAlpha(value: string | number | boolean): void
{
    updateOption('preserveAlpha', Boolean(value));
}

function resetOptions(): void
{
    emit('reset');
}

function updateWasmOnly(value: string | number | boolean): void
{
    emit('update:wasm-only', Boolean(value));
}

function formatBytes(value: number): string
{
    if (value < 1024)
    {
        return `${value} B`;
    }
    if (value < 1024 * 1024)
    {
        return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}
</script>

<style scoped>
.upload-options-panel-minimal
 {
    display: grid;
    gap: var(--fsus-space-4);
}

.upload-options-value-group
 {
    display: grid;
    gap: var(--fsus-space-3);
    width: 100%;
    min-width: 0;
}

.upload-options-value-input
 {
    width: 100%;
    max-width: 100%;
}

@media (width >= 768px)
 {
    .upload-options-value-group
     {
        grid-template-columns: minmax(0, 1fr) minmax(0, 8rem);
        align-items: center;
        gap: var(--fsus-space-4);
    }
}

.preview-metric
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-1);
}

.preview-metric label
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.preview-metric span
 {
    color: var(--fsusblog-text-primary);
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}

</style>
