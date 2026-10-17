// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ArticleRelationGraph from '@/components/admin/article/ArticleRelationGraph.vue';
import { runArticleGraphLayoutTask } from '@/services/authoring/articleGraphLayout';
import type { ArticleGraphRequest, ArticleGraphResult } from '@/services/authoring/articleGraphQuery';
import { graphIdentity, graphRequest, graphResult } from './articleGraphFixtures';

const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(candidate => candidate.text() === label)!;
const settled = async (wrapper: ReturnType<typeof mount>): Promise<void> => {
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
};

describe('ordinary graph component review regressions', () => {
    it.each([500, 501])('refuses a terminal wall receipt of 501ms when the last slice ends at %ims', async sliceEnd => {
        let channel!: { port1: { onmessage: (() => void) | null; close: ReturnType<typeof vi.fn> }; port2: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
        vi.stubGlobal('MessageChannel', class {
            public port1 = { onmessage: null as (() => void) | null, close: vi.fn() };
            public port2 = { postMessage: vi.fn(), close: vi.fn() };
            public constructor() { channel = this; }
        });
        const now = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            const task = runArticleGraphLayoutTask(graphResult(graphRequest, 1), new AbortController().signal);
            for (let index = 0; index < 4; index++) channel.port1.onmessage!();
            let calls = 0;
            now.mockImplementation(() => ++calls <= 2 ? 499 : calls === 3 ? sliceEnd : 501);
            channel.port1.onmessage!();
            expect(await task).toMatchObject({ status: 'blocked', reason: 'time-budget', layout: null, usage: { slices: 5, wallMilliseconds: 501 } });
            expect(channel.port1.close).toHaveBeenCalledTimes(1);
            expect(channel.port2.close).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it.each([false, true])('keeps depth-query focus deliberate, preserving later user focus=%s', async moveFocus => {
        let resolve!: (result: ArticleGraphResult) => void;
        let request!: ArticleGraphRequest;
        const wrapper = mount(ArticleRelationGraph, { attachTo: document.body, props: {
            identity: graphIdentity, sessionId: 'ordinary-review', queryHost: {
                query: async candidate => candidate.requestedDepth === 1 ? graphResult(candidate, 5) : new Promise(done => { request = candidate; resolve = done; })
            }
        } });
        try {
            await settled(wrapper);
            const expand = button(wrapper, '展开到两层');
            expand.element.focus();
            await expand.trigger('click');
            expect(document.activeElement).toBe(wrapper.find('[data-graph-feedback]').element);
            expect(expand.attributes('disabled')).toBeDefined();
            const close = button(wrapper, '关闭');
            if (moveFocus) close.element.focus();
            resolve(graphResult(request, 5));
            await settled(wrapper);
            expect(document.activeElement).toBe(moveFocus ? close.element : expand.element);
            expect(expand.text()).toBe('收起到一层');
        } finally {
            wrapper.unmount();
        }
    });

    it('moves page-boundary keyboard focus to each result heading while retaining native disabled semantics', async () => {
        const wrapper = mount(ArticleRelationGraph, { attachTo: document.body, props: { identity: graphIdentity, sessionId: 'ordinary-review', queryHost: { query: async request => graphResult(request, 42) } } });
        try {
            await settled(wrapper);
            for (const [label, heading] of [['下一页文章', '[data-graph-node-heading]'], ['下一页关系', '[data-graph-edge-heading]']] as const) {
                const next = button(wrapper, label);
                next.element.focus();
                await next.trigger('click');
                expect(next.attributes('disabled')).toBeDefined();
                expect(document.activeElement).toBe(wrapper.find(heading).element);
            }
            expect(wrapper.findAll('[data-list-node]')).toHaveLength(2);
            expect(wrapper.findAll('[data-list-edge]')).toHaveLength(1);
        } finally {
            wrapper.unmount();
        }
    });

    it('separates four same-source kind glyphs without changing the four accessible source records', async () => {
        const revealSource = vi.fn();
        const wrapper = mount(ArticleRelationGraph, { props: { identity: graphIdentity, sessionId: 'ordinary-review', queryHost: { query: async request => graphResult(request, 5) }, navigationHost: { openOrActivate: vi.fn(), revealSource } } });
        try {
            await settled(wrapper);
            await wrapper.findAll('input[type="checkbox"]').at(-1)!.setValue(true);
            const glyphs = wrapper.findAll('[data-graph-edge] > text');
            expect(glyphs.map(glyph => glyph.text())).toEqual(['→', '⇒', '×', '!']);
            expect(new Set(glyphs.map(glyph => `${glyph.attributes('x')},${glyph.attributes('y')}`)).size).toBe(4);
            expect(wrapper.findAll('[data-graph-edge]').map(edge => edge.attributes('data-graph-edge'))).toEqual(wrapper.findAll('[data-list-edge]').map(edge => edge.attributes('data-list-edge')));
            for (const edge of wrapper.findAll('[data-list-edge]')) await edge.find('button').trigger('click');
            expect(revealSource.mock.calls.map(([edge]) => edge.relationIdentity)).toEqual(graphResult(graphRequest, 5).edges.map(edge => edge.relationIdentity));
            expect(wrapper.findAll('.article-relation-graph__diagram > svg')).toHaveLength(1);
            expect(wrapper.get('.article-relation-graph__diagram > svg').attributes('aria-hidden')).toBe('true');
        } finally {
            wrapper.unmount();
        }
    });
});
