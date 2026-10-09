// @vitest-environment happy-dom

import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ArticleInternalLinkPicker, {
    type InternalLinkPickerArticle,
    type InternalLinkPickerHeading,
    type InternalLinkPickerHeadingResult,
    type InternalLinkPickerSearchResult
} from '@/components/admin/article/ArticleInternalLinkPicker.vue';
import { FsusUiDialog } from '@/fsusui/dialog';

const wrappers: VueWrapper[] = [];

function article(id: string, overrides: Partial<InternalLinkPickerArticle> = {}): InternalLinkPickerArticle
{
    return {
        id, revision: `revision:${id}`, title: '重复标题', statusText: '已发布', updatedText: '2026-10-09',
        unavailableText: null, selectAction: { command: `select:${id}` }, headingsAction: { command: `headings:${id}` },
        ...overrides
    };
}

function heading(id: string, overrides: Partial<InternalLinkPickerHeading> = {}): InternalLinkPickerHeading
{
    return { id, revision: `revision:${id}`, title: '重复章节', unavailableText: null, selectAction: { command: `select:${id}` }, ...overrides };
}

async function openPicker()
{
    const wrapper = mount(ArticleInternalLinkPicker, {
        attachTo: document.body,
        props: {
            modelValue: true, sessionKey: 'command:original', searchResult: null, headingResult: null,
            selectionUnavailableText: null,
            'onUpdate:modelValue': (value: boolean) =>
            {
                void wrapper.setProps({ modelValue: value });
            }
        },
        global: { stubs: { transition: false } }
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

function latestSearch(wrapper: VueWrapper)
{
    return wrapper.emitted('request-search')!.at(-1)![0] as { sessionKey: string; requestKey: string; query: string; };
}

function latestHeadings(wrapper: VueWrapper)
{
    return wrapper.emitted('request-headings')!.at(-1)![0] as {
        sessionKey: string; requestKey: string; articleId: string; articleRevision: string; action: unknown;
    };
}

async function results(wrapper: VueWrapper, articles: InternalLinkPickerArticle[], overrides: Partial<InternalLinkPickerSearchResult> = {})
{
    await wrapper.setProps({ searchResult: { requestKey: latestSearch(wrapper).requestKey, state: 'ready', articles, message: null, ...overrides } });
    await flushPromises();
}

async function headingResults(wrapper: VueWrapper, headings: InternalLinkPickerHeading[], overrides: Partial<InternalLinkPickerHeadingResult> = {})
{
    const request = latestHeadings(wrapper);
    await wrapper.setProps({ headingResult: {
        requestKey: request.requestKey, articleId: request.articleId, articleRevision: request.articleRevision,
        state: 'ready', headings, message: null, ...overrides
    } });
    await flushPromises();
}

function targets()
{
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-target]'));
}

function button(label: string)
{
    const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((element) => element.textContent?.trim() === label);
    expect(found, `public button ${label}`).toBeDefined();
    return found!;
}

async function key(element: Element, value: string)
{
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    await nextTick();
}

afterEach(() =>
{
    for (const wrapper of wrappers.splice(0))
    {
        wrapper.unmount();
    }
    document.body.innerHTML = '';
});

describe('ArticleInternalLinkPicker #1807', () =>
{
    it('mounts public controls and navigates article then heading with canonical selection', async () =>
    {
        const wrapper = await openPicker();
        const second = article('article:two');
        await results(wrapper, [article('article:one'), second]);
        expect(wrapper.findComponent(FsusUiDialog).exists()).toBe(true);
        expect(wrapper.findComponent(ElInput).exists()).toBe(true);
        expect(wrapper.findAllComponents(ElButton).length).toBeGreaterThan(2);
        expect(document.querySelectorAll('input')).toHaveLength(1);
        const input = document.querySelector('input')!;
        input.focus();
        await key(input, 'ArrowDown');
        expect(document.activeElement).toBe(targets()[0]);
        await key(targets()[0], 'ArrowDown');
        expect(document.activeElement).toBe(targets()[1]);
        // happy-dom does not implement the native Enter activation default; real browser coverage is separate.
        targets()[1].click();
        await flushPromises();
        expect(latestHeadings(wrapper)).toMatchObject({ articleId: second.id, articleRevision: second.revision, action: second.headingsAction });
        const selected = heading('heading:second');
        await headingResults(wrapper, [heading('heading:first'), selected]);
        await key(document.querySelector('[aria-label="文章章节"]')!, 'End');
        expect(document.activeElement).toBe(targets()[1]);
        targets()[1].click();
        await flushPromises();
        expect(wrapper.emitted('select')).toEqual([[{
            sessionKey: 'command:original', searchRequestKey: latestSearch(wrapper).requestKey,
            headingRequestKey: latestHeadings(wrapper).requestKey, articleId: second.id, articleRevision: second.revision,
            headingId: selected.id, headingRevision: selected.revision, action: selected.selectAction
        }]]);
        expect(wrapper.emitted('cancel')).toBeUndefined();
        expect(wrapper.props('modelValue')).toBe(false);
    });

    it('returns from headings by keyboard and emits one explicit picker cancellation', async () =>
    {
        const wrapper = await openPicker();
        await results(wrapper, [article('a')]);
        targets()[0].click();
        await flushPromises();
        await headingResults(wrapper, [heading('h')]);
        await key(document.querySelector('[aria-label="文章章节"]')!, 'ArrowLeft');
        expect(document.activeElement).toBe(document.querySelector('input'));
        expect(wrapper.emitted('cancel')![0][0]).toMatchObject({ scope: 'headings', reason: 'back' });
        button('取消').click();
        await flushPromises();
        expect(wrapper.emitted('cancel')).toHaveLength(2);
        expect(wrapper.emitted('cancel')![1][0]).toMatchObject({ scope: 'picker', reason: 'dismiss' });
        expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('ignores delayed searches and headings from replaced request identities', async () =>
    {
        const wrapper = await openPicker();
        await results(wrapper, [article('old')]);
        targets()[0].click();
        await flushPromises();
        const oldSearch = latestSearch(wrapper);
        const oldHeadings = latestHeadings(wrapper);
        const input = document.querySelector('input')!;
        input.value = '新的搜索';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        expect(latestSearch(wrapper).query).toBe('新的搜索');
        expect(latestSearch(wrapper).requestKey === oldSearch.requestKey).toBe(false);
        await results(wrapper, [article('late')], { requestKey: oldSearch.requestKey });
        expect(targets()).toHaveLength(0);
        await results(wrapper, [article('new')]);
        targets()[0].click();
        await flushPromises();
        await headingResults(wrapper, [heading('late-heading')], { requestKey: oldHeadings.requestKey, articleId: oldHeadings.articleId });
        expect(targets()).toHaveLength(0);
        expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('clears drill-in when admitted article identity changes or disappears', async () =>
    {
        const wrapper = await openPicker();
        const target = article('a');
        await results(wrapper, [target]);
        targets()[0].click();
        await flushPromises();
        await headingResults(wrapper, [heading('h')]);
        await results(wrapper, [article('a', { revision: 'new-revision' })]);
        expect(document.querySelector('[aria-label="文章章节"]')).toBeNull();
        expect(wrapper.emitted('cancel')!.at(-1)![0]).toMatchObject({ scope: 'headings', reason: 'invalidated' });
        targets()[0].click();
        await flushPromises();
        await results(wrapper, []);
        expect(document.querySelector('[aria-label="文章章节"]')).toBeNull();
        expect(targets()).toHaveLength(0);
        expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('clears revoked selection and displays only exact owner unavailable copy', async () =>
    {
        const wrapper = await openPicker();
        await results(wrapper, [article('a')]);
        targets()[0].click();
        await flushPromises();
        await headingResults(wrapper, [heading('h')]);
        await wrapper.setProps({ selectionUnavailableText: '原选择已不可用，请重新发起命令。' });
        expect(document.querySelector('[aria-label="文章章节"]')).toBeNull();
        expect(document.body.textContent).toContain('原选择已不可用，请重新发起命令。');
        expect(targets()[0].disabled).toBe(true);
        targets()[0].click();
        expect(wrapper.emitted('select')).toBeUndefined();
        await wrapper.setProps({ selectionUnavailableText: null });
        await results(wrapper, [article('a', { unavailableText: '权威 owner: 此目标不可选择。' })]);
        expect(document.body.textContent).toContain('权威 owner: 此目标不可选择。');
        expect(targets()[0].disabled).toBe(true);
    });

    it('handles loading empty error and cancelled without exposing stale rows', async () =>
    {
        const wrapper = await openPicker();
        expect(document.body.textContent).toContain('加载中');
        await results(wrapper, []);
        expect(document.body.textContent).toContain('没有匹配文章');
        await results(wrapper, [article('stale')], { state: 'error', message: '安全的查询失败提示' });
        expect(document.querySelector('[role="alert"]')?.textContent).toBe('安全的查询失败提示');
        expect(targets()).toHaveLength(0);
        await results(wrapper, [article('stale')], { state: 'cancelled', message: null });
        expect(document.body.textContent).toContain('请求已取消');
        expect(targets()).toHaveLength(0);
        await results(wrapper, [article('a')]);
        targets()[0].click();
        await flushPromises();
        await headingResults(wrapper, []);
        expect(document.body.textContent).toContain('没有可用章节');
        button('选择整篇文章').click();
        await flushPromises();
        expect(wrapper.emitted('select')![0][0]).toMatchObject({ articleId: 'a', headingId: null });
    });

    it('keeps duplicate CJK RTL labels distinct and missing actions unavailable for touch', async () =>
    {
        const wrapper = await openPicker();
        const title = '长中文标题'.repeat(30) + ' العربية עברית';
        await results(wrapper, [article('one', { title }), article('two', { title }), article('missing', {
            title: '缺少事实', statusText: null, updatedText: null, selectAction: null, headingsAction: null
        })]);
        expect(targets()[0].getAttribute('aria-label')).toBe(`查看章节：${title}`);
        expect(targets()[1].getAttribute('aria-label')).toBe(`查看章节：${title}`);
        expect(Array.from(document.querySelectorAll('.internal-link-picker__row-content > bdi')).map((element) => element.textContent)).toEqual([title, title, '缺少事实']);
        expect(targets()[2].disabled).toBe(true);
        targets()[1].click();
        await flushPromises();
        await headingResults(wrapper, [heading('blocked', { unavailableText: '章节不可用', selectAction: null }), heading('allowed')]);
        expect(targets()[0].disabled).toBe(true);
        targets()[1].click();
        await flushPromises();
        expect(wrapper.emitted('select')![0][0]).toMatchObject({ articleId: 'two', headingId: 'allowed' });
    });

    it('replaces host context and prevents old selection actions after reopen', async () =>
    {
        const wrapper = await openPicker();
        await results(wrapper, [article('a')]);
        const oldKey = latestSearch(wrapper).requestKey;
        targets()[0].click();
        await flushPromises();
        await wrapper.setProps({ sessionKey: 'command:replacement' });
        expect(wrapper.emitted('cancel')!.at(-1)![0]).toMatchObject({ sessionKey: 'command:original', reason: 'context-changed' });
        expect(latestSearch(wrapper).sessionKey).toBe('command:replacement');
        expect(latestSearch(wrapper).requestKey === oldKey).toBe(false);
        expect(targets()).toHaveLength(0);
        await wrapper.setProps({ modelValue: false });
        await wrapper.setProps({ modelValue: true });
        await results(wrapper, [article('late')], { requestKey: oldKey });
        expect(targets()).toHaveLength(0);
        expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('delegates Escape close and focus return to the real public dialog', async () =>
    {
        const trigger = document.createElement('button');
        trigger.textContent = '原编辑命令';
        document.body.append(trigger);
        trigger.focus();
        const wrapper = await openPicker();
        await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('input')));
        await key(document.activeElement!, 'Escape');
        await flushPromises();
        await vi.waitFor(() => expect(wrapper.props('modelValue')).toBe(false));
        expect(wrapper.emitted('cancel')).toHaveLength(1);
        await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    });
});
