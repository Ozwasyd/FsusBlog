// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { describe, expect, it } from 'vitest';

import ArticleBulkImpactPreview from '@/components/admin/article/ArticleBulkImpactPreview.vue';
import ArticleBulkExecutionProgress from '@/components/admin/article/ArticleBulkExecutionProgress.vue';
import ArticleBulkOperationParameters from '@/components/admin/article/ArticleBulkOperationParameters.vue';
import ArticleBulkResults from '@/components/admin/article/ArticleBulkResults.vue';
import ArticleBulkSelectionBar from '@/components/admin/article/ArticleBulkSelectionBar.vue';
import type { ArticleBulkPlanSummary, ArticleBulkResultSummary } from '@/services/authoring/articleBulkPresentation';

const Button = defineComponent({ props: { disabled: Boolean }, emits: ['click'], template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' });
const Select = defineComponent({ props: ['modelValue', 'disabled'], emits: ['update:modelValue'], template: '<select :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>' });
const Option = defineComponent({ props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' });
const Input = defineComponent({ props: ['modelValue', 'disabled', 'type'], emits: ['update:modelValue'], template: '<input :type="type" :disabled="disabled" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' });
const stubs = { ElButton: Button, ElSelect: Select, ElOption: Option, ElInput: Input,
    ElForm: { template: '<form><slot /></form>' }, ElFormItem: { template: '<label><slot /></label>' },
    ElTable: true, ElTableColumn: true };
const plan: ArticleBulkPlanSummary = {
    reference: 'plan:one', digest: 'sha256:plan', registryDigest: 'sha256:registry', operationId: 'lifecycle.archive', operationLabel: '归档文章',
    strategy: 'all-or-nothing', selection: { reference: 'selection:page', digest: 'sha256:page', kind: 'current-page', count: 10_000 },
    selectedCount: 10_000, eligibleCount: 10_000, blockedCount: 0, conflictCount: 0, executable: true,
    expiresAtUtc: '2026-10-08T06:30:00Z', proposedChange: '将确切选择的文章归档', impactPageReference: 'impact:first'
};
const result: ArticleBulkResultSummary = {
    executionReference: 'attempt:one', planDigest: plan.digest, receiptReference: 'receipt:one', receiptDigest: 'sha256:receipt', strategy: 'per-item-isolated',
    state: 'partial', selectedCount: 10_000, eligibleCount: 10_000, succeededCount: 9999, failedCount: 1,
    blockedCount: 0, cancelledCount: 0, notExecutedCount: 0, commitOutcome: null, itemPageReference: 'items:first'
};

describe('article bulk product composition', () => {
    it('requests canonical cancellation only before the server commit point', async () => {
        const wrapper = mount(ArticleBulkExecutionProgress, { props: { busy: false, progress: {
            executionReference: 'attempt:one', planDigest: plan.digest, strategy: 'all-or-nothing', state: 'executing',
            selectedCount: 10_000, eligibleCount: 10_000, succeededCount: 0, failedCount: 0, cancelledCount: 0, cancelAllowed: true
        } }, global: { stubs } });
        const cancel = wrapper.findAll('button').find(button => button.text() === '请求取消')!;
        await cancel.trigger('click');
        expect(wrapper.emitted('cancel')).toHaveLength(1);
        await wrapper.setProps({ progress: { ...wrapper.props('progress'), cancelAllowed: false } });
        expect(cancel.attributes('disabled')).toBeDefined();
        expect(wrapper.text()).toContain('等待核实结果');
    });
    it('hides an empty selection and names the exact page source at 10000 identities', () => {
        const wrapper = mount(ArticleBulkSelectionBar, { props: { selection: plan.selection, operations: [], operationId: null, busy: false }, global: { stubs } });
        expect(wrapper.text()).toContain('已选择 10000 篇');
        expect(wrapper.text()).toContain('当前页的确切文章');
        expect(wrapper.findAll('option')).toHaveLength(0);
        const empty = mount(ArticleBulkSelectionBar, { props: { selection: { ...plan.selection, count: 0 }, operations: [], operationId: null, busy: false }, global: { stubs } });
        expect(empty.find('section').exists()).toBe(false);
    });

    it('shows fixed strategy copy and requires an explicit unexpired confirmation', async () => {
        const wrapper = mount(ArticleBulkImpactPreview, { props: { plan, expired: false, busy: false }, global: { stubs } });
        expect(wrapper.get('[data-strategy]').text()).toContain('任一失败则全部不提交');
        const confirm = wrapper.findAll('button').find(button => button.text() === '确认执行此计划')!;
        await confirm.trigger('click');
        expect(wrapper.emitted('confirm')).toHaveLength(1);
        await wrapper.setProps({ expired: true });
        expect(confirm.attributes('disabled')).toBeDefined();
        expect(wrapper.get('[role="alert"]').text()).toContain('重新预览并确认');
        await wrapper.setProps({ plan: { ...plan, strategy: 'per-item-isolated' }, expired: false });
        expect(wrapper.get('[data-strategy]').text()).toContain('可能部分完成');
    });

    it('renders truthful partial counts and loads exactly one page by canonical reference', async () => {
        const wrapper = mount(ArticleBulkResults, { props: { result, page: null, retryPolicies: [], busy: false }, global: { stubs } });
        expect(wrapper.text()).toContain('部分处理成功');
        expect(wrapper.text()).toContain('成功 9999 · 失败 1');
        expect(wrapper.text()).not.toContain('批量完成');
        await wrapper.findAll('button').find(button => button.text() === '查看逐项结果')!.trigger('click');
        expect(wrapper.emitted('page')).toEqual([['items:first']]);
        expect(wrapper.findAll('el-table-stub')).toHaveLength(0);
    });

    it('shows zero-written failure and blocks retry when the commit conclusion is unknown', () => {
        const wrapper = mount(ArticleBulkResults, { props: { result: { ...result, strategy: 'all-or-nothing', state: 'failed', succeededCount: 0,
            failedCount: 10_000, commitOutcome: 'zero-written' }, page: null, retryPolicies: [], busy: false }, global: { stubs } });
        expect(wrapper.text()).toContain('未提交任何文章');
        const unknown = mount(ArticleBulkResults, { props: { result: { ...result, strategy: 'all-or-nothing', state: 'recovery-required', commitOutcome: 'unknown' },
            page: null, retryPolicies: [{ reference: 'policy:explicit', label: '重新确认版本' }], busy: false }, global: { stubs } });
        expect(unknown.get('[role="alert"]').text()).toContain('请完成恢复');
        expect(unknown.find('select').exists()).toBe(false);
    });

    it('parameter controls emit stable IDs rather than ambiguous display labels', async () => {
        const wrapper = mount(ArticleBulkOperationParameters, { props: {
            fields: [{ name: 'categoryId', label: '分类', type: 'opaque-id', options: [{ id: 'category:first', label: '同名分类' }, { id: 'category:second', label: '同名分类' }] }],
            values: {}, disabled: false
        }, global: { stubs } });
        await wrapper.get('select').setValue('category:second');
        expect(wrapper.emitted('parameter')).toEqual([['categoryId', 'category:second']]);
    });

    it('schedule control explicitly produces a UTC parameter', async () => {
        const wrapper = mount(ArticleBulkOperationParameters, { props: {
            fields: [{ name: 'scheduledAtUtc', label: '计划时间', type: 'rfc3339-utc', options: [] }], values: {}, disabled: false
        }, global: { stubs } });
        await wrapper.get('input').setValue('2026-10-09T12:30');
        expect(wrapper.emitted('parameter')?.at(-1)).toEqual(['scheduledAtUtc', '2026-10-09T12:30:00Z']);
        expect(wrapper.text()).toContain('时间以 UTC 确认');
    });
});
