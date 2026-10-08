// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ArticleLiveRecoveryActions from '@/components/admin/article/ArticleLiveRecoveryActions.vue';
import { createArticleEditorSurfacePreference } from '@/services/authoring/articleEditorSurface';

import type { ArticleEditorSurfaceRuntimeState } from '@/services/authoring/articleEditorSurfaceRuntime';

const messages = {
    'capability-pending': '正在确认实时编辑能力，正文可继续编辑。',
    'invalid-capability': '实时编辑状态不可用，正文可继续在源码中编辑。',
    'supported': '', 'unsupported-platform': '当前平台使用源码编辑。',
    'runtime-unavailable': '实时编辑暂时不可用，正文可继续在源码中编辑。',
    'projection-failed': '实时显示失败，正文可继续在源码中编辑。',
    'feature-degraded': '部分内容使用源码编辑，其余内容可继续实时编辑。',
    'fatal': '实时编辑已暂停，正文可继续在源码中编辑。',
    escaped: '已临时进入源码，实时编辑偏好保持不变。', escape: '临时进入源码', recover: '重试实时编辑'
};
const state = (patch: Partial<ArticleEditorSurfaceRuntimeState> = {}): ArticleEditorSurfaceRuntimeState => ({
    capability: 'runtime-unavailable', effectiveSurface: 'source', preference: createArticleEditorSurfacePreference({ siteScope: 'site:test', userScope: 'user:test' }),
    reason: 'runtime-unavailable', localEscape: null, recovery: 'request-current-capability', desiredSurface: 'source', escaped: false,
    pending: null, documentCurrent: true, ...patch
});
describe('Live recovery actions with actual public FsusUI buttons', () => {
    it('shows source continuation without an error card or another editor and emits the explicit recovery action', async () => {
        const wrapper = mount(ArticleLiveRecoveryActions, { props: { state: state(), messages, busy: false } });
        expect(wrapper.get('[role="status"]').text()).toBe(messages['runtime-unavailable']);
        expect(wrapper.findAll('button')).toHaveLength(1);
        expect(wrapper.find('textarea').exists()).toBe(false);
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('recover')).toEqual([[]]);
        wrapper.unmount();
    });
    it('emits local source escape and retains a separate recovery action after session escape', async () => {
        const wrapper = mount(ArticleLiveRecoveryActions, { props: { state: state({ capability: 'feature-degraded', reason: 'feature-degraded',
            effectiveSurface: 'live', desiredSurface: 'live', recovery: 'source-escape' }), messages, busy: false } });
        expect(wrapper.get('button').text()).toBe(messages.escape);
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('escape')).toEqual([[]]);
        await wrapper.setProps({ state: state({ escaped: true }) });
        expect(wrapper.get('[role="status"]').text()).toBe(messages.escaped);
        expect(wrapper.get('button').text()).toBe(messages.recover);
        wrapper.unmount();
    });
    it('keeps pending status noninteractive and disables recovery while its actual owner is busy', async () => {
        const wrapper = mount(ArticleLiveRecoveryActions, { props: { state: state({ capability: null, reason: 'capability-pending' }), messages, busy: false } });
        expect(wrapper.find('button').exists()).toBe(false);
        await wrapper.setProps({ state: state(), busy: true });
        expect(wrapper.attributes('aria-busy')).toBe('true');
        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('recover')).toBeUndefined();
        wrapper.unmount();
    });
    it('stays silent for supported Live, a user-selected Source preference and stale documents', () => {
        for (const value of [state({ capability: 'supported', reason: null, effectiveSurface: 'live', desiredSurface: 'live' }),
            state({ preference: createArticleEditorSurfacePreference({ siteScope: 'site:test', userScope: 'user:test' }, 'source') }),
            state({ documentCurrent: false })])
        {
            const wrapper = mount(ArticleLiveRecoveryActions, { props: { state: value, messages, busy: false } });
            expect(wrapper.find('[role="status"]').exists()).toBe(false);
            expect(wrapper.find('button').exists()).toBe(false);
            wrapper.unmount();
        }
    });
});
