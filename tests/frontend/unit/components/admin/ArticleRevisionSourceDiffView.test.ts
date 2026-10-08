// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import ArticleRevisionSourceDiffView from '@/components/admin/article/ArticleRevisionSourceDiffView.vue';

import type { RevisionSourcePresentation } from '@/services/revisionComparePresentation';
import { emitTelemetry } from '@/services/telemetryBus';

vi.mock('@/services/telemetryBus', () => ({ emitTelemetry: vi.fn() }));

const Button = defineComponent({ name: 'ElButton', inheritAttrs: false, setup(_, { attrs, slots }) { return () => h('button', attrs, slots.default?.()); } });
const range = (offset: number, length: number) => ({ offset, length, end: offset + length });
// Deliberate presentation fixture; authenticity belongs to the backend and request joins.
function presentation(): RevisionSourcePresentation
{
    const bytes = new TextEncoder().encode('# 标题\n<script>source</script>\n');
    return { response: { planReceipt: { planDigest: 'a'.repeat(64), basePackageDigest: 'b'.repeat(64), comparePackageDigest: 'c'.repeat(64) },
        sourceDiff: { receipt: { chunkCount: 1 } } }, baseBytes: bytes, compareBytes: bytes,
    rows: [{ id: 'context-1', kind: 0, base: [{ text: '# 标题\n', changed: false }], compare: [{ text: '# 标题\n', changed: false }],
        baseRange: range(0, 9), compareRange: range(0, 9), baseLine: 1, compareLine: 1, collapsed: true, headingIdentities: [] },
    { id: 'change-1', kind: 3, base: [{ text: '<script>source</script>\n', changed: true }], compare: [{ text: '<script>source</script>\n', changed: true }],
        baseRange: range(9, bytes.length - 9), compareRange: range(9, bytes.length - 9), baseLine: 2, compareLine: 2, collapsed: false, headingIdentities: ['heading-1'] }],
    headings: [{ identity: 'heading-1', label: '# 标题', rowId: 'context-1' }] } as RevisionSourcePresentation;
}
const render = () => mount(ArticleRevisionSourceDiffView, { attachTo: document.body, props: { presentation: presentation(), split: false }, global: { components: { ElButton: Button } } });

describe('single inspector source receipt renderer', () =>
{
    it('renders text, retains server groups, navigates changes and expands heading ranges', async () =>
    {
        const wrapper = render();
        expect(wrapper.find('script').exists()).toBe(false);
        expect(wrapper.text()).toContain('<script>source</script>');
        expect(wrapper.findAll('pre')).toHaveLength(2);
        await wrapper.findAll('button')[1].trigger('click');
        expect(document.activeElement?.getAttribute('data-range-id')).toBe('change-1');
        expect(wrapper.text()).toContain('第 1 / 1 处变化');
        await wrapper.find('select').setValue('heading-1');
        await nextTick();
        expect(document.activeElement?.getAttribute('data-range-id')).toBe('context-1');
        expect(wrapper.findAll('pre')).toHaveLength(4);
        await wrapper.setProps({ split: true });
        expect(wrapper.findAll('.revision-source-row--split')).toHaveLength(2);
        wrapper.unmount();
    });

    it('copies only the authorized range and emits identity, never source values', async () =>
    {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const wrapper = render();
        const copy = wrapper.findAll('button').find(button => button.text() === '复制基准范围')!;
        await copy.trigger('click');
        await nextTick();
        expect(writeText).toHaveBeenCalledWith('<script>source</script>\n');
        const event = wrapper.emitted('copy-range')![0][0];
        expect(event).toMatchObject({ planDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64), side: 'base', range: { offset: 9 } });
        expect(JSON.stringify(event)).not.toContain('source</script>');
        expect(emitTelemetry).toHaveBeenLastCalledWith('revision_diff_action', {
            action: 'copy_base', mode: 0, status: 'accepted', count: presentation().baseBytes.length - 9,
            rangeOffset: 9, planDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64)
        });
        wrapper.unmount();
    });

    it('preserves folds across modes and ignores shortcuts inside controls', async () =>
    {
        const wrapper = render();
        const toggle = wrapper.findAll('button').find(button => button.text() === '展开未变化范围')!;
        await toggle.trigger('click');
        await wrapper.setProps({ split: true });
        expect(wrapper.findAll('pre')).toHaveLength(4);
        await wrapper.find('select').trigger('keydown', { key: 'Home' });
        expect(wrapper.text()).not.toContain('第 1 / 1 处变化');
        wrapper.unmount();
    });
});
