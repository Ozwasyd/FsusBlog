#!/usr/bin/env node
// Browser pressure check of the actual source task. Synthetic public fixtures are not a relation-query receipt.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireFrontend = createRequire(resolve(root, 'src/frontend/package.json'));
const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
const { chromium } = requireFrontend('@playwright/test');
const evidenceRoot = resolve(root, '.tmp/article-graph-evidence');
mkdirSync(evidenceRoot, { recursive: true });
const server = await createServer({
    configFile: false,
    root,
    cacheDir: resolve(root, '.tmp/article-graph-browser-vite'),
    resolve: { alias: { '@': resolve(root, 'src/frontend/src') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
        name: 'graph-layout-fixture-page',
        configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
                if (request.url === '/graph-layout-harness') {
                    response.setHeader('Content-Type', 'text/html');
                    response.end('<!doctype html><html><head><title>Graph layout pressure fixture</title></head><body></body></html>');
                } else {
                    next();
                }
            });
        }
    }],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    logLevel: 'error'
});
let browser;
try {
    await server.listen();
    const address = server.httpServer.address();
    assert(address && typeof address === 'object');
    const executablePath = process.env.FSUSBLOG_GRAPH_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/graph-layout-harness`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const measured = await page.evaluate(async () => {
        const { runArticleGraphLayoutTask, layoutArticleGraph, articleGraphLayoutBudget } = await import('/src/frontend/src/services/authoring/articleGraphLayout.ts');
        const { ArticleGraphSession } = await import('/src/frontend/src/services/authoring/articleGraphSession.ts');
        const { graphRequest, graphIdentity, graphResult } = await import('/tests/frontend/unit/authoring/articleGraphFixtures.ts');
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const native = MessageChannel;
        const active = new Set();
        let allocations = 0;
        let posts = 0;
        let closes = 0;
        let onPost;
        globalThis.MessageChannel = class {
            constructor() {
                allocations++;
                const channel = new native();
                this.port1 = channel.port1;
                this.port2 = channel.port2;
                for (const port of [this.port1, this.port2]) {
                    active.add(port);
                    const close = port.close.bind(port);
                    port.close = () => {
                        check(active.delete(port), 'port closed twice');
                        closes++;
                        close();
                    };
                }
                const post = this.port2.postMessage.bind(this.port2);
                this.port2.postMessage = message => { posts++; post(message); onPost?.(); };
            }
        };
        const measurements = [];
        try {
            for (const count of [100, 1000]) {
                const result = graphResult(graphRequest, count);
                if (count === 1000) {
                    // Exercise the admitted 2000-edge ceiling using source records from the existing fixture only.
                    result.edges = Array.from({ length: 2000 }, (_, index) => ({ ...result.edges[index % result.edges.length], relationIdentity: `pressure-${String(index).padStart(5, '0')}` }));
                }
                const heartbeat = new native();
                let beats = 0;
                let maxGap = 0;
                let previous = performance.now();
                let stopped = false;
                heartbeat.port1.onmessage = () => {
                    const now = performance.now();
                    maxGap = Math.max(maxGap, now - previous);
                    previous = now;
                    beats++;
                    if (!stopped) heartbeat.port2.postMessage(null);
                };
                heartbeat.port2.postMessage(null);
                const outcome = await runArticleGraphLayoutTask(result, new AbortController().signal);
                stopped = true;
                heartbeat.port1.onmessage = null;
                heartbeat.port1.close();
                heartbeat.port2.close();
                check(outcome.status === 'settled', `${count}: ${outcome.reason} ${JSON.stringify(outcome.usage)}`);
                check(beats > 0, `${count}: no main-thread response`);
                check(maxGap <= 50, `${count}: long response gap ${maxGap}`);
                check(JSON.stringify(outcome.layout) === JSON.stringify(layoutArticleGraph(result)), `${count}: nondeterministic layout`);
                check(active.size === 0, `${count}: live port at settle`);
                measurements.push({ nodes: count, edges: result.edges.length, heartbeats: beats, maxHeartbeatGapMilliseconds: maxGap, ...outcome.usage });
            }
            const beforeOversize = allocations;
            const oversize = await runArticleGraphLayoutTask(graphResult(graphRequest, 10000), new AbortController().signal);
            check(oversize.reason === 'node-budget' && !oversize.layout && allocations === beforeOversize, '10000-node allocation/refusal failed');
            const controller = new AbortController();
            let cancelPosts = 0;
            onPost = () => { if (++cancelPosts === 2) controller.abort(); };
            const cancelled = await runArticleGraphLayoutTask(graphResult(graphRequest, 1000), controller.signal);
            onPost = undefined;
            check(cancelled.status === 'cancelled' && cancelled.usage.slices > 0 && active.size === 0, 'active cancellation failed');
            const beforeConstrainedPosts = posts;
            const constrained = await runArticleGraphLayoutTask(graphResult(graphRequest, 1000), new AbortController().signal, { ...articleGraphLayoutBudget, slices: 1 });
            check(constrained.reason === 'slice-budget' && !constrained.layout && active.size === 0 && constrained.usage.slices === 1 && posts - beforeConstrainedPosts === 1, 'bounded degradation failed');
            const session = new ArticleGraphSession({ query: async request => graphResult(request, 1000) });
            await session.open(graphIdentity, 'normal');
            const deterministic = JSON.stringify(session.state.layout);
            session.moveNode(graphIdentity.rootArticle, 30, 30);
            await session.resetLayout();
            check(JSON.stringify(session.state.layout) === deterministic, 'drag persisted after reset');
            const closing = session.resetLayout();
            session.close();
            await closing;
            check(!session.state.result && !session.state.layout && !session.state.pending && active.size === 0, 'close refilled state/resources');
            await session.open(graphIdentity, 'reopen');
            check(session.state.request.requestedDepth === 1 && JSON.stringify(session.state.layout) === deterministic, 'reopen inherited state');
            session.close();
            const terminalPosts = posts;
            const terminalCloses = closes;
            await new Promise(resolve => setTimeout(resolve, 100));
            check(posts === terminalPosts && closes === terminalCloses && active.size === 0, 'continuing task after terminal stop');
            return { fixtureOnly: true, cpuThrottlingRate: 4, measurements, oversize: { status: oversize.status, reason: oversize.reason, usage: oversize.usage }, cancellation: cancelled.usage, terminal: { allocations, closes, livePorts: active.size, continuingPosts: posts - terminalPosts } };
        } finally {
            globalThis.MessageChannel = native;
        }
    });
    const motionLayout = async () => {
        const { ArticleGraphSession } = await import('/src/frontend/src/services/authoring/articleGraphSession.ts');
        const { graphIdentity, graphResult } = await import('/tests/frontend/unit/authoring/articleGraphFixtures.ts');
        const session = new ArticleGraphSession({ query: async request => graphResult(request, 1000) });
        await session.open(graphIdentity, 'motion');
        if (!session.state.layout) throw new Error(`motion-layout: ${session.state.layoutOutcome?.reason}`);
        const positions = JSON.stringify(session.state.layout.positions);
        session.close();
        return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, positions };
    };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await page.evaluate(motionLayout);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await page.evaluate(motionLayout);
    assert.equal(normal.reduced, false);
    assert.equal(reduced.reduced, true);
    assert.equal(normal.positions, reduced.positions, 'real reduced-motion layout parity');
    assert.deepEqual(errors, [], 'unhandled browser error');
    const receipt = { browser: browser.version(), sourceOnly: true, productionQueryAcceptance: false, reducedMotionParity: true, ...measured };
    writeFileSync(resolve(evidenceRoot, 'layout-browser-pressure.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt, null, 2));
} finally {
    await browser?.close();
    await server.close();
}
