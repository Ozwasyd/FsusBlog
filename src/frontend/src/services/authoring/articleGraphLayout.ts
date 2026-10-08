import { articleGraphLimits } from './articleGraphQuery';

import type { ArticleGraphResult } from './articleGraphQuery';

export interface ArticleGraphPosition {
    readonly articleIdentity: string;
    readonly x: number;
    readonly y: number;
}

export interface ArticleGraphLayout {
    readonly algorithm: 'stable-grid-v1';
    readonly width: number;
    readonly height: number;
    readonly positions: readonly ArticleGraphPosition[];
    readonly nodeOrder: readonly string[];
    readonly edgeOrder: readonly string[];
}

/** Fixed hard limits; callers may reduce limits but cannot enlarge the runtime envelope. */
export interface ArticleGraphLayoutBudget {
    readonly itemsPerSlice: number;
    readonly slices: number;
    readonly sliceMilliseconds: number;
    readonly cpuMilliseconds: number;
    readonly wallMilliseconds: number;
}
export const articleGraphLayoutBudget: ArticleGraphLayoutBudget = Object.freeze({ itemsPerSlice: 128, slices: 64, sliceMilliseconds: 8, cpuMilliseconds: 50, wallMilliseconds: 500 });
export type ArticleGraphLayoutReason = 'node-budget' | 'edge-budget' | 'slice-budget' | 'cpu-budget' | 'time-budget' | 'task-unavailable' | 'layout-error' | 'cancelled';

/** Resource/timing observations are transient diagnostics, not production acceptance receipts. */
export interface ArticleGraphLayoutUsage {
    readonly slices: number;
    readonly maxSliceMilliseconds: number;
    readonly cpuMilliseconds: number;
    readonly wallMilliseconds: number;
    readonly pendingTasks: 0;
    readonly ports: 0;
}

export interface ArticleGraphLayoutOutcome {
    readonly status: 'settled' | 'blocked' | 'cancelled';
    readonly reason: ArticleGraphLayoutReason | null;
    readonly layout: ArticleGraphLayout | null;
    readonly usage: ArticleGraphLayoutUsage;
}

export type ArticleGraphLayoutRunner = (result: ArticleGraphResult, signal: AbortSignal) => Promise<ArticleGraphLayoutOutcome>;
const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** One deterministic kernel, drained by either source verification or the production cooperative task. */
function* layoutSteps(result: ArticleGraphResult, itemsPerSlice = articleGraphLayoutBudget.itemsPerSlice): Generator<void, ArticleGraphLayout>
{
    const nodeOrder: string[] = [];
    const edgeOrder: string[] = [];
    for (let index = 0; index < result.nodes.length; index++)
    {
        nodeOrder.push(result.nodes[index].articleIdentity);
        if ((index + 1) % itemsPerSlice === 0)
        {
            yield;
        }
    }
    yield;
    // Each native sort is capped by the admitted 1000/2000 limits and checked against the slice CPU budget.
    nodeOrder.sort(compareIds);
    const rootIndex = nodeOrder.indexOf(result.identity.rootArticle);
    if (rootIndex >= 0)
    {
        nodeOrder.splice(rootIndex, 1);
        nodeOrder.unshift(result.identity.rootArticle);
    }
    yield;
    for (let index = 0; index < result.edges.length; index++)
    {
        edgeOrder.push(result.edges[index].relationIdentity);
        if ((index + 1) % itemsPerSlice === 0)
        {
            yield;
        }
    }
    yield;
    edgeOrder.sort(compareIds);
    yield;
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodeOrder.length)));
    const positions: ArticleGraphPosition[] = [];
    for (let index = 0; index < nodeOrder.length; index++)
    {
        positions.push(Object.freeze({ articleIdentity: nodeOrder[index], x: 80 + index % columns * 160, y: 50 + Math.floor(index / columns) * 100 }));
        if ((index + 1) % itemsPerSlice === 0)
        {
            yield;
        }
    }
    return Object.freeze({ algorithm: 'stable-grid-v1', width: columns * 160, height: Math.max(100, Math.ceil(nodeOrder.length / columns) * 100), positions: Object.freeze(positions), nodeOrder: Object.freeze(nodeOrder), edgeOrder: Object.freeze(edgeOrder) });
}

function sizeReason(result: ArticleGraphResult): ArticleGraphLayoutReason | null
{
    return result.nodes.length > articleGraphLimits.nodes ? 'node-budget' : result.edges.length > articleGraphLimits.edges ? 'edge-budget' : null;
}

/** Synchronous source verifier only. Product sessions always use the cancellable task below. */
export function layoutArticleGraph(result: ArticleGraphResult): ArticleGraphLayout
{
    if (sizeReason(result))
    {
        throw new Error('layout-budget');
    }
    const steps = layoutSteps(result);
    let step = steps.next();
    while (!step.done)
    {
        step = steps.next();
    }
    return step.value;
}

/** Static under normal/reduced motion. Every slice is a real task; terminal paths close ports and detach cancellation. */
export function runArticleGraphLayoutTask(result: ArticleGraphResult, signal: AbortSignal, limits: ArticleGraphLayoutBudget = articleGraphLayoutBudget): Promise<ArticleGraphLayoutOutcome>
{
    const budget = Object.freeze({ itemsPerSlice: limits.itemsPerSlice, slices: limits.slices, sliceMilliseconds: limits.sliceMilliseconds,
        cpuMilliseconds: limits.cpuMilliseconds, wallMilliseconds: limits.wallMilliseconds });
    for (const key of Object.keys(articleGraphLayoutBudget) as (keyof ArticleGraphLayoutBudget)[])
    {
        if (!Number.isFinite(budget[key]) || budget[key] <= 0 || budget[key] > articleGraphLayoutBudget[key])
        {
            throw new Error('invalid-layout-budget');
        }
    }
    if (!Number.isSafeInteger(budget.itemsPerSlice) || !Number.isSafeInteger(budget.slices))
    {
        throw new Error('invalid-layout-budget');
    }
    const started = performance.now();
    let slices = 0;
    let cpuMilliseconds = 0;
    let maxSliceMilliseconds = 0;
    const outcome = (status: ArticleGraphLayoutOutcome['status'], reason: ArticleGraphLayoutReason | null, layout: ArticleGraphLayout | null): ArticleGraphLayoutOutcome => Object.freeze({ status, reason, layout,
        usage: Object.freeze({ slices, cpuMilliseconds, maxSliceMilliseconds, wallMilliseconds: performance.now() - started, pendingTasks: 0, ports: 0 }) });
    const reason = sizeReason(result);
    if (reason || signal.aborted || typeof MessageChannel === 'undefined')
    {
        return Promise.resolve(outcome(signal.aborted ? 'cancelled' : 'blocked', signal.aborted ? 'cancelled' : reason ?? 'task-unavailable', null));
    }
    return new Promise(resolve =>
    {
        let channel: MessageChannel;
        try
        {
            channel = new MessageChannel();
        }
        catch
        {
            resolve(outcome('blocked', 'task-unavailable', null));
            return;
        }
        const steps = layoutSteps(result, budget.itemsPerSlice);
        let finished = false;
        const finish = (status: ArticleGraphLayoutOutcome['status'], reason: ArticleGraphLayoutReason | null, layout: ArticleGraphLayout | null): void =>
        {
            if (finished)
            {
                return;
            }
            finished = true;
            channel.port1.onmessage = null;
            channel.port1.close();
            channel.port2.close();
            signal.removeEventListener('abort', cancel);
            steps.return?.(undefined as never);
            resolve(outcome(status, reason, layout));
        };
        const cancel = (): void => finish('cancelled', 'cancelled', null);
        const enqueue = (): void =>
        {
            try
            {
                channel.port2.postMessage(null);
            }
            catch
            {
                finish('blocked', 'layout-error', null);
            }
        };
        signal.addEventListener('abort', cancel, { once: true });
        channel.port1.onmessage = () =>
        {
            if (signal.aborted)
            {
                cancel();
                return;
            }
            if (slices >= budget.slices || performance.now() - started > budget.wallMilliseconds)
            {
                finish('blocked', slices >= budget.slices ? 'slice-budget' : 'time-budget', null);
                return;
            }
            slices++;
            const sliceStart = performance.now();
            let step: IteratorResult<void, ArticleGraphLayout>;
            try
            {
                step = steps.next();
            }
            catch
            {
                finish('blocked', 'layout-error', null);
                return;
            }
            const elapsed = performance.now() - sliceStart;
            cpuMilliseconds += elapsed;
            maxSliceMilliseconds = Math.max(maxSliceMilliseconds, elapsed);
            if (elapsed > budget.sliceMilliseconds || cpuMilliseconds > budget.cpuMilliseconds)
            {
                finish('blocked', 'cpu-budget', null);
            }
            else if (step.done)
            {
                finish('settled', null, step.value);
            }
            else if (slices >= budget.slices)
            {
                finish('blocked', 'slice-budget', null);
            }
            else
            {
                enqueue();
            }
        };
        enqueue();
    });
}
