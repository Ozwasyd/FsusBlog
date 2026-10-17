// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleQuickCaptureSurface from '@/components/admin/article/ArticleQuickCaptureSurface.vue';
import {
    describeArticleCaptureRequest,
    type ArticleCaptureInboxInput,
    type ArticleCaptureRecoveryScope,
    type ArticleCaptureStageResult
} from '@/services/articleCaptureRecovery';

const captureId = '11111111-1111-4111-8111-111111111111';
const requestIdentity = { requestId: '22222222-2222-4222-8222-222222222222', clientRevision: 'capture-test-one' };
const scope: ArticleCaptureRecoveryScope = {
    owner: {},
    adminPrincipalId: '42',
    siteScope: 'https://capture.fsusblog.test',
    canCreateInbox: true
};
const input: ArticleCaptureInboxInput = { schemaVersion: 1, title: '  标题🙂  ', markdownContent: '\n原始正文\r\n' };
const mounted: { unmount(): void; }[] = [];

type CaptureProps = InstanceType<typeof ArticleQuickCaptureSurface>['$props'];

function mountCapture(overrides: Partial<CaptureProps> = {})
{
    const wrapper = mount(ArticleQuickCaptureSurface, {
        attachTo: document.body,
        props: {
            modelValue: input,
            currentScope: scope,
            captureId,
            requestIdentity,
            stageResult: null,
            discoveryResult: null,
            ...overrides
        }
    });
    mounted.push(wrapper);
    return wrapper;
}

function staged(status: 'protected' | 'unprotected' = 'protected'): ArticleCaptureStageResult
{
    return {
        status,
        protection: status === 'protected' ? 'stored' : 'unavailable',
        request: describeArticleCaptureRequest(scope.adminPrincipalId, captureId, requestIdentity, input),
        serverOutcome: 'unknown'
    };
}

afterEach(() =>
{
    for (const wrapper of mounted.splice(0))
    {
        wrapper.unmount();
    }
    document.body.replaceChildren();
});

describe('ArticleQuickCaptureSurface with actual public FsusUI controls', () =>
{
    it('keeps every execution action disabled and emits only a close request', async () =>
    {
        const wrapper = mountCapture();
        const buttons = wrapper.findAll('button');
        expect(buttons.map(button => button.text())).toEqual(['选择模板', '保存到收件箱', '保存并打开', '取消']);
        for (const button of buttons.slice(0, -1))
        {
            expect(button.attributes('disabled')).toBeDefined();
            await button.trigger('click');
        }
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.emitted('request-close')).toBeUndefined();
        await buttons[buttons.length - 1]!.trigger('click');
        expect(wrapper.emitted('request-close')).toEqual([[]]);
        expect(wrapper.text()).toContain('保存和打开暂不可用');
    });

    it('preserves raw Unicode and whitespace in immutable input updates', async () =>
    {
        const wrapper = mountCapture();
        await wrapper.get('input:not([type="url"])').setValue('  新标题🙂  ');
        const titleUpdate = wrapper.emitted('update:modelValue')?.[0]?.[0];
        expect(titleUpdate).toEqual({ ...input, title: '  新标题🙂  ' });
        expect(Object.isFrozen(titleUpdate)).toBe(true);
        await wrapper.get('textarea').setValue('\n正文🙂\n');
        expect(wrapper.emitted('update:modelValue')?.[1]?.[0]).toEqual({ ...input, markdownContent: '\n正文🙂\n' });
        expect(input.title).toBe('  标题🙂  ');
    });

    it('keeps the original request visible and editing terminal after the stage prop clears', async () =>
    {
        const wrapper = mountCapture();
        await wrapper.setProps({ stageResult: staged(), modelValue: { ...input, title: 'later caller input' } });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', input.title);
        expect(wrapper.get('input:not([type="url"])').attributes('readonly')).toBeDefined();
        await wrapper.setProps({ stageResult: null });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', '');
        expect(wrapper.get('textarea').element).toHaveProperty('value', '');
        await wrapper.get('input:not([type="url"])').setValue('late edit');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('无法核对已绑定请求的输入');
        expect(wrapper.findAll('button').at(-1)?.text()).toBe('关闭');
    });

    it('does not show a request whose digest no longer matches its raw input', () =>
    {
        const result = staged();
        if (result.status === 'blocked')
        {
            throw new Error('fixture must carry an actual request');
        }
        const wrapper = mountCapture({ stageResult: {
            ...result,
            request: { ...result.request, input: { ...input, title: 'tampered request input' } }
        } });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', '');
        expect(wrapper.text()).not.toContain('tampered request input');
        expect(wrapper.text()).toContain('保存结果尚未确认');
    });

    it('treats a blocked observation as unknown and read-only without claiming absence', async () =>
    {
        const wrapper = mountCapture({ stageResult: { status: 'blocked', reason: 'busy', serverOutcome: 'unknown' } });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', input.title);
        expect(wrapper.get('textarea').attributes('readonly')).toBeDefined();
        await wrapper.get('textarea').setValue('blocked edit');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('保存结果尚未确认');
        expect(wrapper.text()).toContain('查看和复制');
    });

    it.each(['stage', 'discovery'] as const)('keeps %s scope retirement terminal after later props restore', async source =>
    {
        const wrapper = mountCapture();
        await wrapper.setProps(source === 'stage'
            ? { stageResult: { status: 'blocked', reason: 'scope-retired', serverOutcome: 'unknown' } }
            : { discoveryResult: { status: 'blocked', reason: 'scope-retired' } });
        await wrapper.setProps({ stageResult: null, discoveryResult: null, currentScope: scope });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', '');
        expect(wrapper.get('textarea').element).toHaveProperty('value', '');
        expect(wrapper.get('input:not([type="url"])').attributes('disabled')).toBeDefined();
        expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
        expect(wrapper.text()).toContain('请关闭后重新进入');
        await wrapper.findAll('button').at(-1)!.trigger('click');
        expect(wrapper.emitted('request-close')).toEqual([[]]);
    });

    it.each([
        { owner: {} },
        { adminPrincipalId: '43' },
        { siteScope: 'https://other.fsusblog.test' },
        { canCreateInbox: false }
    ])('hides private input when its original scope changes: %o', async changed =>
    {
        const wrapper = mountCapture();
        await wrapper.setProps({ currentScope: { ...scope, ...changed } });
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', '');
        expect(wrapper.get('textarea').element).toHaveProperty('value', '');
        expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('does not replace its original capture binding or admit an unavailable scope', async () =>
    {
        const wrapper = mountCapture();
        await wrapper.setProps({ captureId: '33333333-3333-4333-8333-333333333333' });
        expect(wrapper.get('textarea').element).toHaveProperty('value', '');
        const unavailable = mountCapture({ currentScope: null });
        expect(unavailable.get('textarea').element).toHaveProperty('value', '');
        expect(unavailable.get('textarea').attributes('disabled')).toBeDefined();
    });

    it('reports unavailable local protection without asserting a server outcome', () =>
    {
        const wrapper = mountCapture({ stageResult: staged('unprotected') });
        expect(wrapper.text()).toContain('未确认窗口不受本地保护');
        expect(wrapper.text()).toContain('保存结果尚未确认');
        expect(wrapper.findAll('button').filter(button => button.attributes('disabled') === undefined)).toHaveLength(1);
    });

    it('projects digest-only discovery without activating recovery, retry or discard', () =>
    {
        const request = describeArticleCaptureRequest(scope.adminPrincipalId, captureId, requestIdentity, input);
        const wrapper = mountCapture({ discoveryResult: { status: 'pending', malformed: 0, records: [{
            ...requestIdentity,
            captureId,
            journalId: 'capture-journal-test',
            journalSourceHash: 'source-hash-test',
            inputDigest: request.inputDigest,
            requestDigest: request.requestDigest,
            updatedAt: 1,
            expiresAt: 2,
            serverOutcome: 'unknown',
            recovery: 'authoritative-reconciliation-required'
        }] } });
        for (const label of ['恢复', '重试', '丢弃未确认输入'])
        {
            expect(wrapper.findAll('button').find(button => button.text() === label)?.attributes('disabled')).toBeDefined();
        }
        expect(wrapper.findAll('button').at(-1)?.text()).toBe('关闭');
    });

    it('keeps labels and live status references unique across simultaneous surfaces', async () =>
    {
        const host = mount(defineComponent({
            setup()
            {
                const props = { modelValue: input, currentScope: scope, captureId, requestIdentity,
                    stageResult: null, discoveryResult: null };
                return () => h('div', [h(ArticleQuickCaptureSurface, props), h(ArticleQuickCaptureSurface, props)]);
            }
        }), { attachTo: document.body });
        mounted.push(host);
        await nextTick();
        const wrappers = host.findAllComponents(ArticleQuickCaptureSurface);
        expect(wrappers).toHaveLength(2);
        const ids = wrappers.flatMap(wrapper => wrapper.findAll('[id]').map(element => element.attributes('id')));
        expect(new Set(ids).size).toBe(ids.length);
        for (const wrapper of wrappers)
        {
            for (const label of wrapper.findAll('label[for]'))
            {
                expect(wrapper.findAll('[id]').map(element => element.attributes('id'))).toContain(label.attributes('for'));
            }
            const status = wrapper.get('[aria-live="polite"]');
            expect(status.attributes('role')).toBe('status');
            expect(wrapper.get('section').attributes('aria-describedby')).toBe(status.attributes('id'));
        }
    });

    it.each([
        { title: 'title only', markdownContent: '' },
        { title: '', markdownContent: 'body only' }
    ])('uses actual input admission for %o without enabling submission', partial =>
    {
        const wrapper = mountCapture({ modelValue: { schemaVersion: 1, ...partial } });
        expect(wrapper.text()).not.toContain('至少填写一项有效内容');
        expect(wrapper.text()).toContain('输入尚未提交');
    });

    it('shows the actual input limit failure while preserving the original raw input', () =>
    {
        const title = 'x'.repeat(257);
        const wrapper = mountCapture({ modelValue: { ...input, title } });
        expect(wrapper.text()).toContain('标题最多 256 字符');
        expect(wrapper.get('input:not([type="url"])').element).toHaveProperty('value', title);
    });
});
