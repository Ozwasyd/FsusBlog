// @vitest-environment happy-dom

import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, onUnmounted } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ArticleLinkInspectorSections from '@/components/admin/article/ArticleLinkInspectorSections.vue';

const sections = ['outgoing', 'backlinks', 'risks', 'mentions'] as const;
const labels = {
    titles: { outgoing: 'Outgoing', backlinks: 'Backlinks', risks: 'Risks', mentions: 'Mentions' },
    states: {
        loading: 'Loading', error: 'Unavailable', stale: 'Refresh required',
        'rebuild-required': 'Rebuild required', offline: 'Offline'
    },
    unavailable: 'Links unavailable', empty: 'No results', previous: 'Previous', next: 'Next'
};
const wrappers: VueWrapper[] = [];
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

function page(rowIds: readonly string[] = ['relation:one']) {
    return {
        contextKey: 'document:1:permission:1:index:1', pageKey: 'page:1',
        state: 'current' as const, rowIds, hasPreviousPage: false, hasNextPage: true
    };
}

function harness(options: { rowIds?: readonly string[]; unmounted?: () => void } = {}) {
    const Row = defineComponent({
        props: { rowId: { type: String, required: true } },
        setup(props) {
            onUnmounted(() => options.unmounted?.());
            return () => h('button', { type: 'button' }, `Verified owner row ${props.rowId}`);
        }
    });
    const wrapper = mount(ArticleLinkInspectorSections, {
        props: {
            available: true, contextKey: page().contextKey, labels,
            pages: Object.fromEntries(sections.map((section) => [section, page(options.rowIds ?? [`${section}:1`])]))
        },
        slots: Object.fromEntries(sections.map((section) => [section, ({ rowId }: { rowId: string }) => h(Row, { rowId })]))
    });
    wrappers.push(wrapper);
    return wrapper;
}

describe('nested link inspector sections with real alias-resolved FsusUI primitives', () => {
    it('renders exactly four ordered text sections and forwards unchanged identities to owner controls', () => {
        const wrapper = harness();
        expect(wrapper.findAll('h3').map((heading) => heading.text())).toEqual(Object.values(labels.titles));
        expect(wrapper.findAll('[role="list"]')).toHaveLength(4);
        expect(wrapper.findAll('[role="listitem"] button').map((button) => button.text()))
            .toEqual(sections.map((section) => `Verified owner row ${section}:1`));
        expect(wrapper.findAll('section').map((section) => section.attributes('aria-label'))).toEqual(Object.values(labels.titles));
        expect(wrapper.emitted('page')).toBeUndefined();
    });

    it('shows empty sections without manufacturing counts or rows', () => {
        const wrapper = harness({ rowIds: [] });
        expect(wrapper.findAll('[role="status"]').map((status) => status.text())).toEqual(Array(4).fill(labels.empty));
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        expect(wrapper.text()).not.toContain('Verified owner row');
    });

    it.each(['loading', 'error', 'stale', 'rebuild-required', 'offline'] as const)
    ('unmounts old title/context/action slots when the owner marks a page %s', async (state) => {
        const unmounted = vi.fn();
        const wrapper = harness({ unmounted });
        await wrapper.setProps({ pages: { outgoing: { ...page(['private:old-title']), state } } });
        expect(unmounted).toHaveBeenCalledTimes(4);
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        expect(wrapper.text()).not.toContain('private:old-title');
        expect(wrapper.findAll('section')[0]?.find('[role="status"]').text()).toBe(labels.states[state]);
        expect(wrapper.findAll('button')).toHaveLength(0);
    });

    it('scrubs all slots and controls on owner permission unavailability', async () => {
        const unmounted = vi.fn();
        const wrapper = harness({ unmounted });
        await wrapper.setProps({ available: false });
        expect(unmounted).toHaveBeenCalledTimes(4);
        expect(wrapper.text()).toBe(labels.unavailable);
        expect(wrapper.findAll('section')).toHaveLength(0);
        expect(wrapper.findAll('button')).toHaveLength(0);
    });

    it('rejects old async pages after a document/permission/index generation transition', async () => {
        const wrapper = harness();
        await wrapper.setProps({ contextKey: 'document:2:permission:2:index:2' });
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        expect(wrapper.findAll('[role="status"]').every((status) => status.text() === labels.states.stale)).toBe(true);
        await wrapper.setProps({ pages: { outgoing: page(['delayed:private']) } });
        expect(wrapper.text()).not.toContain('delayed:private');
        expect(wrapper.findAll('button')).toHaveLength(0);
    });

    it('unmounts old row controls when the current owner page revision changes', async () => {
        const unmounted = vi.fn();
        const wrapper = harness({ unmounted });
        await wrapper.setProps({ pages: { outgoing: { ...page(['outgoing:1']), pageKey: 'page:2' } } });
        expect(unmounted).toHaveBeenCalledTimes(4);
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(1);
    });

    it('emits the exact current section/context/page coordinate without performing navigation or writes', async () => {
        const wrapper = harness();
        const buttons = wrapper.findAll('section')[0]!.findAll('button');
        expect(buttons[0]?.attributes('disabled')).toBeDefined();
        expect(buttons[1]?.attributes('type')).toBe('button');
        await buttons[1]!.trigger('click');
        expect(wrapper.emitted('page')).toEqual([[{
            section: 'outgoing', direction: 'next', contextKey: page().contextKey, pageKey: 'page:1'
        }]]);
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(4);
    });

    it('cannot emit paging after current context becomes stale', async () => {
        const wrapper = harness();
        const oldButton = wrapper.findAll('section')[0]!.findAll('button')[1]!;
        await wrapper.setProps({ contextKey: 'document:2' });
        await oldButton.trigger('click');
        expect(wrapper.emitted('page')).toBeUndefined();
    });

    it.each([
        { name: 'duplicate identities', rows: ['same', 'same'] },
        { name: 'empty identity', rows: [''] },
        { name: 'unbounded 1000-row response', rows: Array.from({ length: 1000 }, (_, i) => `relation:${i}`) }
    ])('does not slice or repair invalid owner pages: $name', async ({ rows }) => {
        const wrapper = harness({ rowIds: rows });
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.text()).not.toContain('Verified owner row');
        expect(wrapper.findAll('[role="status"]').every((status) => status.text() === labels.states.stale)).toBe(true);
    });

    it('keeps 1000 upstream facts bounded to the current 20-row owner page and preserves order', async () => {
        const facts = Array.from({ length: 1000 }, (_, i) => `relation:${i}`);
        const wrapper = harness({ rowIds: facts.slice(0, 20) });
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(80);
        await wrapper.setProps({ pages: { outgoing: { ...page(facts.slice(980)), pageKey: 'page:50', hasPreviousPage: true, hasNextPage: false } } });
        expect(wrapper.findAll('[role="listitem"] button').map((button) => button.text()))
            .toEqual(facts.slice(980).map((id) => `Verified owner row ${id}`));
        const controls = wrapper.findAll('section')[0]!.findAll('button');
        expect(controls[1]?.attributes('disabled')).toBeDefined();
        await controls[0]!.trigger('click');
        expect(wrapper.emitted('page')).toEqual([[{
            section: 'outgoing', direction: 'previous', contextKey: page().contextKey, pageKey: 'page:50'
        }]]);
    });

    it('does not confuse an absent page with an empty authoritative response', async () => {
        const wrapper = harness();
        await wrapper.setProps({ pages: {} });
        expect(wrapper.findAll('[role="status"]').every((status) => status.text() === labels.states.loading)).toBe(true);
    });

    it('requires nonempty owner context and page revisions before mounting a row', async () => {
        const wrapper = harness();
        await wrapper.setProps({ pages: { outgoing: { ...page(), pageKey: '' } } });
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        await wrapper.setProps({ contextKey: '', pages: { outgoing: { ...page(), contextKey: '' } } });
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
        expect(wrapper.findAll('button')).toHaveLength(0);
    });
});
