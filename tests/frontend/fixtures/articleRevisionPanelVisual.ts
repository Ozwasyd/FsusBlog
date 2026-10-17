import { createApp, h, reactive } from 'vue';
import { ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus';

import '@/assets/main.css';
import type { ArticleRevisionDetailResponse, ArticleRevisionSummaryResponse } from '@/api/authoring';
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue';

const revisions: ArticleRevisionSummaryResponse[] = [
    {
        id: 'revision-3', articleId: 42, revisionNo: 3,
        title: '第三版：完整历史正文与责任快照'.repeat(8),
        diffSummary: '更新正文、版权和责任快照'.repeat(5),
        createdByAdminPrincipalId: '9223372036854775807', createdAt: '2026-10-17T00:00:00Z',
        rollbackSourceRevisionId: null, rollbackReason: null
    },
    {
        id: 'revision-2', articleId: 42, revisionNo: 2, title: '第二版正文',
        diffSummary: '修订标题', createdByAdminPrincipalId: '7', createdAt: '2026-10-16T00:00:00Z',
        rollbackSourceRevisionId: null, rollbackReason: null
    }
];

function detail(revision: ArticleRevisionSummaryResponse): ArticleRevisionDetailResponse
{
    return {
        ...revision, content: '历史正文', summary: null, coverImageUrl: null, categoryId: 1,
        tagIds: [], packageComplete: true, rights: null, responsibility: null, release: null
    };
}

const state = reactive({
    isEdit: true, revisions, selectedRevision: detail(revisions[1]), selectedLabel: '当前所选版本',
    loading: false, rollbacking: false, statusText: '已加载 2 个版本', compareText: '历史版本与当前正文比较'
});
const events: Array<{ event: string; id?: string; targetStatus?: number; reason?: string }> = [];

declare global
{
    interface Window
    {
        revisionPanelFixture: {
            state: typeof state;
            events: typeof events;
        };
    }
}

export function mountArticleRevisionPanelFixture(): void
{
    const app = createApp({
        render: () => h(ArticleRevisionPanel, {
            ...state,
            onSelectRevision: (revision: ArticleRevisionSummaryResponse) =>
            {
                events.push({ event: 'select', id: revision.id });
                state.selectedRevision = detail(revision);
            },
            onRefresh: () => events.push({ event: 'refresh' }),
            onRollback: (selection: { targetStatus: 0 | 2 | 3; reason: string }) =>
                events.push({ event: 'rollback', ...selection })
        })
    });
    for (const component of [ElButton, ElInput, ElOption, ElSelect])
    {
        app.component(component.name!, component);
    }
    window.revisionPanelFixture = { state, events };
    app.mount('#revision-panel-fixture');
}
