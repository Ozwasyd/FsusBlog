// @vitest-environment happy-dom

import {
    ElButton,
    ElCheckbox,
    ElDropdown,
    ElDropdownItem,
    ElDropdownMenu,
    ElIcon,
    ElLoading,
    ElResponsiveCollection,
    ElTable,
    ElTableColumn,
    ElTag
} from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { h, markRaw, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentModerationStatus } from '@/api/authoring';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import CollectionWorkbench from '@/components/admin/CollectionWorkbench.vue';
import CommentModerationQueue from '@/components/admin/comment-moderation/CommentModerationQueue.vue';
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue';

const createItem = (id: string): CommentModerationViewItem => ({
    id,
    articleId: 42,
    articleTitle: '文章 42',
    content: `待审核评论 ${id}`,
    createTime: '2026-10-09T00:00:00Z',
    status: CommentModerationStatus.Pending,
    reason: null,
    moderatedByAdminPrincipalId: null,
    moderatedAt: null,
    autoModerated: false,
    moderationActor: 'manual',
    hitReasons: [],
    submitRegion: null,
    submitRegionConfidence: null,
    blockedRegions: [],
    regionPolicyVersion: null,
    regionDecisionReason: null,
    regionCanPublish: false,
    regionRequiresManualReview: true,
    regionHideUntilReviewed: true,
    modelSignals: [],
    modelLabel: null,
    modelConfidence: null,
    modelPrimaryReason: null,
    modelProvider: null,
    modelUnavailable: false,
    actorDisplayName: `匿名作者 ${id}`,
    authorModeLabel: '匿名评论',
    displayLanguageLabel: '展示语言：zh-CN',
    anonymousScopeLabel: 'scope：article:42',
    rateClassLabel: '速率类：普通',
    moderationRequirementLabel: '需要审核',
    nullifierStatusLabel: 'Nullifier：未记录',
    riskLabels: [],
    isAnonymousActor: true,
    isZkAnonymous: true,
    hasAnonymousNullifier: true,
    hasAnonymousCredential: true,
    canBlockAnonymousNullifier: true,
    canRevokeAnonymousCredential: true,
    statusLabel: '待审核',
    statusCode: 'pending',
    statusClass: 'text-warning',
    moderationActorLabel: '人工审核',
    recommendedStatus: CommentModerationStatus.Approved,
    recommendedActionLabel: '建议通过',
    recommendedActionReason: '等待人工判断',
    createTimeText: '2026-10-09',
    articleLabel: '文章 42',
    userLabel: '匿名主体',
    hitReasonLabels: [],
    regionSummary: '提交地区：未记录',
    blockedRegionLabel: '无',
    regionPolicyLabel: '未记录',
    regionReviewLabel: '待复核',
    regionConfidenceLabel: '置信度：未记录',
    regionCanApprove: true,
    modelSignalLabel: '未记录',
    modelConfidenceLabel: '模型置信度：未记录',
    modelProviderLabel: '模型运行时：未记录',
    modelReasonLabel: '未记录',
    modelSeverityLabel: '未记录',
    modelCategoriesLabel: '未记录',
    modelProfileLabel: '未记录',
    modelStatusLabel: '未记录',
    modelLatencyLabel: '未记录',
    auditEvents: []
});

const globalOptions = {
    components: {
        ElButton,
        ElCheckbox,
        ElDropdown,
        ElDropdownItem,
        ElDropdownMenu,
        ElIcon,
        ElResponsiveCollection,
        ElTable,
        ElTableColumn,
        ElTag
    },
    directives: { loading: ElLoading.directive }
};

const wrappers: { unmount: () => void; }[] = [];

afterEach(() => {
    for (const wrapper of wrappers.splice(0))
    {
        wrapper.unmount();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

const mountQueue = async (compact: boolean, items: readonly CommentModerationViewItem[]) => {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((media: string) => {
        const query = matchMedia(media);
        Object.defineProperty(query, 'matches', { value: compact && media === '(max-width: 767px)' });
        return query;
    });
    // Keep happy-dom's real observer unproxied, as the native browser object is.
    const BrowserObserver = MutationObserver;
    vi.stubGlobal('MutationObserver', class extends BrowserObserver {
        constructor(callback: MutationCallback)
        {
            super(callback);
            markRaw(this);
        }
    });
    const wrapper = mount(CommentModerationQueue, {
        attachTo: document.body,
        props: {
            items,
            selectedIds: Object.freeze(['retained']),
            highlightedIds: Object.freeze(['retained']),
            loading: false,
            processingId: null
        },
        global: globalOptions
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
};

describe.each([true, false])('readonly moderation projection (compact=%s)', (compact) => {
    it('shares a detached public array while retaining models, order and keyed controls after replacement', async () => {
        const retained = Object.freeze(createItem('retained'));
        const other = Object.freeze(createItem('other'));
        const items: readonly CommentModerationViewItem[] = Object.freeze([other, retained]);
        const wrapper = await mountQueue(compact, items);
        const collection = wrapper.getComponent(ElResponsiveCollection);
        const rendered = compact ? wrapper.get('[role="list"]') : wrapper.getComponent(ElTable);
        const projected: InstanceType<typeof ElResponsiveCollection>['$props']['items'] = collection.props('items');
        expect(projected).not.toBe(items);
        expect(projected?.[0]).toBe(other);
        expect(projected?.[1]).toBe(retained);
        expect(collection.props('rowKey')).toBe('id');
        if (!compact)
        {
            const tableData: InstanceType<typeof ElTable>['$props']['data'] = wrapper.getComponent(ElTable).props('data');
            expect(tableData).toBe(projected);
            expect(wrapper.getComponent(ElTable).props('rowKey')).toBe('id');
        }
        const retainedInput = rendered.get('[aria-label="选择评论 retained"] input').element;
        const retainedRow = retainedInput.closest('.blog-motion-row-state');
        expect((retainedInput as HTMLInputElement).checked).toBe(true);
        expect(rendered.findAll('.blog-motion-row-updated')).toHaveLength(1);
        await rendered.get('[aria-label="选择评论 other"] input').setValue(true);
        expect(wrapper.emitted('toggle')).toEqual([['other', true]]);
        await wrapper.setProps({ processingId: 'other' });
        expect(collection.props('items')).toBe(projected);

        const replacement = Object.freeze({ ...retained, content: '替换后的评论正文' });
        const replacementItems: readonly CommentModerationViewItem[] = Object.freeze([replacement, other]);
        await wrapper.setProps({ items: replacementItems });
        await flushPromises();
        const updated = collection.props('items');
        expect(updated).not.toBe(projected);
        expect(updated).not.toBe(replacementItems);
        expect(updated?.[0]).toBe(replacement);
        expect(updated?.[1]).toBe(other);
        const updatedInput = rendered.get('[aria-label="选择评论 retained"] input').element;
        expect(updatedInput.closest('.blog-motion-row-state')).toBe(retainedRow);
        expect((updatedInput as HTMLInputElement).checked).toBe(true);
        expect(rendered.findAll('.blog-motion-row-updated')).toHaveLength(1);
        expect(rendered.findAll('.blog-motion-row-pending')).toHaveLength(1);
        expect(rendered.findAll('[aria-label^="选择评论"]').map(control => control.attributes('aria-label')))
            .toEqual(['选择评论 retained', '选择评论 other']);
        expect(wrapper.text()).toContain('替换后的评论正文');
        await rendered.findAll('button').find(button => button.text() === '详情')?.trigger('click');
        expect(wrapper.emitted('detail')?.[0]?.[0]).toBe(replacement);
        expect(items).toEqual([other, retained]);
        expect(retained.content).toBe('待审核评论 retained');
        expect(replacementItems).toEqual([replacement, other]);
    });

    it('preserves ordinary action payloads, disabled controls and loading/empty transitions', async () => {
        const row = Object.freeze(createItem('retained'));
        const wrapper = await mountQueue(compact, Object.freeze([row]));
        const rendered = compact ? wrapper.get('[role="list"]') : wrapper.getComponent(ElTable);
        if (!compact)
        {
            await wrapper.getComponent(ElDropdown).get('button').trigger('click');
            await flushPromises();
        }
        const commands = compact ? wrapper.findAllComponents(ElButton) : wrapper.findAllComponents(ElDropdownItem);
        for (const [label, status] of [
            ['通过评论', CommentModerationStatus.Approved],
            ['隐藏评论', CommentModerationStatus.Hidden],
            ['拒绝评论', CommentModerationStatus.Rejected]
        ] as const)
        {
            const command = commands.find(control => control.text() === label);
            expect(command).toBeDefined();
            if (compact)
            {
                await command?.trigger('click');
            }
            else
            {
                const menuItem = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === label);
                expect(menuItem).toBeDefined();
                menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await nextTick();
            }
            expect(wrapper.emitted('apply')?.at(-1)).toEqual([row, status]);
            expect(wrapper.emitted('apply')?.at(-1)?.[0]).toBe(row);
        }
        for (const label of ['封禁匿名标识', '撤销匿名资格'])
        {
            if (compact)
            {
                await commands.find(control => control.text() === label)?.trigger('click');
            }
            else
            {
                const menuItem = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === label);
                expect(menuItem).toBeDefined();
                menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await nextTick();
            }
        }
        expect(wrapper.emitted('block-anonymous-nullifier')?.[0]?.[0]).toBe(row);
        expect(wrapper.emitted('revoke-anonymous-credential')?.[0]?.[0]).toBe(row);

        const restricted = Object.freeze({ ...row, regionCanApprove: false, canRevokeAnonymousCredential: false });
        await wrapper.setProps({ items: Object.freeze([restricted]), loading: true, processingId: row.id });
        await flushPromises();
        expect(rendered.get('input[type="checkbox"]').attributes('disabled')).toBeDefined();
        expect(wrapper.find('.el-loading-mask').exists()).toBe(true);
        const disabledCommands = compact ? wrapper.findAllComponents(ElButton) : wrapper.findAllComponents(ElDropdownItem);
        expect(disabledCommands.find(control => control.text() === '通过评论')?.props().disabled).toBe(true);
        expect(disabledCommands.find(control => control.text() === '撤销匿名资格')?.props().disabled).toBe(true);
        expect(rendered.findAll('.blog-motion-row-pending')).toHaveLength(1);

        await wrapper.setProps({
            items: Object.freeze([]),
            loading: false,
            processingId: null,
            emptyTitle: '暂无待审评论',
            emptyDescription: '调整筛选后重试。'
        });
        await flushPromises();
        expect(rendered.find('input[type="checkbox"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('暂无待审评论');
        expect(wrapper.text()).toContain('调整筛选后重试。');
        expect(row.regionCanApprove).toBe(true);
    });
});

it('retains the existing workbench loading, empty and error display with public retry controls', async () => {
    const wrapper = mount(CollectionWorkbench, {
        props: { title: '审核队列', titleId: 'queue-title', state: 'loading', busy: true },
        slots: {
            loading: () => h(AdminInlineEmptyState, { title: '正在读取审核队列', state: 'loading' }),
            empty: () => h(AdminInlineEmptyState, { title: '当前队列暂无评论' }),
            error: () => h(AdminInlineEmptyState, {
                title: '评论队列加载失败', description: '请稍后重试。', state: 'error'
            }, { actions: () => h(ElButton, {}, () => '重新加载') })
        },
        global: globalOptions
    });
    wrappers.push(wrapper);
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在读取审核队列');
    await wrapper.setProps({ state: 'empty', busy: false });
    expect(wrapper.text()).toContain('当前队列暂无评论');
    await wrapper.setProps({ state: 'error' });
    await nextTick();
    expect(wrapper.get('[role="alert"]').text()).toContain('请稍后重试。');
    expect(wrapper.get('[role="alert"]').attributes('aria-live')).toBe('assertive');
    expect(wrapper.get('button').text()).toBe('重新加载');
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
});
