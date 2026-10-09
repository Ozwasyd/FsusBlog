// @vitest-environment happy-dom

import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElButton, ElPopover } from '@ozwasyd/element-plus';

import ArticleInternalLinkPreview from '@/components/admin/article/ArticleInternalLinkPreview.vue';
import type {
    ArticleInternalLinkPreviewContent,
    ArticleInternalLinkPreviewPresentation,
    ArticleInternalLinkPreviewRequest
} from '@/components/admin/article/ArticleInternalLinkPreview.types';

// Presentation inputs exercise the component boundary only; they do not prove
// host transport, permission, URL admission or production UX acceptance.
const wrappers: VueWrapper[] = [];
const requestToken = (targetKey: string) =>
{
    const controller = new AbortController();
    const request: ArticleInternalLinkPreviewRequest = { targetKey, signal: controller.signal };
    return { request, controller };
};
const admittedDisplay = (
    request: ArticleInternalLinkPreviewRequest,
    title = '目标文章',
    fields: Partial<ArticleInternalLinkPreviewContent> = {}
): ArticleInternalLinkPreviewPresentation => ({
    request,
    state: 'ready',
    content: {
        title,
        excerpt: '调用方提供的简短摘要。',
        statusText: '已发布',
        sectionText: '指定章节',
        openInNewTab: null,
        ...fields
    }
});
const mountPreview = (
    request: ArticleInternalLinkPreviewRequest | null,
    presentation: ArticleInternalLinkPreviewPresentation | null,
    targetKey: string | null = request?.targetKey ?? 'opaque-a'
) =>
{
    const wrapper = mount(ArticleInternalLinkPreview, {
        props: { targetKey, request, presentation },
        attachTo: document.body
    });
    wrappers.push(wrapper);
    return wrapper;
};
const panel = () => document.querySelector<HTMLElement>('[data-internal-link-preview]');
const control = (kind: 'open' | 'dismiss') =>
{
    const element = document.querySelector<HTMLButtonElement>(`[data-internal-link-preview-${kind}]`);
    expect(element).not.toBeNull();
    return element!;
};

afterEach(() =>
{
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
});

describe('ArticleInternalLinkPreview real public primitives', () =>
{
    it('preview-test: explicit hover focus and touch action only request through caller', async () =>
    {
        const { request } = requestToken('opaque-a');
        const wrapper = mountPreview(null, admittedDisplay(request));
        expect(panel()).toBeNull();
        expect(wrapper.findComponent(ElButton).exists()).toBe(true);
        expect(wrapper.findComponent(ElPopover).exists()).toBe(true);
        const trigger = wrapper.get('[data-internal-link-preview-request]');
        await trigger.trigger('pointerenter', { pointerType: 'touch' });
        expect(wrapper.emitted('request')).toBeUndefined();
        await trigger.trigger('pointerenter', { pointerType: 'mouse' });
        await trigger.trigger('focus');
        await trigger.trigger('click');
        expect(wrapper.emitted('request')).toEqual([
            [{ targetKey: 'opaque-a', trigger: 'hover' }],
            [{ targetKey: 'opaque-a', trigger: 'focus' }],
            [{ targetKey: 'opaque-a', trigger: 'action' }]
        ]);
        expect(panel()).toBeNull();
        await wrapper.setProps({ presentation: null });
        const action = vi.fn();
        await wrapper.setProps({
            request,
            presentation: admittedDisplay(request, '首次共同更新', { openInNewTab: action })
        });
        expect(control('open').disabled).toBe(false);
        control('open').click();
        expect(action).toHaveBeenCalledOnce();
    });

    it('preview-test: ready title excerpt status and section use accessible plain text', async () =>
    {
        const { request } = requestToken('opaque-a');
        mountPreview(request, admittedDisplay(request, '<script>目标</script>'));
        await nextTick();
        expect(panel()).not.toBeNull();
        const title = panel()!.querySelector('h2')!;
        expect(panel()!.getAttribute('aria-labelledby')).toBe(title.id);
        expect(title.textContent).toBe('<script>目标</script>');
        expect(panel()!.querySelector('script')).toBeNull();
        expect(panel()!.textContent).toContain('调用方提供的简短摘要。');
        expect(panel()!.textContent).toContain('已发布');
        expect(panel()!.textContent).toContain('指定章节');
        expect(title.getAttribute('dir')).toBe('auto');
        expect(control('open').disabled).toBe(true);
    });

    it('preview-test: late target response cannot replace a newer admitted target', async () =>
    {
        const a = requestToken('opaque-a');
        const b = requestToken('opaque-b');
        let deliverA!: (value: ArticleInternalLinkPreviewPresentation) => void;
        const pendingA = new Promise<ArticleInternalLinkPreviewPresentation>((resolve) => { deliverA = resolve; });
        const wrapper = mountPreview(a.request, { request: a.request, state: 'loading' });
        const lateUpdate = pendingA.then((presentation) => wrapper.setProps({ presentation }));
        await wrapper.setProps({
            targetKey: 'opaque-b', request: b.request,
            presentation: admittedDisplay(b.request, '较新的目标 B')
        });
        deliverA(admittedDisplay(a.request, '过期目标 A'));
        await lateUpdate;
        expect(panel()!.textContent).toContain('较新的目标 B');
        expect(panel()!.textContent).not.toContain('过期目标 A');
    });

    it('preview-test: same target retry uses fresh request object identity', async () =>
    {
        const a = requestToken('opaque-a');
        const retry = requestToken('opaque-a');
        const wrapper = mountPreview(a.request, admittedDisplay(a.request, '旧版本'));
        await wrapper.setProps({ request: retry.request, presentation: admittedDisplay(retry.request, '当前版本') });
        await wrapper.setProps({ presentation: admittedDisplay(a.request, '迟到旧版本') });
        expect(panel()!.textContent).toContain('当前版本');
        expect(panel()!.textContent).not.toContain('迟到旧版本');
    });

    it('preview-test: revoke clears content and a withdrawn token cannot resurrect it', async () =>
    {
        const { request } = requestToken('opaque-a');
        const action = vi.fn();
        const ready = admittedDisplay(request, '已撤销的标题', { openInNewTab: action });
        const wrapper = mountPreview(request, ready);
        await wrapper.setProps({ presentation: null });
        expect(document.body.textContent).not.toContain('已撤销的标题');
        expect(document.body.textContent).not.toContain('调用方提供的简短摘要。');
        expect(control('open').disabled).toBe(true);
        await wrapper.setProps({ presentation: ready });
        expect(document.body.textContent).not.toContain('已撤销的标题');
        control('open').click();
        expect(action).not.toHaveBeenCalled();
        const retry = requestToken('opaque-a');
        const retryReady = admittedDisplay(retry.request, '再次撤销的标题', { openInNewTab: action });
        await wrapper.setProps({ request: retry.request, presentation: retryReady });
        expect(panel()!.textContent).toContain('再次撤销的标题');
        await wrapper.setProps({ targetKey: null });
        await wrapper.setProps({ presentation: null });
        await wrapper.setProps({ targetKey: 'opaque-a', presentation: retryReady });
        expect(panel()!.textContent).not.toContain('再次撤销的标题');
        expect(control('open').disabled).toBe(true);
    });

    it('preview-test: abort clears data and late completion stays unavailable', async () =>
    {
        const { request, controller } = requestToken('opaque-a');
        const wrapper = mountPreview(request, admittedDisplay(request, '取消目标'));
        controller.abort();
        await nextTick();
        expect(panel()).toBeNull();
        await wrapper.setProps({ presentation: admittedDisplay(request, '迟到取消目标') });
        expect(panel()).toBeNull();
        expect(document.body.textContent).not.toContain('取消目标');
    });

    it('preview-test: loading error empty stale and aborted never leak old details', async () =>
    {
        const { request } = requestToken('opaque-a');
        const wrapper = mountPreview(request, admittedDisplay(request, '旧标题'));
        for (const [state, text] of [
            ['loading', '正在加载预览…'], ['error', '预览暂时不可用。'],
            ['empty', '暂无可用预览。'], ['stale', '预览已失效，请重新请求。'],
            ['aborted', '预览请求已取消。']
        ] as const)
        {
            await wrapper.setProps({ presentation: { request, state } });
            expect(panel()!.querySelector('[role="status"]')!.textContent).toBe(text);
            expect(panel()!.textContent).not.toContain('旧标题');
            expect(control('open').disabled).toBe(true);
            expect(panel()!.getAttribute('aria-busy')).toBe(String(state === 'loading'));
        }
    });

    it('preview-test: new target and missing facts never infer title section or route', async () =>
    {
        const { request } = requestToken('opaque-a');
        const wrapper = mountPreview(request, admittedDisplay(request, '旧目标'));
        await wrapper.setProps({ targetKey: 'opaque-b' });
        expect(panel()).toBeNull();
        const b = requestToken('opaque-b');
        await wrapper.setProps({ request: b.request, presentation: admittedDisplay(b.request, undefined, {
            title: null, excerpt: null, statusText: null, sectionText: null
        }) });
        expect(panel()!.textContent).toContain('摘要不可用。');
        expect(panel()!.querySelectorAll('dd')[1]!.textContent).toBe('不可用');
        expect(panel()!.querySelector('a')).toBeNull();
        expect(panel()!.textContent).not.toContain('opaque-b');
    });

    it('preview-test: canonical open dismiss escape and unmount preserve host ownership', async () =>
    {
        const { request, controller } = requestToken('opaque-a');
        const editor = document.createElement('textarea');
        editor.value = '宿主编辑正文';
        document.body.append(editor);
        editor.focus();
        editor.setSelectionRange(2, 5);
        const action = vi.fn();
        const abort = vi.spyOn(controller, 'abort');
        const wrapper = mountPreview(request, admittedDisplay(request, '目标', { openInNewTab: action }));
        control('open').click();
        await nextTick();
        expect(action).toHaveBeenCalledOnce();
        expect(wrapper.emitted('open')).toEqual([[request]]);
        expect(panel()).not.toBeNull();
        expect(document.activeElement).toBe(editor);
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 5]);
        control('dismiss').click();
        await nextTick();
        expect(wrapper.emitted('dismiss')).toEqual([[{ request, reason: 'action' }]]);
        expect(panel()).toBeNull();
        const retry = requestToken('opaque-a');
        await wrapper.setProps({ request: retry.request, presentation: admittedDisplay(retry.request) });
        panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await nextTick();
        expect(wrapper.emitted('dismiss')?.[1]).toEqual([{ request: retry.request, reason: 'escape' }]);
        expect(panel()).toBeNull();
        expect(abort).not.toHaveBeenCalled();
        wrapper.unmount();
        expect(request.signal.aborted).toBe(false);
        expect(editor.value).toBe('宿主编辑正文');
        editor.remove();
    });

    it('preview-test: long RTL CJK display remains text and unavailable target stays disabled', async () =>
    {
        const { request } = requestToken('opaque-a');
        const text = '章节标题 العربية 日本語中文 '.repeat(100);
        const localBefore = localStorage.length;
        const sessionBefore = sessionStorage.length;
        const wrapper = mountPreview(request, admittedDisplay(request, text, { excerpt: text, sectionText: text }));
        expect(panel()!.querySelector('h2')!.textContent).toBe(text);
        expect(panel()!.querySelector('dd:last-child')!.getAttribute('dir')).toBe('auto');
        await wrapper.setProps({ targetKey: null, request: null, presentation: null });
        expect(panel()).toBeNull();
        expect(wrapper.get('[data-internal-link-preview-request]').attributes('disabled')).toBeDefined();
        expect(localStorage.length).toBe(localBefore);
        expect(sessionStorage.length).toBe(sessionBefore);
    });
});
