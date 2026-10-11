<template>
    <FsusUiSettingsSection
        title="作者排版"
        density="compact"
        description="只调整写作表面的排版，不改变文章内容和公开主题。"
    >
        <ElForm
            label-position="top"
            size="large"
            :disabled="block !== null"
            :aria-busy="view.status === 'loading' || view.status === 'saving'"
            aria-label="作者排版设置"
            @submit.prevent
        >
            <ElFormItem
                v-for="dimension in AUTHOR_TYPOGRAPHY_FIELDS"
                :key="dimension"
                :label="dimensionLabels[dimension]"
                :for="`${id}-${dimension}`"
            >
                <ElSelect
                    :id="`${id}-${dimension}`"
                    :model-value="validProfile ? view.profile![dimension] : undefined"
                    :aria-label="dimensionLabels[dimension]"
                    placeholder="尚无已验证偏好"
                    @update:model-value="choose(dimension, $event)"
                >
                    <ElOption
                        v-for="value in AUTHOR_TYPOGRAPHY_CHOICES[dimension]"
                        :key="value"
                        :value="value"
                        :label="valueLabels[value]"
                    />
                </ElSelect>
            </ElFormItem>
            <p
                role="status"
                aria-live="polite"
            >{{ statusText }}</p>
            <p
                v-if="block"
                role="status"
            >{{ blockText[block] }}</p>
            <ElButton
                native-type="button"
                :disabled="block !== null"
                :loading="view.status === 'saving'"
                @click="reset"
            >恢复默认排版</ElButton>
        </ElForm>
        <ElButton
            v-if="view.status === 'conflict' || view.status === 'unavailable'"
            native-type="button"
            :disabled="view.permission !== 'allowed'"
            @click="reload"
        >重新读取偏好</ElButton>
        <section
            class="min-w-0"
            aria-label="排版内容样例"
        >
            <p>内容样例 · 排版预览暂不可用，尚未应用所选偏好。</p>
            <MarkdownRenderer
                :content="sample"
                mode="preview"
                :allow-latex="false"
                :allow-mermaid="false"
                :base-url="null"
            />
            <p role="status">{{ fontText[view.font] }}</p>
        </section>
    </FsusUiSettingsSection>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue';
import { FsusUiSettingsSection } from '@/fsusui/settingsSection';
import {
    AUTHOR_TYPOGRAPHY_CHOICES, AUTHOR_TYPOGRAPHY_FIELDS, isAuthorTypographyChoice, isAuthorTypographyProfileView
} from '@/view-contracts/authorTypographyProfile';
import type { AuthorTypographyDimension, AuthorTypographyProfileView } from '@/view-contracts/authorTypographyProfile';
import { authorTypographySettingsBlock } from '@/view-contracts/authorTypographySettings';
import type { AuthorTypographySettingsView } from '@/view-contracts/authorTypographySettings';

const props = defineProps<{ view: AuthorTypographySettingsView; }>();
const emit = defineEmits<{
    change: [intent: Readonly<{ expectedRevision: number; profile: AuthorTypographyProfileView; }>];
    reset: [intent: Readonly<{ expectedRevision: number; }>];
    reload: [];
}>();
const id = useId();
const view = computed(() => props.view);
const validProfile = computed(() => isAuthorTypographyProfileView(view.value.profile));
const block = computed(() => authorTypographySettingsBlock(view.value));
const dimensionLabels = {
    fontFamily: '字体', fontSize: '字号', lineHeight: '行高', canvasWidth: '画布宽度', paragraphSpacing: '段落间距'
};
const valueLabels: Record<string, string> = {
    'system-sans': '系统无衬线', 'reading-serif': '阅读衬线', 'cjk-sans': '中日韩无衬线',
    compact: '紧凑', standard: '标准', large: '较大', relaxed: '舒展', narrow: '较窄', wide: '较宽'
};
const blockText = {
    permission: '作者权限尚未确认，暂不能修改。', device: '设备验证暂不可用，暂不能保存。',
    default: '当前默认排版尚未确认，暂不能保存或重置。', observation: '尚无已验证的当前偏好。',
    exhausted: '偏好版本已达上限，暂不能保存或重置。',
    pending: '正在等待服务端确认。', conflict: '偏好已在另一设备更新，请重新读取后再选择。',
    unavailable: '偏好服务暂不可用，尚未确认保存。', mapping: '作者排版映射暂不可用，暂不能应用或保存。'
};
const fontText = {
    unavailable: '字体映射尚未确认。', loading: '字体正在准备。', loaded: '字体已准备。',
    failed: '字体加载失败。', fallback: '正在使用已登记的回退字体。'
};
const statusText = computed(() =>
{
    if (block.value === 'observation' && (view.value.status === 'current' || view.value.status === 'saved'))
    {
        return '尚无已验证偏好，不能确认保存。';
    }
    return ({
        loading: '正在读取偏好。', current: view.value.revision === null ? '尚无已验证偏好。' : `当前偏好版本 ${view.value.revision}。`,
        saving: '正在保存偏好。', saved: '服务端已确认偏好。', conflict: '偏好版本冲突。', unavailable: '偏好暂不可用。'
    })[view.value.status];
});
const sample = '## 写作样例\n\n中文与 Latin 保持清晰。组合字符 é 与 emoji 👩🏽‍💻。\n\nالعربية نص للقراءة.\n\n第二段用于观察段落节奏。\n\n```text\nconst message = "Hello, 世界";\n```';

function choose(dimension: AuthorTypographyDimension, value: unknown): void
{
    if (block.value !== null || !isAuthorTypographyChoice(dimension, value) || !validProfile.value)
    {
        return;
    }
    const profile = { ...view.value.profile!, [dimension]: value };
    if (!isAuthorTypographyProfileView(profile))
    {
        return;
    }
    // No local draft or optimistic snapshot: only the canonical caller may execute CAS and supply a new observation.
    emit('change', Object.freeze({ expectedRevision: view.value.revision!, profile: Object.freeze(profile) }));
}

function reset(): void
{
    if (block.value !== null)
    {
        return;
    }
    emit('reset', Object.freeze({ expectedRevision: view.value.revision! }));
}

function reload(): void
{
    if (view.value.permission === 'allowed' && (view.value.status === 'conflict' || view.value.status === 'unavailable'))
    {
        emit('reload');
    }
}
</script>
