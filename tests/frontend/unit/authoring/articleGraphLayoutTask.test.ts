import { describe, expect, it, vi } from 'vitest';
import { articleGraphLayoutBudget, layoutArticleGraph, runArticleGraphLayoutTask } from '@/services/authoring/articleGraphLayout';
import { ArticleGraphSession } from '@/services/authoring/articleGraphSession';
import type { ArticleGraphLayoutOutcome } from '@/services/authoring/articleGraphLayout';
import type { ArticleGraphRequest } from '@/services/authoring/articleGraphQuery';
import { graphIdentity, graphRequest, graphResult } from './articleGraphFixtures';

describe('bounded cooperative graph layout', () => {
    it.each([100, 1000])('settles %i verified nodes while a real main-thread task can run', async count => {
        const result = graphResult(graphRequest, count);
        const channel = new MessageChannel();
        let heartbeats = 0;
        let terminal = false;
        channel.port1.onmessage = () => {
            heartbeats++;
            if (!terminal) {
                channel.port2.postMessage(null);
            }
        };
        channel.port2.postMessage(null);
        try {
            const outcome = await runArticleGraphLayoutTask(result, new AbortController().signal);
            terminal = true;
            expect(outcome.status).toBe('settled');
            expect(heartbeats).toBeGreaterThan(0);
            expect(outcome.layout).toEqual(layoutArticleGraph(result));
            expect(outcome.usage).toMatchObject({ ports: 0, pendingTasks: 0 });
            expect(outcome.usage.slices).toBeLessThanOrEqual(articleGraphLayoutBudget.slices);
            expect(outcome.usage.maxSliceMilliseconds).toBeLessThanOrEqual(articleGraphLayoutBudget.sliceMilliseconds);
            expect(outcome.usage.cpuMilliseconds).toBeLessThanOrEqual(articleGraphLayoutBudget.cpuMilliseconds);
            expect(outcome.usage.wallMilliseconds).toBeLessThanOrEqual(articleGraphLayoutBudget.wallMilliseconds);
        } finally {
            terminal = true;
            channel.port1.onmessage = null;
            channel.port1.close();
            channel.port2.close();
        }
    });

    it('does not allocate a task/port for ten thousand nodes', async () => {
        const constructor = vi.spyOn(globalThis, 'MessageChannel');
        const outcome = await runArticleGraphLayoutTask(graphResult(graphRequest, 10000), new AbortController().signal);
        expect(outcome).toMatchObject({ status: 'blocked', reason: 'node-budget', layout: null, usage: { slices: 0, pendingTasks: 0, ports: 0 } });
        expect(constructor).not.toHaveBeenCalled();
        constructor.mockRestore();
    });

    it('degrades task creation failure and rejected reset without erasing list facts', async () => {
        vi.stubGlobal('MessageChannel', class { public constructor() { throw new Error('unavailable'); } });
        try {
            expect(await runArticleGraphLayoutTask(graphResult(graphRequest), new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'task-unavailable', usage: { ports: 0, slices: 0 } });
        } finally {
            vi.unstubAllGlobals();
        }
        let reject = false;
        const session = new ArticleGraphSession({ query: async request => graphResult(request) }, undefined, undefined,
            (result, signal) => reject ? Promise.reject(new Error('failed')) : runArticleGraphLayoutTask(result, signal));
        await session.open(graphIdentity, 'session');
        const facts = session.state.result;
        reject = true;
        await session.resetLayout();
        expect(session.state).toMatchObject({ result: facts, layout: null, pending: false, layoutOutcome: { status: 'blocked', reason: 'layout-error', usage: null } });
    });

    it('closes both actual ports/detaches abort after settle and posts no continuing task', async () => {
        const real = MessageChannel;
        const ports: MessagePort[] = [];
        const closeCalls: ReturnType<typeof vi.spyOn>[] = [];
        let posts = 0;
        vi.stubGlobal('MessageChannel', class {
            public port1: MessagePort;
            public port2: MessagePort;
            public constructor() {
                const channel = new real();
                this.port1 = channel.port1;
                this.port2 = channel.port2;
                ports.push(this.port1, this.port2);
                closeCalls.push(vi.spyOn(this.port1, 'close'), vi.spyOn(this.port2, 'close'));
                const post = this.port2.postMessage.bind(this.port2);
                vi.spyOn(this.port2, 'postMessage').mockImplementation(message => { posts++; post(message); });
            }
        });
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        try {
            const outcome = await runArticleGraphLayoutTask(graphResult(graphRequest, 1000), controller.signal);
            expect(outcome.status).toBe('settled');
            expect(ports).toHaveLength(2);
            expect(closeCalls.every(close => close.mock.calls.length === 1)).toBe(true);
            expect(remove.mock.calls.some(([event]) => event === 'abort')).toBe(true);
            const count = posts;
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(posts).toBe(count);
            controller.abort();
            expect(closeCalls.every(close => close.mock.calls.length === 1)).toBe(true);
        } finally {
            vi.unstubAllGlobals();
            remove.mockRestore();
        }
    });

    it('cancel before/during a queued slice releases resources without a partial layout', async () => {
        const pre = new AbortController();
        pre.abort();
        expect(await runArticleGraphLayoutTask(graphResult(graphRequest, 1000), pre.signal)).toMatchObject({ status: 'cancelled', usage: { slices: 0 } });
        const controller = new AbortController();
        const task = runArticleGraphLayoutTask(graphResult(graphRequest, 1000), controller.signal);
        queueMicrotask(() => controller.abort());
        expect(await task).toMatchObject({ status: 'cancelled', reason: 'cancelled', layout: null, usage: { ports: 0, pendingTasks: 0 } });
    });

    it('hits slice/cpu/wall limits explicitly rather than committing partial positions', async () => {
        const result = graphResult(graphRequest, 1000);
        expect(await runArticleGraphLayoutTask(result, new AbortController().signal, { ...articleGraphLayoutBudget, slices: 1 })).toMatchObject({ status: 'blocked', reason: 'slice-budget', layout: null });
        const now = vi.spyOn(performance, 'now');
        let value = 0;
        now.mockImplementation(() => value += 10);
        try {
            expect(await runArticleGraphLayoutTask(result, new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'cpu-budget', layout: null });
            value = 0;
            now.mockImplementation(() => value += 1000);
            expect(await runArticleGraphLayoutTask(result, new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'time-budget', layout: null });
        } finally {
            now.mockRestore();
        }
        expect(() => runArticleGraphLayoutTask(result, new AbortController().signal, { ...articleGraphLayoutBudget, slices: 1000 })).toThrow('invalid-layout-budget');
    });

    it('seals reduced budgets before the caller can enlarge them between tasks', async () => {
        const budget = { ...articleGraphLayoutBudget, slices: 1 };
        const task = runArticleGraphLayoutTask(graphResult(graphRequest, 1000), new AbortController().signal, budget);
        budget.slices = 10000;
        budget.cpuMilliseconds = 10000;
        budget.wallMilliseconds = 10000;
        expect(await task).toMatchObject({ status: 'blocked', reason: 'slice-budget', layout: null, usage: { slices: 1 } });
    });

    it('keeps normal/reduced-motion settlement identical and drag/reset transient', async () => {
        const motion = vi.fn().mockReturnValue({ matches: false });
        vi.stubGlobal('matchMedia', motion);
        const storage = vi.spyOn(localStorage, 'setItem');
        const frames = vi.spyOn(globalThis, 'requestAnimationFrame');
        try {
            const session = new ArticleGraphSession({ query: async request => graphResult(request, 1000) });
            await session.open(graphIdentity, 'session');
            const normal = session.state.layout;
            session.moveNode(graphIdentity.rootArticle, 30, 30);
            motion.mockReturnValue({ matches: true });
            await session.resetLayout();
            expect(session.state.layout).toEqual(normal);
            expect(session.state.layoutOutcome).not.toHaveProperty('layout');
            expect(storage).not.toHaveBeenCalled();
            expect(frames).not.toHaveBeenCalled();
            session.close();
            await session.open(graphIdentity, 'fresh');
            expect(session.state.layout).toEqual(normal);
            expect(session.state.request?.requestedDepth).toBe(1);
            session.close();
        } finally {
            storage.mockRestore();
            frames.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it('old layout generations cannot replace current even when the runner ignores abort', async () => {
        const pending: { signal: AbortSignal; resolve: (outcome: ArticleGraphLayoutOutcome) => void }[] = [];
        const session = new ArticleGraphSession({ query: async request => graphResult(request) }, undefined, undefined,
            (_result, signal) => new Promise(resolve => pending.push({ signal, resolve })));
        const old = session.open(graphIdentity, 'old');
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        const current = session.open({ ...graphIdentity, documentEpoch: 'new-epoch' }, 'current');
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(pending[0]!.signal.aborted).toBe(true);
        const outcome = await runArticleGraphLayoutTask(graphResult(graphRequest), new AbortController().signal);
        pending[1]!.resolve(outcome);
        await current;
        const exact = session.state;
        pending[0]!.resolve(outcome);
        await old;
        expect(session.state).toBe(exact);
        const reset = session.resetLayout();
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        session.close();
        pending[2]!.resolve(outcome);
        await reset;
        expect(session.state).toMatchObject({ result: null, layout: null, pending: false });
    });

    it('budget-blocked layout retains the exact authorized result for equivalent list navigation', async () => {
        const query = (request: ArticleGraphRequest) => Promise.resolve(graphResult(request, 1000));
        const session = new ArticleGraphSession({ query }, undefined, undefined,
            (result, signal) => runArticleGraphLayoutTask(result, signal, { ...articleGraphLayoutBudget, slices: 1 }));
        await session.open(graphIdentity, 'session');
        expect(session.state.result?.nodes).toHaveLength(1000);
        expect(session.state.result?.status).toBe('complete');
        expect(session.state.layout).toBeNull();
        expect(session.state.layoutOutcome).toMatchObject({ status: 'blocked', reason: 'slice-budget', usage: { ports: 0, pendingTasks: 0 } });
    });
});
