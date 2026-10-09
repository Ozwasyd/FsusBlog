// @vitest-environment happy-dom

import { ElButton, ElMarkdownRenderer } from '@ozwasyd/element-plus';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, shallowReadonly, shallowRef } from 'vue';

import ArticleBodyMarkdownPreview from '@/components/admin/article/ArticleBodyMarkdownPreview.vue';
import ArticlePreviewAttachmentStatus from '@/components/admin/article/ArticlePreviewAttachmentStatus.vue';
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue';
import type { ArticlePreviewAttachmentState } from '@/services/authoring/articlePreviewAttachments';

enableAutoUnmount(afterEach);

// Ordinary display inputs only; these do not assess attachments or authorize a request.
const state = (status: ArticlePreviewAttachmentState['status']): ArticlePreviewAttachmentState => ({
    status,
    projection: null,
    reason: 'private-internal-reason:content-digest'
});

const messages = [
    ['missing', '尚未连接附件校验', '无法确认当前附件'],
    ['checking', '正在检查当前请求', '请等待检查和预览生成完成'],
    ['ready', '已通过本次预览请求的检查', '再次生成仍需重新检查'],
    ['blocked', '校验条件尚未满足', '暂时无法生成预览'],
    ['stale', '检查结果已失效', '请重新生成预览'],
    ['canceled', '本次检查或预览已取消', '取消不代表附件清理完成'],
    ['failed', '检查或预览生成失败', '无法确认当前预览条件']
] as const;

function mountPanel(status: ArticlePreviewAttachmentState['status'], canPreview = true, loading = false)
{
    return mount(ArticlePrivatePreviewPanel, {
        props: {
            preview: null,
            loading,
            statusText: '当前预览状态',
            canPreview,
            attachmentState: state(status)
        },
        global: { components: { ElButton, ElMarkdownRenderer } }
    });
}

describe('ArticlePreviewAttachmentStatus ordinary presentation', () =>
{
    it.each(messages)('explains %s with an accessible status message', (status, explanation, nextStep) =>
    {
        const wrapper = mount(ArticlePreviewAttachmentStatus, {
            props: { attachmentState: state(status) }
        });
        const output = wrapper.get('[role="status"]');

        expect(output.attributes('aria-label')).toBe('预览附件检查状态');
        expect(output.attributes('aria-live')).toBe('polite');
        expect(output.attributes('aria-atomic')).toBe('true');
        expect(output.attributes('aria-busy')).toBe(String(status === 'checking'));
        expect(output.text()).toContain(explanation);
        expect(output.text()).toContain(nextStep);
        expect(wrapper.text()).not.toContain('private-internal-reason');
        expect(wrapper.text()).not.toContain('content-digest');
        expect(wrapper.find('button').exists()).toBe(false);
        expect(wrapper.emitted()).toEqual({});
    });

    it('limits ready to the request without implying lasting eligibility or publishing permission', () =>
    {
        const wrapper = mountPanel('ready');

        expect(wrapper.get('[role="status"]').text()).toContain('仅适用于本次请求');
        expect(wrapper.get('[role="status"]').text()).toContain('不代表持续可用或发布许可');
        expect(wrapper.get('.preview-empty').text()).toBe('暂无预览快照。');
        expect(wrapper.find('.author-preview').exists()).toBe(false);
    });

    it('reflects replacement, expiry, cancellation and recovery after the panel is mounted', async () =>
    {
        const wrapper = mountPanel('missing');

        for (const status of ['checking', 'ready', 'stale', 'checking', 'blocked', 'canceled', 'checking', 'failed', 'missing'] as const)
        {
            await wrapper.setProps({ attachmentState: state(status) });
            const message = messages.find(([value]) => value === status)!;
            expect(wrapper.get('[role="status"]').text()).toContain(message[1]);
            expect(wrapper.get('[role="status"]').attributes('aria-busy'))
                .toBe(String(status === 'checking'));
        }

        expect(wrapper.emitted('preview')).toBeUndefined();
        expect(wrapper.get('[role="status"]').text()).not.toContain('已通过');
    });

    it('reads only status, even when an old projection is retained', async () =>
    {
        const input: ArticlePreviewAttachmentState = {
            status: 'stale',
            get projection()
            {
                throw new Error('presentation must not inspect business projections');
            },
            get reason()
            {
                throw new Error('presentation must not inspect private reasons');
            }
        };
        const wrapper = mountPanel('ready');
        await wrapper.setProps({ attachmentState: input });
        expect(wrapper.get('[role="status"]').text()).toContain('检查结果已失效');
        expect(wrapper.text()).not.toContain('已通过');
    });

    it('consumes the owner handoff as a live template-unwrapped readonly ref', async () =>
    {
        const attachmentState = shallowRef<ArticlePreviewAttachmentState>(state('ready'));
        const { privatePreviewAttachmentState } = {
            privatePreviewAttachmentState: shallowReadonly(attachmentState)
        };
        const Host = defineComponent({
            components: { ArticlePrivatePreviewPanel },
            setup: () => ({ privatePreviewAttachmentState }),
            template: `<ArticlePrivatePreviewPanel
                :preview="null" :loading="false" status-text="当前预览状态" :can-preview="false"
                :attachment-state="privatePreviewAttachmentState"
            />`
        });
        const wrapper = mount(Host, { global: { components: { ElButton } } });

        expect(wrapper.get('[role="status"]').text()).toContain('已通过');
        attachmentState.value = state('stale');
        await wrapper.vm.$nextTick();
        expect(wrapper.get('[role="status"]').text()).toContain('检查结果已失效');
        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    });

    it('keeps the existing snapshot and genuine renderer when attachment eligibility expires', async () =>
    {
        const wrapper = mountPanel('ready');
        await wrapper.setProps({
            preview: {
                normalizedTitle: '文章预览',
                normalizedSummary: '已有预览快照',
                normalizedCoverImageUrl: '/uploads/cover.png',
                normalizedMarkdownSource: '当前正文',
                plainText: '当前正文',
                sourceIdentity: `preview:sha256:${'7'.repeat(64)}`,
                issues: [{ severity: 'warning', code: 'summary_missing', message: '请检查摘要' }]
            }
        });
        const renderer = wrapper.getComponent(ArticleBodyMarkdownPreview);
        expect(wrapper.findComponent(ElMarkdownRenderer).exists()).toBe(true);

        for (const status of ['stale', 'canceled', 'checking', 'failed'] as const)
        {
            await wrapper.setProps({ attachmentState: state(status) });
            expect(wrapper.getComponent(ArticleBodyMarkdownPreview).element).toBe(renderer.element);
            expect(renderer.props('content')).toBe('当前正文');
            expect(wrapper.get('.author-preview h1').text()).toBe('文章预览');
            expect(wrapper.get('.author-preview__summary').text()).toBe('已有预览快照');
            expect(wrapper.get('.author-preview__cover img').attributes('src')).toBe('/uploads/cover.png');
            expect(wrapper.get('.preview-issue').text()).toBe('请检查摘要');
        }

        expect(wrapper.emitted('preview')).toBeUndefined();
    });
});

describe('ArticlePrivatePreviewPanel original generation control', () =>
{
    it.each(messages)('keeps %s under the host canPreview gate', async (status) =>
    {
        const wrapper = mountPanel(status, false);
        const button = wrapper.get('button');
        const descriptionId = button.attributes('aria-describedby');

        expect(descriptionId).toBe('article-preview-attachment-status');
        expect(wrapper.get(`#${descriptionId}`).attributes('role')).toBe('status');
        expect(button.attributes('aria-label')).toBe('生成私有预览');
        expect(button.attributes('disabled')).toBeDefined();
        await button.trigger('click');
        expect(wrapper.emitted('preview')).toBeUndefined();

        await wrapper.setProps({ canPreview: true });
        expect(button.attributes('disabled')).toBeUndefined();
        await button.trigger('click');
        expect(wrapper.emitted('preview')).toEqual([[]]);
        expect(wrapper.emitted('retry')).toBeUndefined();
    });

    it('preserves loading and re-enables only when the host permits generation', async () =>
    {
        const wrapper = mountPanel('checking', true, true);
        const button = wrapper.get('button');

        expect(wrapper.getComponent(ElButton).props('loading')).toBe(true);
        expect(button.attributes('disabled')).toBeDefined();
        await button.trigger('click');
        expect(wrapper.emitted('preview')).toBeUndefined();

        await wrapper.setProps({ attachmentState: state('canceled'), canPreview: false });
        await wrapper.setProps({ loading: false });
        expect(button.attributes('disabled')).toBeDefined();
        expect(wrapper.get('[role="status"]').text()).toContain('取消不代表附件清理完成');

        await wrapper.setProps({ attachmentState: state('checking'), canPreview: true });
        await button.trigger('click');
        expect(wrapper.emitted('preview')).toEqual([[]]);
        expect(wrapper.get('[role="status"]').text()).toContain('正在检查');
    });
});
