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
    SavedViewQueryDraft
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

const mounted: ReturnType<typeof mount>[] = [];
function builder(overrides: Record<string, unknown> = {}) {
    const wrapper = mount(SavedViewQueryBuilder, {
        attachTo: document.body,
        props: { viewId, revision: 7, query: query(), definitions, ...overrides }
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
