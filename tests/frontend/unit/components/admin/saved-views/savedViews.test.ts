// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import SavedViewQueryBuilder from '@/components/admin/saved-views/SavedViewQueryBuilder.vue';
import SavedViewSurface from '@/components/admin/saved-views/SavedViewSurface.vue';
import {
    cloneSavedViewDraft,
    validateSavedViewDraft
} from '@/components/admin/saved-views/savedViewBuilder';
import type {
    SavedViewBuilderDefinitions,
    SavedViewQueryDraft,
    SavedViewQuerySnapshot
} from '@/components/admin/saved-views/savedViewBuilder';
import {
    buildSavedViewDeepLink,
    readSavedViewDeepLink
} from '@/components/admin/saved-views/savedViewDeepLink';

const viewId = '11111111-1111-4111-8111-111111111111';
const definitions: SavedViewBuilderDefinitions = {
    schemaVersion: 1,
    maxConditions: 64,
    maxValuesPerCondition: 64,
    maxProjectionFields: 32,
    maxPageSize: 100,
    maxValueLength: 512,
    timeZones: ['UTC', 'Asia/Shanghai'],
    fields: [
        {
            field: { kind: 0, identity: 'article.lifecycle.status' },
            label: '生命周期',
            operators: [
                { id: 'identity.equals', label: '等于', cardinality: 1, valueKind: 1 },
                { id: 'identity.any-of', label: '满足任一', cardinality: 2, valueKind: 1 }
            ],
            choices: [{ value: 'draft', label: '草稿' }, { value: 'published', label: '已发布' }]
        },
        {
            field: { kind: 3, identity: 'author-search.current' },
            label: '全文',
            operators: [{ id: 'author-search.match', label: '匹配', cardinality: 1, valueKind: 2 }],
            choices: []
        },
        {
            field: { kind: 7, identity: 'article.created-at' },
            label: '创建日期',
            operators: [
                { id: 'date.between', label: '包含起止日', cardinality: 3, valueKind: 3 },
                { id: 'value.is-missing', label: '未填写', cardinality: 0, valueKind: 0 }
            ],
            choices: []
        }
    ]
};

function query(): SavedViewQueryDraft {
    return {
        schemaVersion: 1,
        conditions: [
            { field: { kind: 0, identity: 'article.lifecycle.status' }, operatorId: 'identity.any-of', values: ['draft', 'published'] },
            { field: { kind: 3, identity: 'author-search.current' }, operatorId: 'author-search.match', values: ['原始 私密检索'] },
            { field: { kind: 7, identity: 'article.created-at' }, operatorId: 'date.between', values: ['2026-10-01', '2026-10-08'], timeZoneId: 'Asia/Shanghai' }
        ],
        sort: { field: { kind: 7, identity: 'article.created-at' }, direction: 1, nullPlacement: 1, collation: 'temporal', stableTieBreaker: 'article.id', timeZoneId: 'Asia/Shanghai' },
        projection: [{ kind: 0, identity: 'article.lifecycle.status' }],
        pageSize: 50
    };
}

function snapshot(revision: number, value = query(), identity = viewId): SavedViewQuerySnapshot {
    return { viewId: identity, revision, query: value };
}

const mounted: ReturnType<typeof mount>[] = [];
function builder(overrides: Record<string, unknown> = {}) {
    const { query: initialQuery = query(), ...props } = overrides;
    const wrapper = mount(SavedViewQueryBuilder, {
        attachTo: document.body,
        props: { viewId, revision: 7, snapshot: snapshot(7, initialQuery as SavedViewQueryDraft), definitions, ...props }
    });
    mounted.push(wrapper);
    return wrapper;
}

afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('saved-view draft projection', () => {
    it('uses the existing owner coordinates and budgets', () => {
        const source = readFileSync(resolve(process.cwd(), '../backend/Services/Authoring/AuthorSavedViewContracts.cs'), 'utf8');
        for (const [name, value] of Object.entries({
            SchemaVersion: definitions.schemaVersion,
            MaxConditions: definitions.maxConditions,
            MaxValuesPerCondition: definitions.maxValuesPerCondition,
            MaxProjectionFields: definitions.maxProjectionFields,
            MaxPageSize: definitions.maxPageSize,
            MaxValueLength: definitions.maxValueLength
        })) expect(source).toContain(`public const int ${name} = ${value};`);
        for (const field of definitions.fields) {
            expect(source).toContain(`"${field.field.identity}"`);
            for (const operator of field.operators) expect(source).toContain(`"${operator.id}"`);
        }
    });

    it('roundtrips all conditions, ordered date operands, timezone, sort and projection', () => {
        const original = query();
        const copy = cloneSavedViewDraft(original);
        expect(copy).toEqual(original);
        copy.conditions[0]!.values.push('other');
        copy.sort.field.identity = 'changed';
        copy.projection[0]!.identity = 'changed';
        expect(original).toEqual(query());
        expect(validateSavedViewDraft(query(), definitions)).toEqual([]);
    });

    it.each([0, 2, 99])('refuses unsupported schema %i without dropping conditions', schemaVersion => {
        const original = { ...query(), schemaVersion };
        expect(validateSavedViewDraft(original, definitions)).toHaveLength(1);
        expect(cloneSavedViewDraft(original)).toEqual(original);
    });

    it('preserves unknown/deleted fields and future operators instead of weakening the query', () => {
        const original = query();
        original.conditions.push({ field: { kind: 4, identity: 'property:deleted' }, operatorId: 'future.operator', values: ['private-value'] });
        expect(validateSavedViewDraft(original, definitions)).toContainEqual({ conditionIndex: 3, reason: '字段或操作符不可用；此条件未被移除。' });
        expect(cloneSavedViewDraft(original)).toEqual(original);
    });

    it('refuses ambiguous definitions instead of selecting the first matching label', () => {
        expect(validateSavedViewDraft(query(), { ...definitions, fields: [...definitions.fields, definitions.fields[0]!] })).not.toEqual([]);
    });

    it('keeps authority-owned property operands read-only until their owner control is available', () => {
        const draft = query();
        const field = { kind: 4, identity: 'property:typed-owner' };
        draft.conditions.push({ field, operatorId: 'property.equals', values: ['original-typed-value'] });
        const supplied = { ...definitions, fields: [...definitions.fields, {
            field,
            label: '类型化属性',
            operators: [{ id: 'property.equals', label: '等于', cardinality: 1, valueKind: 6 }],
            choices: []
        }] };
        expect(validateSavedViewDraft(draft, supplied)).toContainEqual({
            conditionIndex: 3,
            reason: '此条件需要原 owner 的类型化控件；此条件未被移除。'
        });
        expect(cloneSavedViewDraft(draft).conditions[3]).toEqual(draft.conditions[3]);
    });

    it('enforces condition, value, projection and page budgets', () => {
        const draft = query();
        draft.conditions[0]!.values = Array.from({ length: 65 }, () => 'draft');
        draft.pageSize = 101;
        draft.projection = [];
        expect(validateSavedViewDraft(draft, { ...definitions, maxConditions: 2 })).toHaveLength(4);
    });

    it('validates same-field OR, duplicates, null cardinality and timezone explicitly', () => {
        const draft = query();
        draft.conditions.push(cloneSavedViewDraft(draft).conditions[0]!);
        draft.conditions[2]!.timeZoneId = 'not-a-zone';
        draft.conditions[1]!.values = ['', 'extra'];
        expect(validateSavedViewDraft(draft, definitions).map(issue => issue.reason)).toEqual(expect.arrayContaining([
            '同字段和操作符的条件重复，请使用同字段多选。',
            '请选择服务端支持的日期时区。',
            '条件值数量不符合操作符的服务端定义。',
            '条件值为空、过长或含控制字符。'
        ]));
        draft.conditions[2]!.operatorId = 'value.is-missing';
        expect(validateSavedViewDraft(draft, definitions).some(issue => issue.conditionIndex === 2)).toBe(true);
    });
});

describe('real Vue builder controls', () => {
    it('focuses the editor and returns focus to its trigger after Escape cancellation', async () => {
        const wrapper = builder();
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect(document.activeElement).toBe(wrapper.get('form').element);
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        expect(wrapper.text()).toContain('修改尚未同步');
        await wrapper.get('form').trigger('keydown', { key: 'Escape' });
        await nextTick();
        expect(wrapper.find('form').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.get('[data-action="edit"]').element);
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="每页数量"]').element as HTMLInputElement).value).toBe('50');
    });

    it('emits a detached CAS-bound draft and never writes an optimistic server revision', async () => {
        const original = query();
        const wrapper = builder({ query: original, submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('keydown', { key: 'Enter', ctrlKey: true });
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 7, query: { ...query(), pageSize: 25 } }]]);
        expect(original).toEqual(query());
        expect(wrapper.props('revision')).toBe(7);
    });

    it('defaults to unavailable save transport even for a valid edited AST', async () => {
        const wrapper = builder();
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        expect(wrapper.get('[data-action="submit"]').attributes('disabled')).toBeDefined();
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        expect(wrapper.text()).toContain('保存接口当前不可用');
    });

    it('rejects delayed Q8 after overlapping revision8 and revision9 deliveries', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.setProps({ revision: 8 });
        await wrapper.setProps({ revision: 9 });
        const delayed = query();
        delayed.conditions[1]!.values = ['延迟 Q8'];
        await wrapper.setProps({ snapshot: snapshot(8, delayed) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        if (wrapper.find('form').exists()) {
            await wrapper.get('input[aria-label="每页数量"]').setValue('25');
            await wrapper.get('form').trigger('submit');
        }
        expect(wrapper.emitted('submit')).toBeUndefined();
    });

    it.each(['older-first', 'newer-first'] as const)('uses only Q9 across overlapping %s response deliveries', async order => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.setProps({ revision: 8 });
        await wrapper.setProps({ revision: 9 });
        const q8 = query();
        q8.conditions[1]!.values = ['延迟 Q8'];
        const q9 = query();
        q9.conditions[1]!.values = ['当前 Q9'];
        const responses = order === 'older-first' ? [snapshot(8, q8), snapshot(9, q9)]
            : [snapshot(9, q9), snapshot(8, q8)];
        for (const response of responses) await wrapper.setProps({ snapshot: response });
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('当前 Q9');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 9, query: { ...q9, pageSize: 25 } }]]);
    });

    it.each([false, true])('keeps overlapping delivery and reopen bound to Q9 with dirty=%s', async dirty => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        if (dirty) await wrapper.get('input[aria-label="条件 2 值 1"]').setValue('保留本地条件');
        await wrapper.setProps({ revision: 8 });
        await wrapper.setProps({ revision: 9 });
        const q8 = query();
        q8.conditions[1]!.values = ['延迟 Q8'];
        await wrapper.setProps({ snapshot: snapshot(8, q8) });
        expect(wrapper.get('input[aria-label="每页数量"]').attributes('disabled')).toBeDefined();
        await wrapper.get('form').trigger('keydown', { key: 'Enter', ctrlKey: true });
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-action="cancel"]').trigger('click');
        expect(document.activeElement).toBe(wrapper.get('section[aria-label="视图筛选"]').element);
        expect(wrapper.get('[data-action="edit"]').attributes('disabled')).toBeDefined();
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect(wrapper.find('form').exists()).toBe(false);
        const q9 = query();
        q9.conditions[1]!.values = ['当前 Q9'];
        await wrapper.setProps({ snapshot: snapshot(9, q9) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('当前 Q9');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 9, query: { ...q9, pageSize: 25 } }]]);
    });

    it('preserves an open dirty draft until cancel when Q9 arrives after delayed Q8', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="条件 2 值 1"]').setValue('保留本地条件');
        await wrapper.setProps({ revision: 8 });
        await wrapper.setProps({ revision: 9 });
        await wrapper.setProps({ snapshot: snapshot(8) });
        const q9 = query();
        q9.conditions[1]!.values = ['当前 Q9'];
        await wrapper.setProps({ snapshot: snapshot(9, q9) });
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('保留本地条件');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-action="cancel"]').trigger('click');
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 9, query: { ...q9, pageSize: 25 } }]]);
    });

    it.each(['response-first', 'target-first'] as const)('rejects the prior view snapshot across %s view switches', async order => {
        const otherView = '22222222-2222-4222-8222-222222222222';
        const wrapper = builder({ submitAvailable: true });
        const otherQuery = query();
        otherQuery.conditions[1]!.values = ['另一视图条件'];
        await wrapper.setProps(order === 'response-first'
            ? { snapshot: snapshot(7, otherQuery, otherView) } : { viewId: otherView });
        await wrapper.setProps(order === 'response-first'
            ? { viewId: otherView } : { snapshot: snapshot(7, otherQuery, otherView) });
        await wrapper.setProps({ snapshot: snapshot(7, query(), viewId) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('另一视图条件');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{
            viewId: otherView, expectedRevision: 7, query: { ...otherQuery, pageSize: 25 }
        }]]);
    });

    it('rejects a delayed response from an intermediate view and recovers after switch-back', async () => {
        const middleView = '22222222-2222-4222-8222-222222222222';
        const finalView = '33333333-3333-4333-8333-333333333333';
        const wrapper = builder({ submitAvailable: true });
        await wrapper.setProps({ viewId: middleView });
        await wrapper.setProps({ viewId: finalView });
        await wrapper.setProps({ snapshot: snapshot(7, query(), middleView) });
        expect(wrapper.get('[data-action="edit"]').attributes('disabled')).toBeDefined();
        await wrapper.setProps({ snapshot: snapshot(7, query(), finalView) });
        await wrapper.setProps({ viewId, snapshot: snapshot(7) });
        await wrapper.setProps({ snapshot: snapshot(7, query(), finalView) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 7, query: { ...query(), pageSize: 25 } }]]);
    });

    it('accepts an explicitly bound new revision with the same query reference', async () => {
        const original = query();
        const wrapper = builder({ query: original, submitAvailable: true });
        await wrapper.setProps({ revision: 8 });
        await wrapper.setProps({ snapshot: snapshot(8, original) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 8, query: { ...original, pageSize: 25 } }]]);
    });

    it('submits the latest authoritative query after revision-first split updates', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        const latest = query();
        latest.conditions[1]!.values = ['服务端 Q8'];
        await wrapper.setProps({ revision: 8 });
        expect(wrapper.get('input[aria-label="每页数量"]').attributes('disabled')).toBeDefined();
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.setProps({ snapshot: snapshot(8, latest) });
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('服务端 Q8');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{
            viewId,
            expectedRevision: 8,
            query: { ...latest, pageSize: 25 }
        }]]);
    });

    it('preserves a dirty draft and refuses submission when only the authoritative query changes', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        const latest = query();
        latest.conditions[1]!.values = ['服务端刷新后的查询'];
        await wrapper.setProps({ snapshot: snapshot(8, latest) });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        expect((wrapper.get('input[aria-label="每页数量"]').element as HTMLInputElement).value).toBe('25');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('原始 私密检索');
        await wrapper.get('[data-action="cancel"]').trigger('click');
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('服务端刷新后的查询');
    });

    it.each(['query-first', 'revision-first'] as const)('recovers a clean editor, cancel focus and reopen after %s split prop orders', async order => {
        const wrapper = builder({ submitAvailable: true });
        const trigger = wrapper.get('[data-action="edit"]');
        await trigger.trigger('click');
        const latest = query();
        latest.conditions[1]!.values = ['配对的服务端 Q8'];
        await wrapper.setProps(order === 'query-first' ? { snapshot: snapshot(8, latest) } : { revision: 8 });
        await wrapper.setProps(order === 'query-first' ? { revision: 8 } : { snapshot: snapshot(8, latest) });
        expect(wrapper.get('input[aria-label="每页数量"]').attributes('disabled')).toBeUndefined();
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('配对的服务端 Q8');
        await wrapper.get('[data-action="cancel"]').trigger('click');
        const reopenedTrigger = wrapper.get('[data-action="edit"]');
        expect(document.activeElement).toBe(reopenedTrigger.element);
        expect(reopenedTrigger.attributes('disabled')).toBeUndefined();
        await reopenedTrigger.trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 8, query: { ...latest, pageSize: 25 } }]]);
    });

    it.each(['query-first', 'revision-first'] as const)('preserves dirty conflict refusal and recovers after %s split prop orders', async order => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="条件 2 值 1"]').setValue('本地未提交条件');
        const latest = query();
        latest.conditions[1]!.values = ['配对的服务端 Q8'];
        await wrapper.setProps(order === 'query-first' ? { snapshot: snapshot(8, latest) } : { revision: 8 });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.setProps(order === 'query-first' ? { revision: 8 } : { snapshot: snapshot(8, latest) });
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('本地未提交条件');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-action="cancel"]').trigger('click');
        expect(document.activeElement).toBe(wrapper.get('[data-action="edit"]').element);
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('配对的服务端 Q8');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 8, query: { ...latest, pageSize: 25 } }]]);
    });

    it('refuses a query-first gap CAS even after cancel and reopen', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        const latest = query();
        latest.conditions[1]!.values = ['尚未配对的 Q8'];
        await wrapper.setProps({ snapshot: snapshot(8, latest) });
        await wrapper.get('[data-action="cancel"]').trigger('click');
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.setProps({ revision: 8 });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
    });

    it('accepts a complete atomic source snapshot without rewriting its revision', async () => {
        const wrapper = builder({ submitAvailable: true });
        const latest = query();
        latest.conditions[1]!.values = ['原子快照 Q8'];
        await wrapper.setProps({ revision: 8, snapshot: snapshot(8, latest) });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 8, query: { ...latest, pageSize: 25 } }]]);
    });

    it('accepts a same-revision equivalent refresh after cancel and reopen', async () => {
        const original = query();
        const wrapper = builder({ query: original, submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.setProps({ revision: 7, snapshot: snapshot(7, cloneSavedViewDraft(original)) });
        await wrapper.get('[data-action="cancel"]').trigger('click');
        expect(document.activeElement).toBe(wrapper.get('[data-action="edit"]').element);
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 7, query: { ...original, pageSize: 25 } }]]);
    });

    it('preserves a dirty edit across a same-revision equivalent refresh without false conflict', async () => {
        const original = query();
        const wrapper = builder({ query: original, submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="条件 2 值 1"]').setValue('本地编辑');
        await wrapper.setProps({ revision: 7, snapshot: snapshot(7, cloneSavedViewDraft(original)) });
        expect((wrapper.get('input[aria-label="条件 2 值 1"]').element as HTMLInputElement).value).toBe('本地编辑');
        await wrapper.get('form').trigger('submit');
        const expected = cloneSavedViewDraft(original);
        expected.conditions[1]!.values = ['本地编辑'];
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 7, query: expected }]]);
    });

    it('does not mistake a clone of an unpaired Q8 for the revision-bound Q7', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        const latest = query();
        latest.conditions[1]!.values = ['真正变化的 Q8'];
        await wrapper.setProps({ snapshot: snapshot(8, latest) });
        await wrapper.setProps({ revision: 7, snapshot: snapshot(8, cloneSavedViewDraft(latest)) });
        await wrapper.get('[data-action="cancel"]').trigger('click');
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.setProps({ revision: 8 });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-action="cancel"]').trigger('click');
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toEqual([[{ viewId, expectedRevision: 8, query: { ...latest, pageSize: 25 } }]]);
    });

    it.each([
        ['page size', (value: SavedViewQueryDraft) => { value.pageSize = 75; }],
        ['search operand', (value: SavedViewQueryDraft) => { value.conditions[1]!.values = ['另一检索']; }],
        ['date range', (value: SavedViewQueryDraft) => { value.conditions[2]!.values = ['2026-10-02', '2026-10-09']; }],
        ['condition timezone', (value: SavedViewQueryDraft) => { value.conditions[2]!.timeZoneId = 'UTC'; }],
        ['sort direction', (value: SavedViewQueryDraft) => { value.sort.direction = 0; }],
        ['sort null placement', (value: SavedViewQueryDraft) => { value.sort.nullPlacement = 0; }],
        ['sort timezone', (value: SavedViewQueryDraft) => { value.sort.timeZoneId = 'UTC'; }],
        ['projection', (value: SavedViewQueryDraft) => { value.projection.push({ kind: 7, identity: 'article.created-at' }); }]
    ] as const)('requires a paired revision for a real %s change', async (_label, change) => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        const latest = query();
        change(latest);
        await wrapper.setProps({ revision: 7, snapshot: snapshot(8, latest) });
        expect(wrapper.text()).toContain('正在等待对应版本');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
    });

    it('retains dirty operands across revision conflict and refuses a stale CAS submission', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.setProps({ revision: 8 });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        expect(wrapper.text()).toContain('当前修改已保留');
        expect((wrapper.get('input[aria-label="每页数量"]').element as HTMLInputElement).value).toBe('25');
    });

    it('also refuses dirty drafts when the active view identity changes', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.setProps({ viewId: '22222222-2222-4222-8222-222222222222' });
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
    });

    it('supports keyboard reorder, explicit deletion and bounded add with retained focus', async () => {
        const wrapper = builder({ definitions: { ...definitions, maxConditions: 3 }, submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect(wrapper.get('[data-action="add"]').attributes('disabled')).toBeDefined();
        await wrapper.get('[data-remove="0"]').trigger('keydown', { key: 'ArrowDown', altKey: true });
        expect(document.activeElement).toBe(wrapper.get('[data-remove="1"]').element);
        await wrapper.get('form').trigger('submit');
        const submission = wrapper.emitted('submit')![0]![0] as { query: SavedViewQueryDraft };
        expect(submission.query.conditions.map(condition => condition.field.identity)).toEqual([
            'author-search.current', 'article.lifecycle.status', 'article.created-at'
        ]);
        await wrapper.get('[data-remove="1"]').trigger('click');
        expect(wrapper.findAll('[data-remove]')).toHaveLength(2);
        expect(document.activeElement).toBe(wrapper.get('[data-remove="1"]').element);
        await wrapper.get('[data-action="add"]').trigger('click');
        expect(wrapper.findAll('[data-remove]')).toHaveLength(3);
        expect(wrapper.get('[data-action="add"]').attributes('disabled')).toBeDefined();
    });

    it('keeps unknown operands visible, refuses submit, and repairs only by explicit removal', async () => {
        const original = query();
        original.conditions.push({ field: { kind: 4, identity: 'property:deleted' }, operatorId: 'property.equals', values: ['保留此值'] });
        const wrapper = builder({ query: original, submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        expect(wrapper.text()).toContain('保留此值');
        await wrapper.get('input[aria-label="每页数量"]').setValue('25');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toBeUndefined();
        await wrapper.get('[data-remove="3"]').trigger('click');
        await wrapper.get('form').trigger('submit');
        expect(wrapper.emitted('submit')).toHaveLength(1);
        expect(original.conditions).toHaveLength(4);
    });

    it('disables editing during an actual parent-reported pending command', async () => {
        const wrapper = builder({ submitAvailable: true });
        await wrapper.get('[data-action="edit"]').trigger('click');
        await wrapper.setProps({ commandState: 'pending' });
        expect(wrapper.get('[data-action="cancel"]').attributes('disabled')).toBeDefined();
        await wrapper.get('form').trigger('keydown', { key: 'Escape' });
        expect(wrapper.find('form').exists()).toBe(true);
        expect(wrapper.emitted('cancel')).toBeUndefined();
    });
});

describe('one saved-view state adapter across surfaces', () => {
    const view = { viewId, revision: 7, schemaVersion: 1, name: '真实服务端视图', isDefault: true };

    it.each(['rail', 'list', 'search'] as const)('%s refuses result slots while the query is unavailable', surface => {
        const wrapper = mount(SavedViewSurface, { props: { surface, view }, slots: { results: '不得展示的结果' } });
        mounted.push(wrapper);
        expect(wrapper.text()).toContain('查询接口当前不可用。未执行筛选。');
        expect(wrapper.text()).not.toContain('不得展示的结果');
    });

    it.each(['invalid', 'stale', 'permission-denied', 'loading', 'unsynced'] as const)('%s never displays a stale result slot', status => {
        const wrapper = mount(SavedViewSurface, { props: { surface: 'list', status, view }, slots: { results: '私密结果' } });
        mounted.push(wrapper);
        expect(wrapper.text()).not.toContain('私密结果');
    });

    it('shows exact dependency IDs/reasons and emits repair identity without changing the AST', async () => {
        const reasons = [{ fieldIdentity: 'property:deleted', operatorId: 'property.equals', reason: 'deleted' }];
        const wrapper = mount(SavedViewSurface, { props: { surface: 'search', status: 'invalid', view, reasons } });
        mounted.push(wrapper);
        expect(wrapper.text()).toContain('property:deleted · property.equals：deleted');
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('repair')).toEqual([[viewId]]);
        expect(reasons).toHaveLength(1);
    });

    it.each(['rail', 'list', 'search'] as const)('%s masks invalid permission-revoked identity and actions', surface => {
        const wrapper = mount(SavedViewSurface, {
            props: {
                surface,
                status: 'invalid',
                view,
                pinnedViews: [view],
                reasons: [{ fieldIdentity: 'private-property:original', operatorId: 'property.equals', reason: 'permission-revoked' }]
            },
            slots: { results: '旧私密结果' }
        });
        mounted.push(wrapper);
        expect(wrapper.text()).not.toContain(view.name);
        expect(wrapper.text()).not.toContain('private-property:original');
        expect(wrapper.text()).not.toContain('旧私密结果');
        expect(wrapper.find('button').exists()).toBe(false);
        expect(wrapper.text()).toContain('不能访问此视图');
    });

    it.each(['unavailable', 'loading', 'stale', 'permission-denied', 'ready', 'empty', 'unsynced'] as const)(
        '%s permission-revoked facts override retained Rail data', status => {
            const wrapper = mount(SavedViewSurface, {
                props: { surface: 'rail', status, view, pinnedViews: [view], reasons: [{ fieldIdentity: 'private-property:original', operatorId: 'property.equals', reason: 'permission-revoked' }] },
                slots: { results: '旧私密结果' }
            });
            mounted.push(wrapper);
            expect(wrapper.text()).not.toContain(view.name);
            expect(wrapper.text()).not.toContain('旧私密结果');
            expect(wrapper.find('button').exists()).toBe(false);
        }
    );

    it('retains authorized identity and repair actions for an ordinary retired dependency', async () => {
        const wrapper = mount(SavedViewSurface, {
            props: { surface: 'rail', status: 'invalid', view, pinnedViews: [view], reasons: [{ fieldIdentity: 'property:retired', operatorId: 'property.equals', reason: 'retired' }] }
        });
        mounted.push(wrapper);
        expect(wrapper.text()).toContain(view.name);
        expect(wrapper.text()).toContain('property:retired');
        await wrapper.get('li button').trigger('click');
        expect(wrapper.emitted('open')).toEqual([[{ viewId, expectedRevision: 7, schemaVersion: 1 }]]);
    });

    it('bounds a 1000-view Rail to 20 server-ordered pins and requests the next server page', async () => {
        const pins = Array.from({ length: 1000 }, (_, index) => ({ ...view, viewId: String(index), name: `视图 ${index}` }));
        const wrapper = mount(SavedViewSurface, { props: { surface: 'rail', view, pinnedViews: pins } });
        mounted.push(wrapper);
        expect(wrapper.findAll('li')).toHaveLength(20);
        await wrapper.findAll('li button')[0]!.trigger('click');
        expect(wrapper.emitted('open')).toEqual([[{ viewId: '0', expectedRevision: 7, schemaVersion: 1 }]]);
        await wrapper.get('[data-action="next-pins"]').trigger('click');
        expect(wrapper.emitted('nextPins')).toEqual([[]]);
        expect(pins).toHaveLength(1000);
    });

    it('suppresses ready content until the deep link is resolved', () => {
        const wrapper = mount(SavedViewSurface, { props: { surface: 'list', status: 'ready', view, deepLinkStatus: 'resolving' }, slots: { results: '服务端文章' } });
        mounted.push(wrapper);
        expect(wrapper.text()).not.toContain('服务端文章');
        expect(wrapper.text()).not.toContain(view.name);
    });

    it.each(['stale', 'permission-denied'] as const)('%s also masks prior view names and Rail pins', status => {
        const wrapper = mount(SavedViewSurface, { props: { surface: 'rail', status, view, pinnedViews: [view] } });
        mounted.push(wrapper);
        expect(wrapper.text()).not.toContain(view.name);
        expect(wrapper.findAll('li')).toHaveLength(0);
        expect(wrapper.find('button').exists()).toBe(false);
    });
});

describe('identity-only deep links', () => {
    it('roundtrips only stable identity/schema and requires server resolution', () => {
        const link = buildSavedViewDeepLink('/manage/articles', viewId, 1);
        const parameters = new URL(link, 'https://fsusblog.test').searchParams;
        expect([...parameters.keys()]).toEqual(['view', 'viewSchema']);
        expect(readSavedViewDeepLink(parameters)).toEqual({ status: 'resolve', viewId, schemaVersion: 1 });
        expect(link).not.toContain('原始');
    });

    it.each([
        `view=${viewId}&view=${viewId}&viewSchema=1`,
        `view=${viewId}&viewSchema=1&query=private`,
        'view=00000000-0000-0000-0000-000000000000&viewSchema=1',
        `view=${viewId}&viewSchema=NaN`
    ])('refuses malformed or multi-authority links: %s', parameters => {
        expect(readSavedViewDeepLink(new URLSearchParams(parameters)).status).toBe('invalid');
    });

    it('refuses external destinations and never resolves a missing identity', () => {
        expect(() => buildSavedViewDeepLink('//evil.test/path', viewId, 1)).toThrow('saved_view_deep_link_invalid');
        expect(() => buildSavedViewDeepLink('/\\evil.test/path', viewId, 1)).toThrow('saved_view_deep_link_invalid');
        expect(readSavedViewDeepLink(new URLSearchParams())).toEqual({ status: 'none' });
    });
});
