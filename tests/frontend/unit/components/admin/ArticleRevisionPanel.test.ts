// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus';

import type { ArticleRevisionDetailResponse, ArticleRevisionSummaryResponse } from '@/api/authoring';
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue';

const revisions: ArticleRevisionSummaryResponse[] = [
    {
        id: 'revision-3', articleId: 42, revisionNo: 3, title: '第三版正文',
        diffSummary: '更新正文与责任快照', createdByAdminPrincipalId: '19',
        createdAt: '2026-10-17T00:00:00Z', rollbackSourceRevisionId: null, rollbackReason: null
    },
    {
        id: 'revision-2', articleId: 42, revisionNo: 2, title: '第二版正文',
        diffSummary: '修订标题', createdByAdminPrincipalId: '7',
        createdAt: '2026-10-16T00:00:00Z', rollbackSourceRevisionId: null, rollbackReason: null
    }
];

function detail(revision = revisions[0]): ArticleRevisionDetailResponse
{
    return {
        ...revision, content: '历史正文', summary: null, coverImageUrl: null,
        categoryId: 1, tagIds: [], packageComplete: true, rights: null,
        responsibility: null, release: null
    };
}

const wrappers: ReturnType<typeof mount>[] = [];

function renderPanel(overrides = {})
{
    const wrapper = mount(ArticleRevisionPanel, {
        props: {
            isEdit: true, revisions, selectedRevision: null, selectedLabel: '当前所选版本',
            loading: false, rollbacking: false, statusText: '已加载 2 个版本',
            compareText: '历史版本与当前正文比较', ...overrides
        },
        global: { components: { ElButton, ElInput, ElOption, ElSelect } }
    });
    wrappers.push(wrapper);
    return wrapper;
}

afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('ArticleRevisionPanel public controls', () =>
{
    it('keeps revision order, native button semantics and the original selected object', async () =>
    {
        const wrapper = renderPanel({ selectedRevision: detail(revisions[1]) });
        const rows = wrapper.findAll<HTMLButtonElement>('button.revision-row');

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.attributes('type'))).toEqual(['button', 'button']);
        expect(rows.map((row) => row.get('.revision-row__title').text())).toEqual([
            '版本 3 · 第三版正文', '版本 2 · 第二版正文'
        ]);
        expect(rows.map((row) => row.attributes('aria-current'))).toEqual([undefined, 'true']);
        expect(wrapper.findAllComponents(ElButton).filter((button) => button.classes().includes('revision-row'))).toHaveLength(2);

        rows[0].element.click();
        expect(wrapper.emitted('select-revision')).toHaveLength(1);
        expect(wrapper.emitted('select-revision')?.[0]?.[0]).toBe(wrapper.props('revisions')[0]);

        await wrapper.setProps({ selectedRevision: detail(revisions[0]) });
        expect(rows.map((row) => row.attributes('aria-current'))).toEqual(['true', undefined]);
    });

    it.each(['loading', 'rollbacking'])('prevents selection while %s and restores the same row controls', async (busyState) =>
    {
        const wrapper = renderPanel();
        const rows = wrapper.findAll<HTMLButtonElement>('button.revision-row');
        const firstElement = rows[0].element;

        await wrapper.setProps({ [busyState]: true });
        expect(rows.every((row) => row.element.disabled)).toBe(true);
        rows.forEach((row) => row.element.click());
        expect(wrapper.emitted('select-revision')).toBeUndefined();

        await wrapper.setProps({ [busyState]: false });
        expect(rows.every((row) => !row.element.disabled)).toBe(true);
        expect(wrapper.get('button.revision-row').element).toBe(firstElement);
        rows[1].element.click();
        expect(wrapper.emitted('select-revision')?.[0]?.[0]).toBe(wrapper.props('revisions')[1]);
    });

    it('retains refresh, reason validation, trimmed rollback payload and selection reset', async () =>
    {
        const wrapper = renderPanel({ selectedRevision: detail() });
        await wrapper.get('[aria-label="刷新修订历史"]').trigger('click');
        expect(wrapper.emitted('refresh')).toEqual([[]]);

        const rollback = wrapper.get<HTMLButtonElement>('[aria-label="从此版本创建新版本"]');
        const reason = wrapper.get('textarea');
        expect(rollback.element.disabled).toBe(true);
        await reason.setValue('  太短  ');
        expect(rollback.element.disabled).toBe(true);
        await reason.setValue('  恢复此前经过确认的完整历史版本  ');
        expect(rollback.element.disabled).toBe(false);
        rollback.element.click();
        expect(wrapper.emitted('rollback')).toEqual([[{ targetStatus: 2, reason: '恢复此前经过确认的完整历史版本' }]]);

        await wrapper.setProps({ selectedRevision: detail(revisions[1]) });
        expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('');
        expect(rollback.element.disabled).toBe(true);
    });

    it('preserves the empty state and hides the panel outside edit mode', async () =>
    {
        const wrapper = renderPanel({ revisions: [] });
        expect(wrapper.text()).toContain('暂无修订记录');
        expect(wrapper.find('button.revision-row').exists()).toBe(false);

        await wrapper.setProps({ isEdit: false });
        expect(wrapper.find('section').exists()).toBe(false);
    });
});
