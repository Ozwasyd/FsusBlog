// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ElPagination } from '@ozwasyd/element-plus';
import AuthoringCanvasOutlineView from '@/components/admin/canvas/AuthoringCanvasOutlineView.vue';
import type { OutlineItem } from '@/composables/useAuthoringCanvas';

const items: OutlineItem[] = Array.from({ length: 10000 }, (_, index) => ({
    id: `display-fixture-${index}`, kind: 'node', type: 'plain-text-note', title: `Display fixture ${index}`, selected: false
}));
describe('Canvas bounded outline display', () => {
    it('renders at most 100 rows and retains source order and reachable page controls at 10000 items', async () => {
        const wrapper = mount(AuthoringCanvasOutlineView, { props: { items } });
        expect(wrapper.findAll('.outline-item')).toHaveLength(100);
        expect(wrapper.find('.outline-item').attributes('data-outline-id')).toBe(items[0].id);
        wrapper.findComponent(ElPagination).vm.$emit('update:current-page', 2);
        await wrapper.vm.$nextTick();
        expect(wrapper.findAll('.outline-item')).toHaveLength(100);
        expect(wrapper.find('.outline-item').attributes('data-outline-id')).toBe(items[100].id);
        await wrapper.setProps({ items: items.slice(0, 1) });
        expect(wrapper.findAll('.outline-item')).toHaveLength(1);
        expect(wrapper.find('.outline-item').attributes('data-outline-id')).toBe(items[0].id);
        wrapper.unmount();
    });
    it('keeps an externally selected item in the rendered page without modifying source identities or actions', async () => {
        const wrapper = mount(AuthoringCanvasOutlineView, { props: { items } });
        const selected = items.map((item, index) => ({ ...item, selected: index === 3005 }));
        await wrapper.setProps({ items: selected });
        expect(wrapper.findAll('.outline-item')).toHaveLength(100);
        expect(wrapper.find('.outline-item.selected').attributes('data-outline-id')).toBe(items[3005].id);
        await wrapper.find('.outline-item.selected').trigger('keydown', { key: 'Enter' });
        expect(wrapper.emitted('select-item')?.[0]?.[0]).toEqual(selected[3005]);
        const reordered = [...selected.slice(3000), ...selected.slice(0, 3000)];
        await wrapper.setProps({ items: reordered });
        expect(wrapper.find('.outline-item.selected').attributes('data-outline-id')).toBe(items[3005].id);
        wrapper.unmount();
    });
    it('places the public responsive pager before the scrolling list', () => {
        const wrapper = mount(AuthoringCanvasOutlineView, { props: { items } });
        const pager = wrapper.findComponent(ElPagination);
        expect(pager.props('responsive')).toBe('auto');
        expect(pager.element.compareDocumentPosition(wrapper.find('.outline-list').element)
            & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        wrapper.unmount();
    });
    it('reveals same-page and last-page selection without stealing external focus, and returns owned focus to selection', async () => {
        const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
        const outside = document.createElement('button');
        document.body.append(outside);
        const wrapper = mount(AuthoringCanvasOutlineView, { props: { items }, attachTo: document.body });
        outside.focus();
        await wrapper.setProps({ items: items.map((item, index) => ({ ...item, selected: index === 99 })) });
        await wrapper.vm.$nextTick();
        expect(document.activeElement).toBe(outside);
        expect(reveal.mock.instances.at(-1)).toBe(wrapper.find('.outline-item.selected').element);
        expect(reveal).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        (wrapper.find('.outline-item').element as HTMLElement).focus();
        await wrapper.setProps({ items: items.map((item, index) => ({ ...item, selected: index === 9999 })) });
        await wrapper.vm.$nextTick();
        expect(wrapper.findAll('.outline-item')).toHaveLength(100);
        expect(wrapper.find('.outline-item.selected').attributes('data-outline-id')).toBe(items[9999].id);
        expect(document.activeElement).toBe(wrapper.find('.outline-item.selected').element);
        expect(reveal.mock.instances.at(-1)).toBe(wrapper.find('.outline-item.selected').element);
        wrapper.unmount();
        outside.remove();
        reveal.mockRestore();
    });
    it('returns removed row focus to a visible row, preserves pagination focus and handles empty items', async () => {
        const wrapper = mount(AuthoringCanvasOutlineView, { props: { items }, attachTo: document.body });
        const row = wrapper.find('.outline-item').element as HTMLElement;
        row.focus();
        expect(document.activeElement).toBe(row);
        wrapper.findComponent(ElPagination).vm.$emit('update:current-page', 2);
        await wrapper.vm.$nextTick();
        await wrapper.vm.$nextTick();
        expect(document.activeElement).toBe(wrapper.find('.outline-item').element);
        const paginationButton = wrapper.find('.el-pagination button').element as HTMLElement;
        paginationButton.focus();
        wrapper.findComponent(ElPagination).vm.$emit('update:current-page', 3);
        await wrapper.vm.$nextTick();
        await wrapper.vm.$nextTick();
        expect(document.activeElement).toBe(paginationButton);
        await wrapper.setProps({ items: [] });
        expect(wrapper.findAll('.outline-item')).toHaveLength(0);
        expect(wrapper.find('.outline-empty').exists()).toBe(true);
        expect(wrapper.findComponent(ElPagination).exists()).toBe(false);
        wrapper.unmount();
    });
});
