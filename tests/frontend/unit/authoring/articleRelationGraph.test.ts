// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ArticleRelationGraph from '@/components/admin/article/ArticleRelationGraph.vue';
import * as graphLayout from '@/services/authoring/articleGraphLayout';
import type { ArticleGraphRequest } from '@/services/authoring/articleGraphQuery';
import { graphIdentity, graphResult } from './articleGraphFixtures';

const settle = async (wrapper: ReturnType<typeof mount>): Promise<void> => {
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
};

const findButton = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(button => button.text().includes(text))!;

describe('bounded graph/list composition', () => {
    it('shows unavailable honestly, without canvas, placeholders or navigation fabrication', async () => {
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session' } });
        await settle(wrapper);
        expect(wrapper.text()).toContain('关系查询尚未接入');
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(0);
        expect(wrapper.findAll('canvas')).toHaveLength(0);
        wrapper.unmount();
    });

    it('shares canonical nodes/edges/actions between diagram and accessible list', async () => {
        const openOrActivate = vi.fn();
        const revealSource = vi.fn();
        const query = vi.fn(async (request: ArticleGraphRequest) => graphResult(request, 5));
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query }, navigationHost: { openOrActivate, revealSource } } });
        await settle(wrapper);
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(5);
        expect(wrapper.findAll('[data-list-edge]')).toHaveLength(4);
        expect(wrapper.findAll('svg')).toHaveLength(0);
        await wrapper.findAll('input[type="checkbox"]').at(-1)!.setValue(true);
        expect(wrapper.findAll('[data-graph-node]').map(element => element.attributes('data-graph-node'))).toEqual(wrapper.findAll('[data-list-node]').map(element => element.attributes('data-list-node')));
        expect(wrapper.findAll('[data-graph-edge]').map(element => element.attributes('data-graph-edge'))).toEqual(wrapper.findAll('[data-list-edge]').map(element => element.attributes('data-list-edge')));
        expect(wrapper.text()).toContain('⇒ 嵌入');
        await wrapper.find('[data-list-node="article-00001"] button').trigger('click');
        expect(openOrActivate.mock.calls[0]![0].articleIdentity).toBe('article-00001');
        await wrapper.find('[data-list-edge="relation-00000"] button').trigger('click');
        expect(revealSource.mock.calls[0]![0].source).toMatchObject({ start: 0, end: 3, revisionIdentity: 'revision' });
        wrapper.unmount();
    });

    it('pages all 1000 nodes with bounded DOM and no background depth two', async () => {
        const query = vi.fn(async (request: ArticleGraphRequest) => graphResult(request, 1000));
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query } } });
        await settle(wrapper);
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(40);
        expect(wrapper.findAll('[data-list-edge]')).toHaveLength(40);
        expect(wrapper.findAll('*').length).toBeLessThan(1000);
        const articleIds = new Set(wrapper.findAll('[data-list-node]').map(element => element.attributes('data-list-node')));
        for (let page = 1; page < 25; page++) {
            await findButton(wrapper, '下一页文章').trigger('click');
            for (const element of wrapper.findAll('[data-list-node]')) {
                articleIds.add(element.attributes('data-list-node'));
            }
        }
        expect(articleIds.size).toBe(1000);
        expect(findButton(wrapper, '下一页文章').attributes('disabled')).toBeDefined();
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls.every(([request]) => request.requestedDepth === 1)).toBe(true);
        wrapper.unmount();
    });

    it('keeps the bounded accessible list and source actions when a layout task is unavailable', async () => {
        vi.stubGlobal('MessageChannel', class { public constructor() { throw new Error('task-unavailable'); } });
        try {
            const openOrActivate = vi.fn();
            const revealSource = vi.fn();
            const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query: async request => graphResult(request, 1000) }, navigationHost: { openOrActivate, revealSource } } });
            await settle(wrapper);
            expect(wrapper.text()).toContain('仅列表（布局 task-unavailable）');
            expect(wrapper.findAll('[data-list-node]')).toHaveLength(40);
            expect(wrapper.findAll('[data-list-edge]')).toHaveLength(40);
            expect(wrapper.findAll('svg')).toHaveLength(0);
            await wrapper.find('[data-list-node="article-00001"] button').trigger('click');
            await wrapper.find('[data-list-edge="relation-00000"] button').trigger('click');
            expect(openOrActivate.mock.calls[0]![0].articleIdentity).toBe('article-00001');
            expect(revealSource.mock.calls[0]![0].relationIdentity).toBe('relation-00000');
            wrapper.unmount();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('offers the authorized list while layout is pending and erases it on unmount', async () => {
        const realTask = graphLayout.runArticleGraphLayoutTask;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const task = vi.spyOn(graphLayout, 'runArticleGraphLayoutTask').mockImplementation(async (result, signal) => {
            await gate;
            return realTask(result, signal);
        });
        const openOrActivate = vi.fn();
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query: async request => graphResult(request, 1000) }, navigationHost: { openOrActivate, revealSource: vi.fn() } } });
        try {
            await vi.waitFor(() => expect(wrapper.text()).toContain('正在布局（列表可用）'));
            expect(wrapper.attributes('aria-busy')).toBe('true');
            expect(wrapper.findAll('[data-list-node]')).toHaveLength(40);
            expect(wrapper.findAll('[data-list-edge]')).toHaveLength(40);
            await wrapper.find('[data-list-node="article-00001"] button').trigger('click');
            expect(openOrActivate.mock.calls[0]![0].articleIdentity).toBe('article-00001');
            wrapper.unmount();
            release();
            await flushPromises();
            expect(task.mock.calls[0]![1].aborted).toBe(true);
        } finally {
            release();
            wrapper.unmount();
            task.mockRestore();
        }
    });

    it('refuses a 10000-node input wholesale rather than silently rendering a complete subset', async () => {
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query: async request => graphResult(request, 10000) } } });
        await settle(wrapper);
        expect(wrapper.text()).toContain('请求被拒绝');
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(0);
        expect(wrapper.findAll('svg')).toHaveLength(0);
        wrapper.unmount();
    });

    it('resets explicit depth two on epoch switch and clears closed facts', async () => {
        const query = vi.fn(async (request: ArticleGraphRequest) => graphResult(request));
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query } } });
        await settle(wrapper);
        await findButton(wrapper, '展开到两层').trigger('click');
        await settle(wrapper);
        expect(query.mock.lastCall?.[0].requestedDepth).toBe(2);
        await wrapper.setProps({ identity: { ...graphIdentity, documentEpoch: 'epoch-new' } });
        await settle(wrapper);
        expect(query.mock.lastCall?.[0].requestedDepth).toBe(1);
        await findButton(wrapper, '关闭').trigger('click');
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(0);
        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });

    it('stops hidden work, resets to one on return, and removes its listener', async () => {
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const remove = vi.spyOn(document, 'removeEventListener');
        const query = vi.fn(async (request: ArticleGraphRequest) => graphResult(request));
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'session', queryHost: { query } } });
        await settle(wrapper);
        await findButton(wrapper, '展开到两层').trigger('click');
        await settle(wrapper);
        hidden.mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(wrapper);
        expect(wrapper.findAll('[data-list-node]')).toHaveLength(0);
        hidden.mockReturnValue(false);
        document.dispatchEvent(new Event('visibilitychange'));
        await settle(wrapper);
        expect(query.mock.lastCall?.[0].requestedDepth).toBe(1);
        wrapper.unmount();
        expect(remove.mock.calls.some(([name]) => name === 'visibilitychange')).toBe(true);
        hidden.mockRestore();
        remove.mockRestore();
    });
});
