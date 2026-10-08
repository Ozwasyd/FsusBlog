// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { ArticleRevisionMetadataDiffResponse, ArticleRevisionMetadataDiffValue } from '@/api/articleRevisionCompare';
import ArticleRevisionMetadataDiffView from '@/components/admin/article/ArticleRevisionMetadataDiffView.vue';

const value = (kind: ArticleRevisionMetadataDiffValue['kind'], payload: Partial<ArticleRevisionMetadataDiffValue> = {}): ArticleRevisionMetadataDiffValue =>
    ({ kind, text: null, number: null, boolean: null, ids: [], ...payload });

// Deliberate typed presentation inputs; these tests do not assert receipt authenticity.
function metadata(): ArticleRevisionMetadataDiffResponse
{
    const fields: ArticleRevisionMetadataDiffResponse['fields'] = [
        { fieldId: 'title', before: value(3, { text: '<script>old</script>' }), after: value(3, { text: '' }), change: 3 },
        { fieldId: 'missing', before: value(0), after: value(1), change: 5 },
        { fieldId: 'null', before: value(2), after: value(8), change: 3 },
        { fieldId: 'integer', before: value(4, { number: '9007199254740993' }), after: value(4, { number: '-9223372036854775808' }), change: 3 },
        { fieldId: 'time', before: value(6, { number: '638961048000000001' }), after: value(6, { number: '638961048000000002' }), change: 3 },
        { fieldId: 'set', before: value(8, { ids: [1, 2] }), after: value(8, { ids: [2, 3] }), change: 4 },
        { fieldId: 'private', before: value(3, { text: 'private value' }), after: value(3, { text: 'private value' }), change: 0 }
    ].map(field => ({ beforePackageDigest: 'a'.repeat(64), afterPackageDigest: 'b'.repeat(64), authority: 'unit', normalization: 'none',
        displayFormat: 'unit', sensitive: field.fieldId === 'private', addedIds: field.fieldId === 'set' ? [3] : [],
        removedIds: field.fieldId === 'set' ? [1] : [], ...field })) as ArticleRevisionMetadataDiffResponse['fields'];
    return { receipt: { engineVersion: 'unit', projectionVersion: 'unit', registryDigest: 'c'.repeat(64), status: 1, coverage: 2,
        reason: 'metadata_diff_missing_authority', planDigest: 'd'.repeat(64), basePackageDigest: 'a'.repeat(64), comparePackageDigest: 'b'.repeat(64),
        fieldCount: fields.length, missingAuthorities: ['historical_lifecycle_missing_authority'], contentDigest: 'e'.repeat(64) },
    fields, timing: { elapsedTicks: '9007199254740993', frequency: '1000000000' }, isSuccess: false, isReviewable: true };
}

describe('typed metadata receipt presentation', () =>
{
    it('distinguishes partial authority, typed empty values, exact integers and sensitive values', () =>
    {
        const wrapper = mount(ArticleRevisionMetadataDiffView, { props: { metadata: metadata() } });
        expect(wrapper.get('[role="alert"]').text()).toContain('历史生命周期尚未核验');
        expect(wrapper.find('[role="status"]').exists()).toBe(false);
        expect(wrapper.find('script').exists()).toBe(false);
        expect(wrapper.text()).toContain('<script>old</script>');
        expect(wrapper.text()).toContain('空字符串');
        expect(wrapper.text()).toContain('空值（null）');
        expect(wrapper.text()).toContain('空集合');
        expect(wrapper.text()).toContain('未观测（缺少权威来源）');
        expect(wrapper.text()).toContain('本字段不是未变化');
        expect(wrapper.text()).toContain('9007199254740993');
        expect(wrapper.text()).toContain('-9223372036854775808');
        expect(wrapper.text()).toContain('UTC ticks 638961048000000001');
        expect(wrapper.text()).toContain('UTC ticks 638961048000000002');
        expect(wrapper.get('[data-field-id="set"]').text()).toContain('+ 3；− 1');
        expect(wrapper.text()).not.toContain('private value');
        wrapper.unmount();
    });

    it('renders a replacement receipt reactively without retaining prior values', async () =>
    {
        const wrapper = mount(ArticleRevisionMetadataDiffView, { props: { metadata: metadata() } });
        const next = metadata();
        next.fields = [{ ...next.fields[0], before: value(3, { text: 'replacement old' }), after: value(3, { text: 'replacement new' }) }];
        next.receipt = { ...next.receipt, status: 0, coverage: 1, reason: 'accepted', fieldCount: 1, missingAuthorities: [] };
        next.isSuccess = true;
        await wrapper.setProps({ metadata: next });
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.get('[role="status"]').text()).toContain('完整');
        expect(wrapper.text()).toContain('replacement new');
        expect(wrapper.text()).not.toContain('9007199254740993');
        wrapper.unmount();
    });

    it('preserves authoritative absent states even when the field is sensitive and uses safe unknown authority labels', () =>
    {
        const input = metadata();
        input.fields = [{ ...input.fields[0], sensitive: true, before: value(0), after: value(1), change: 5 },
            { ...input.fields[1], sensitive: true, before: value(2), after: value(3, { text: 'private present value' }) }];
        input.receipt.missingAuthorities = ['unknown_technical_reason'];
        const wrapper = mount(ArticleRevisionMetadataDiffView, { props: { metadata: input } });
        expect(wrapper.text()).toContain('未观测（缺少权威来源）');
        expect(wrapper.text()).toContain('不适用');
        expect(wrapper.text()).toContain('空值（null）');
        expect(wrapper.text()).toContain('已隐去敏感值');
        expect(wrapper.text()).not.toContain('private present value');
        expect(wrapper.get('[role="alert"]').text()).toContain('其他字段缺少权威来源');
        expect(wrapper.text()).not.toContain('unknown_technical_reason');
        wrapper.unmount();
    });
});
