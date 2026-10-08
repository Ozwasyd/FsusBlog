// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { defineComponent, h, nextTick, reactive, ref, watch, type Ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ArticleMetadataPropertyList from '@/components/admin/article/ArticleMetadataPropertyList.vue';
import source from '@/components/admin/article/ArticleMetadataPropertyList.vue?raw';

const labels = {
    properties: '文章属性',
    compact: '紧凑属性',
    more: '更多属性',
    manage: '管理定义',
    search: '搜索属性定义',
    pagination: '属性分页',
    previous: '上一页',
    next: '下一页',
    unavailable: '无权读取属性',
    loading: '加载属性',
    stale: '属性已过期，请刷新',
    pageOverflow: '属性页超出展示预算，请分页读取',
    empty: '没有属性',
    ready: '当前属性页'
};

const baseProps = {
    definitionIds: ['definition-a'],
    contextKey: 'article-a:owner-revision-1',
    pageKey: 'page-1',
    showAll: false,
    query: '',
    available: true,
    loading: false,
    stale: false,
    canManage: false,
    hasPreviousPage: false,
    hasNextPage: false,
    labels
};

const wrappers: ReturnType<typeof mount>[] = [];
function render(overrides: Partial<typeof baseProps> = {})
{
    const wrapper = mount(ArticleMetadataPropertyList, {
        attachTo: document.body,
        props: { ...baseProps, ...overrides },
        slots: {
            status: () => h('span', { 'data-owner-status': '' }, 'server validation status'),
            property: ({ definitionId }: { definitionId: string }) => h('label', [
                '由上游提供的字段',
                h('input', { 'data-definition-id': definitionId })
            ])
        }
    });
    wrappers.push(wrapper);
    return wrapper;
}

function button(wrapper: Pick<ReturnType<typeof mount>, 'findAllComponents'>, text: string)
{
    return wrapper.findAllComponents(ElButton).find((control) => control.text() === text)!;
}

function renderPageRace(mutate: (state: typeof baseProps, visible: Ref<boolean>) => void)
{
    const state = reactive({ ...baseProps, showAll: true, hasNextPage: true });
    const visible = ref(true);
    const Host = defineComponent({
        setup()
        {
            watch(() => state.pageKey, (pageKey) =>
            {
                if (pageKey === 'page-2')
                {
                    mutate(state, visible);
                }
            }, { flush: 'post' });
            return () => h('div', [
                h(ElInput, { modelValue: state.query, 'aria-label': 'owner-filter' }),
                visible.value ? h(ArticleMetadataPropertyList, {
                    ...state,
                    onPage: () => { state.pageKey = 'page-2'; }
                }) : null
            ]);
        }
    });
    const wrapper = mount(Host, { attachTo: document.body });
    wrappers.push(wrapper);
    return { wrapper, state, visible };
}

afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.restoreAllMocks();
});

describe('ArticleMetadataPropertyList presentation boundary', () =>
{
    it('renders zero and one supplied definition with real public FsusUI controls', async () =>
    {
        const wrapper = render({ definitionIds: [] });
        expect(wrapper.get('[role="status"]').text()).toBe(labels.empty);
        expect(wrapper.findAll('li')).toHaveLength(0);
        expect(wrapper.findComponent(ElButton).exists()).toBe(true);
        await wrapper.setProps({ definitionIds: ['stable-id'] });
        expect(wrapper.get('[data-definition-id]').attributes('data-definition-id')).toBe('stable-id');
        expect(wrapper.get('[role="status"]').text()).toBe(labels.ready);
        expect(wrapper.find('input[aria-label]').exists()).toBe(false);
    });

    it('requests more properties without locally changing the supplied compact set', async () =>
    {
        const wrapper = render();
        await button(wrapper, labels.more).trigger('click');
        expect(wrapper.emitted('update:showAll')).toEqual([[true]]);
        expect(wrapper.findAll('li')).toHaveLength(1);
        expect(wrapper.findComponent(ElInput).exists()).toBe(false);
        await wrapper.setProps({ showAll: true });
        expect(wrapper.findComponent(ElInput).exists()).toBe(true);
        expect(button(wrapper, labels.compact).attributes('aria-expanded')).toBe('true');
    });

    it('forwards search text to the owner without filtering or matching titles locally', async () =>
    {
        const wrapper = render({ showAll: true });
        await wrapper.get('input[aria-label]').setValue('完全不匹配的私有搜索');
        expect(wrapper.emitted('update:query')).toEqual([['完全不匹配的私有搜索']]);
        expect(wrapper.get('[data-definition-id]').attributes('data-definition-id')).toBe('definition-a');
        expect(wrapper.emitted('page')).toBeUndefined();
    });

    it('shows definition management only for the supplied permission', async () =>
    {
        const wrapper = render();
        expect(button(wrapper, labels.manage)).toBeUndefined();
        await wrapper.setProps({ canManage: true });
        await button(wrapper, labels.manage).trigger('click');
        expect(wrapper.emitted('manage')).toEqual([[]]);
        await wrapper.setProps({ available: false });
        expect(wrapper.findComponent(ElButton).exists()).toBe(false);
    });

    it('walks 1000 upstream fixture identities in bounded pages without manufacturing a cursor', async () =>
    {
        const identities = Array.from({ length: 1000 }, (_, index) => `stable-${index}`);
        const wrapper = render({ definitionIds: identities.slice(0, 20), hasNextPage: true });
        const observed: string[] = [];
        for (let page = 0; page < 50; page++)
        {
            if (page > 0)
            {
                await button(wrapper, labels.next).trigger('click');
                expect(wrapper.emitted('page')?.at(-1)).toEqual(['next']);
                // Test fixture represents owner delivery, not a product query/index.
                await wrapper.setProps({
                    definitionIds: identities.slice(page * 20, (page + 1) * 20),
                    pageKey: `page-${page + 1}`,
                    hasPreviousPage: true,
                    hasNextPage: page < 49
                });
            }
            const fields = wrapper.findAll('[data-definition-id]');
            expect(fields).toHaveLength(20);
            for (const field of fields)
            {
                const definitionId = field.attributes('data-definition-id');
                expect(definitionId).toBeTypeOf('string');
                if (typeof definitionId !== 'string')
                {
                    throw new Error('expected a stable definition identity');
                }
                observed.push(definitionId);
            }
        }
        expect(observed).toEqual(identities);
        expect(button(wrapper, labels.next).attributes('disabled')).toBeDefined();
        await button(wrapper, labels.previous).trigger('click');
        expect(wrapper.emitted('page')?.at(-1)).toEqual(['previous']);
    });

    it('refuses an oversized page explicitly without mounting or silently truncating fields', () =>
    {
        const wrapper = render({ definitionIds: Array.from({ length: 1000 }, (_, index) => `${index}`) });
        expect(wrapper.findAll('li')).toHaveLength(0);
        expect(wrapper.get('[role="status"]').text()).toBe(labels.pageOverflow);
        expect(wrapper.find('[data-owner-status]').exists()).toBe(false);
    });

    it.each([
        [{ stale: true }, labels.stale],
        [{ loading: true }, labels.loading],
        [{ available: false }, labels.unavailable]
    ])('removes old property controls and blocks actions for %j', async (state, message) =>
    {
        const wrapper = render({ canManage: true, showAll: true, hasNextPage: true });
        await wrapper.setProps(state);
        expect(wrapper.find('[data-definition-id]').exists()).toBe(false);
        expect(wrapper.find('[data-owner-status]').exists()).toBe(false);
        expect(wrapper.get('[role="status"]').text()).toBe(message);
        if (wrapper.findComponent(ElButton).exists())
        {
            expect(wrapper.findAllComponents(ElButton).every((control) => control.props('disabled'))).toBe(true);
            expect(wrapper.getComponent(ElInput).props('disabled')).toBe(true);
            await button(wrapper, labels.next).trigger('click');
            expect(wrapper.emitted('page')).toBeUndefined();
        }
    });

    it('remounts slot forms when the owner changes context or page revision', async () =>
    {
        const Field = defineComponent({
            setup()
            {
                const value = ref('server');
                return () => h('input', { value: value.value, onInput: () => { value.value = 'unsaved'; } });
            }
        });
        const wrapper = mount(ArticleMetadataPropertyList, {
            props: baseProps,
            slots: { property: () => h(Field) }
        });
        wrappers.push(wrapper);
        await wrapper.get('input').setValue('unsaved');
        await wrapper.setProps({ pageKey: 'new-schema-revision' });
        expect(wrapper.get('input').element.value).toBe('server');
        await wrapper.get('input').setValue('unsaved');
        await wrapper.setProps({ contextKey: 'article-b' });
        expect(wrapper.get('input').element.value).toBe('server');
    });

    it('returns focus after requested page delivery settles, including a delayed loading flag', async () =>
    {
        const wrapper = render({ hasNextPage: true });
        await button(wrapper, labels.next).trigger('click');
        await wrapper.setProps({ loading: true, pageKey: 'page-2' });
        await wrapper.setProps({ loading: false });
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('[role="status"]').element);
    });

    it('does not transfer pending page focus across an article or filter change', async () =>
    {
        const wrapper = render({ hasNextPage: true });
        for (const changed of [{ contextKey: 'article-b' }, { query: 'new search' }, { showAll: true }])
        {
            const activeElement = document.activeElement;
            await button(wrapper, labels.next).trigger('click');
            await wrapper.setProps({ ...changed, pageKey: `${wrapper.props('pageKey')}-changed` });
            await nextTick();
            expect(document.activeElement).toBe(activeElement);
        }
    });

    it.each([
        ['query', { query: 'new-filter' }],
        ['compact selection', { showAll: false }],
        ['document', { contextKey: 'article-b' }],
        ['page generation', { pageKey: 'page-3' }],
        ['permission', { available: false }],
        ['stale state', { stale: true }],
        ['loading state', { loading: true }]
    ])('cancels pagination focus when the owner changes %s during the post-render flush', async (_name, changed) =>
    {
        const { wrapper } = renderPageRace((state) => { Object.assign(state, changed); });
        const filter = wrapper.get<HTMLInputElement>('input[aria-label="owner-filter"]');
        filter.element.focus();
        const list = wrapper.getComponent(ArticleMetadataPropertyList);
        await button(list, labels.next).trigger('click');
        await nextTick();
        expect(document.activeElement).toBe(filter.element);
        for (const [key, value] of Object.entries(changed))
        {
            expect(list.props(key as keyof typeof baseProps)).toBe(value);
        }
    });

    it('cancels an awaited pagination focus callback when the owner unmounts the list', async () =>
    {
        const { wrapper } = renderPageRace((_state, visible) => { visible.value = false; });
        const filter = wrapper.get<HTMLInputElement>('input[aria-label="owner-filter"]');
        filter.element.focus();
        const list = wrapper.getComponent(ArticleMetadataPropertyList);
        const focus = vi.spyOn(list.get<HTMLElement>('[role="status"]').element, 'focus');
        await button(list, labels.next).trigger('click');
        await nextTick();
        expect(wrapper.findComponent(ArticleMetadataPropertyList).exists()).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(filter.element);
    });

    it('cancels superseded focus callbacks while allowing the next requested page to restore focus', async () =>
    {
        const { wrapper, state } = renderPageRace(() =>
        {
            document.querySelector<HTMLButtonElement>('nav[aria-label="属性分页"] button:last-child')?.click();
        });
        const filter = wrapper.get<HTMLInputElement>('input[aria-label="owner-filter"]');
        filter.element.focus();
        const list = wrapper.getComponent(ArticleMetadataPropertyList);
        await button(list, labels.next).trigger('click');
        await nextTick();
        expect(list.emitted('page')).toEqual([['next'], ['next']]);
        expect(document.activeElement).toBe(filter.element);
        state.pageKey = 'page-3';
        await nextTick();
        await nextTick();
        expect(document.activeElement).toBe(list.get('[role="status"]').element);
    });

    it('does not fetch, persist or emit metadata values; has no secondary inspector or database surface', async () =>
    {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
        const wrapper = render({ showAll: true });
        await wrapper.get('input[aria-label]').setValue('private query');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(storageSpy).not.toHaveBeenCalled();
        // Vue Test Utils also observes native input/change/select bubbling.
        expect(Object.keys(wrapper.emitted()).sort()).toEqual(['change', 'input', 'select', 'update:query']);
        expect(wrapper.find('textarea, table, [role="dialog"], [role="complementary"]').exists()).toBe(false);
        expect(source).not.toMatch(/localStorage|sessionStorage|fetch\(|v-html|frontmatter|JSON\.|:is=|ElCard|ElTable|:deep\(/);
        expect(source).not.toMatch(/min-width:\s*[1-9]|position:\s*fixed|grid-template-columns|transition|animation/);
    });
});
