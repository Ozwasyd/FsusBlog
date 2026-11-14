<template>
    <div class="upload-options-panel-minimal">
        <header class="flex items-center justify-between mb-10 pb-4 border-b border-[var(--fsusblog-panel-border)]">
            <h3 class="section-title section-title--inline">上传与输出策略</h3>
            <ElButton
                type="primary"
                plain
                size="small"
                @click="resetOptions"
            >
                重置
            </ElButton>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-16 gap-y-10">
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
                <ElSlider
                    :model-value="options.quality"
                    :min="1"
                    :max="100"
                    :show-input="true"
                    @update:model-value="updateQuality"
                />
            </ElFormItem>

            <ElFormItem label="缩放倍率">
                <ElSlider
                    :model-value="options.scaleRatio"
                    :min="0.1"
                    :max="1"
                    :step="0.05"
                    :show-input="true"
                    @update:model-value="updateScaleRatio"
                />
            </ElFormItem>

            <ElFormItem label="最大边长">
                <ElSlider
                    :model-value="options.maxEdge"
                    :min="256"
                    :max="4096"
                    :step="64"
                    :show-input="true"
                    @update:model-value="updateMaxEdge"
                />
            </ElFormItem>

            <div class="flex flex-col gap-8 lg:col-span-2">
                <div class="flex items-center justify-between py-4 border-y border-[var(--fsusblog-panel-border)]">
                    <div>
                        <div class="text-[11px] font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">透明通道 (Alpha Channel)</div>
                        <p class="text-[12px] text-[var(--fsusblog-text-tertiary)] mt-1">保留图片原始透明度信息。</p>
                    </div>
                    <ElSwitch
                        :model-value="options.preserveAlpha"
                        label="透明通道 (Alpha Channel)"
                        @update:model-value="updatePreserveAlpha"
                    />
                </div>

                <div class="flex items-center justify-between py-4 border-b border-[var(--fsusblog-panel-border)]">
                    <div>
                        <div class="text-[11px] font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal">WASM-only 模式</div>
                        <p class="text-[12px] text-[var(--fsusblog-color-warning-text)] mt-1 italic">仅使用 WASM codec；不支持时直接报错。</p>
                    </div>
                    <ElSwitch
                        :model-value="wasmOnly"
                        label="WASM-only 模式"
                        @update:model-value="updateWasmOnly"
                    />
                </div>
            </div>
        </div>

        <span
            class="sr-only"
            :role="announceStatus ? 'status' : undefined"
        >{{ announceStatus ? statusText : '' }}</span>

        <!-- 状态与预览 -->
        <footer class="mt-12 space-y-6">
            <div
                v-if="statusText"
                class="flex items-center gap-4 py-3 px-4 bg-[var(--fsusblog-page-bg)] border border-[var(--fsusblog-panel-border-strong)] rounded-[var(--fsus-radius-control)]"
            >
                <span
                    :aria-hidden="announceStatus || undefined"
                    class="text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-primary)] normal-case tracking-normal"
                >{{ statusText }}</span>
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

            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] tabular-nums">
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
import type { ImageCompressionPreview } from '@/utils/imageCompression';

const props = withDefaults(defineProps<{
    options: ImageCompressionOptions;
    statusText?: string;
    announceStatus?: boolean;
    canAbort?: boolean;
    canResume?: boolean;
    preview?: ImageCompressionPreview | null;
    wasmOnly?: boolean;
    wasmSupportedFormats?: string[];
}>(), { announceStatus: true });

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
    emit('update:options', { [key]: value } as Partial<ImageCompressionOptions>);
}

function updateFormat(value: string | number | boolean): void
{
    if (value === 'webp' || value === 'avif' || value === 'png' || value === 'jpeg' || value === 'gif')
    {
        updateOption('format', value);
    }
}

function updateQuality(value: number | number[]): void
{
    if (typeof value === 'number')
    {
        updateOption('quality', value);
    }
}

function updateScaleRatio(value: number | number[]): void
{
    if (typeof value === 'number')
    {
        updateOption('scaleRatio', value);
    }
}

function updateMaxEdge(value: number | number[]): void
{
    if (typeof value === 'number')
    {
        updateOption('maxEdge', value);
    }
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
@reference "@/assets/main.css";

.section-title
 {
    @apply text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-primary)] normal-case;

    position: relative;
}

.section-title::before
 {
    content: "";

    @apply absolute bottom-[-4px] left-0 h-[2px] w-6 bg-[var(--fsusblog-text-primary)];
}

.section-title--inline
 {
    @apply mb-0 border-none pb-0;
}

.preview-metric
 {
    @apply flex flex-col gap-1;
}

.preview-metric label
 {
    @apply text-[11px] font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal;
}

.preview-metric span
 {
    @apply text-[12px] tabular-nums font-medium text-[var(--fsusblog-text-primary)];
}

</style>
