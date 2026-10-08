import { describe, expect, it, vi } from 'vitest';
import { createMarkdownEmbedRequest } from '@ozwasyd/element-plus/markdown-runtime';
import type { MarkdownEmbedRequest } from '@ozwasyd/element-plus';

import {
    authoringMarkdownProviderSchema,
    createAuthoringMarkdownEmbedProvider
} from '@/fsusui/authoringMarkdownProviders';
import type {
    AuthoringMarkdownProviderHost,
    AuthoringMarkdownProviderInvocation
} from '@/fsusui/authoringMarkdownProviders';

const request = (overrides = {}) => createMarkdownEmbedRequest({
    documentIdentity: { id: 'article-1', epoch: 2 }, revision: 3, nodeId: 'canonical-node-1',
    target: 'note', mode: 'article', version: 1, ...overrides
});
const fixture = () => {
    const authority = new AbortController();
    let current = true;
    const projection = {
        schema: authoringMarkdownProviderSchema, featureKind: 'embed', providerId: 'example.reader',
        extensionId: 'example', extensionVersion: '1.0', packageSha256: 'a'.repeat(64),
        runtimeIdentity: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), lifecycleGeneration: 1,
        executionClass: 'isolated-worker-wasm', permission: 'document-range-read', grantIdentity: 'grant-1',
        documentId: 'article-1', documentEpoch: 2, sourceRevision: 3, nodeId: 'canonical-node-1',
        range: { start: 10, end: 14 }, source: 'node', sourceSha256: 'd'.repeat(64),
        maximumResultBytes: 32, deadlineMilliseconds: 1000
    };
    const dispatch = vi.fn(async (invocation: AuthoringMarkdownProviderInvocation) => ({
        identity: invocation.identity, status: 'resolved', title: 'Note', excerpt: 'Text'
    }));
    const host: AuthoringMarkdownProviderHost = {
        current: () => projection, isCurrent: () => current, signal: () => authority.signal, dispatch
    };
    return { projection, host, dispatch, authority, invalidate: () => { current = false; } };
};

describe('authoring Markdown public embed adapter', () => {
    it('charges each live cache entry once when eight same-key requests finish concurrently', async () => {
        const f = fixture();
        f.projection.maximumResultBytes = 16384;
        f.host.current = input => ({ ...f.projection, nodeId: input.nodeId });
        f.host.dispatch = vi.fn(async invocation => ({
            identity: invocation.identity, status: 'resolved', excerpt: 'x'.repeat(16384)
        }));
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        try {
            for (let node = 0; node < 32; node += 1) {
                const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
                    adapter.provider(request({ nodeId: `shared-${node}`, requestId: `request-${node}-${index}` }))));
                expect(results.every(result => result.status === 'resolved')).toBe(true);
            }
            const dispatched = vi.mocked(f.host.dispatch).mock.calls.length;
            for (let node = 0; node < 32; node += 1) {
                expect((await adapter.provider(request({ nodeId: `shared-${node}` }))).status).toBe('resolved');
            }
            expect(vi.mocked(f.host.dispatch)).toHaveBeenCalledTimes(dispatched);
        } finally {
            adapter.dispose();
        }
    });

    it.each(['request', 'projection', 'result'] as const)(
        'rejects accessor, symbol, hidden and foreign-prototype %s fields without invoking them',
        async surface => {
            for (const kind of ['accessor', 'symbol', 'hidden', 'prototype']) {
                const f = fixture();
                const callback = vi.fn(() => surface === 'request' ? 'note' : 'text');
                const input = { ...request(), documentIdentity: { id: 'article-1', epoch: 2 } };
                const output: Record<string, unknown> = { status: 'resolved', title: 'text' };
                const target: Record<string, unknown> = surface === 'request' ? input :
                    surface === 'projection' ? f.projection : output;
                if (kind === 'accessor') {
                    const key = surface === 'request' ? 'target' : surface === 'projection' ? 'source' : 'title';
                    Object.defineProperty(target, key, { enumerable: true, get: callback });
                } else if (kind === 'symbol') {
                    Object.defineProperty(target, Symbol('unknown'), { value: 'extra' });
                } else if (kind === 'hidden') {
                    Object.defineProperty(target, 'unknown', { value: 'extra', enumerable: false });
                } else {
                    Object.setPrototypeOf(target, { unknown: 'extra' });
                }
                f.host.dispatch = async invocation => {
                    output.identity = invocation.identity;
                    return output;
                };
                const adapter = createAuthoringMarkdownEmbedProvider(f.host);
                try {
                    if (surface === 'request') {
                        await expect(adapter.provider(input as MarkdownEmbedRequest)).rejects.toThrow(TypeError);
                    } else {
                        expect((await adapter.provider(input)).status).toBe(surface === 'projection' ? 'forbidden' : 'rejected');
                    }
                    expect(callback).not.toHaveBeenCalled();
                } finally {
                    adapter.dispose();
                }
            }
        }
    );

    it.each(['documentIdentity', 'range'] as const)('rejects nested %s accessors before reading data', async field => {
        const f = fixture();
        const input = { ...request(), documentIdentity: { id: 'article-1', epoch: 2 } };
        const callback = vi.fn(() => field === 'documentIdentity' ? 'article-1' : 10);
        const target = field === 'documentIdentity' ? input.documentIdentity : f.projection.range;
        Object.defineProperty(target, field === 'documentIdentity' ? 'id' : 'start', { enumerable: true, get: callback });
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        try {
            if (field === 'documentIdentity') {
                await expect(adapter.provider(input)).rejects.toThrow(TypeError);
            } else {
                expect((await adapter.provider(input)).status).toBe('forbidden');
            }
            expect(callback).not.toHaveBeenCalled();
        } finally {
            adapter.dispose();
        }
    });

    it.each(['executionClass', 'status'] as const)('rejects object-valued %s without coercion', async field => {
        const f = fixture();
        const callback = vi.fn(() => field === 'executionClass' ? 'isolated-worker-wasm' : 'resolved');
        if (field === 'executionClass') {
            Object.assign(f.projection, { executionClass: { toString: callback } });
        } else {
            f.host.dispatch = async invocation => ({ identity: invocation.identity, status: { toString: callback } });
        }
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        try {
            expect((await adapter.provider(request())).status).toBe(field === 'executionClass' ? 'forbidden' : 'rejected');
            expect(callback).not.toHaveBeenCalled();
        } finally {
            adapter.dispose();
        }
    });

    it.each(['abort', 'dispose'] as const)('rechecks terminal %s after the host current callback', async action => {
        const f = fixture();
        let checks = 0;
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        f.host.isCurrent = () => {
            checks += 1;
            // Initial and post-signal admission precede dispatch; the third check owns the returned result.
            if (checks === 3) {
                if (action === 'abort') f.authority.abort();
                else adapter.dispose();
            }
            return true;
        };
        try {
            expect((await adapter.provider(request())).status).toBe('stale');
            expect(checks).toBe(3);
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect((await adapter.provider(request())).status).toBe(action === 'abort' ? 'stale' : 'missing');
        } finally {
            adapter.dispose();
        }
    });

    it('does not dispatch when resolving the authority signal synchronously disposes the adapter', async () => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        f.host.signal = () => {
            adapter.dispose();
            return f.authority.signal;
        };
        expect((await adapter.provider(request())).status).toBe('stale');
        expect(f.dispatch).not.toHaveBeenCalled();
    });

    it.each(['cold', 'warm'] as const)('rejects a synchronous document switch in the signal callback with a %s cache', async cacheState => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        try {
            if (cacheState === 'warm') {
                expect((await adapter.provider(request({ requestId: 'prime' }))).status).toBe('resolved');
                expect(f.dispatch).toHaveBeenCalledTimes(1);
                f.dispatch.mockClear();
            }
            f.host.signal = () => {
                f.invalidate();
                return f.authority.signal;
            };
            expect((await adapter.provider(request({ requestId: 'switch' }))).status).toBe('stale');
            expect(f.authority.signal.aborted).toBe(false);
            expect(f.dispatch).not.toHaveBeenCalled();
        } finally {
            adapter.dispose();
        }
    });

    it.each(['abort', 'dispose'] as const)('rejects terminal %s in the post-signal current callback before dispatch', async action => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        let checks = 0;
        f.host.isCurrent = () => {
            checks += 1;
            if (checks === 2) {
                if (action === 'abort') f.authority.abort();
                else adapter.dispose();
            }
            return true;
        };
        try {
            expect((await adapter.provider(request())).status).toBe('stale');
            expect(checks).toBe(2);
            expect(f.dispatch).not.toHaveBeenCalled();
        } finally {
            adapter.dispose();
        }
    });

    it('uses the public gateway with immutable exact range authority and identity', async () => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        const input = request();
        const output = await adapter.provider(input);
        expect(output).toEqual({ ...input, status: 'resolved', title: 'Note', excerpt: 'Text' });
        const invocation = f.dispatch.mock.calls[0]![0];
        expect(invocation.projection.range).toEqual({ start: 10, end: 14 });
        expect(invocation.projection.source).toBe('node');
        expect(Object.isFrozen(invocation.projection.range)).toBe(true);
        expect(Object.isFrozen(invocation.request.documentIdentity)).toBe(true);
        adapter.dispose();
    });

    it.each([
        { featureKind: 'new-syntax' }, { permission: 'document-full-read' },
        { permission: 'network-destination' }, { providerId: 'fsusblog.core.reader' },
        { executionClass: 'main-thread' }, { documentEpoch: 3 }, { nodeId: 'other-node' },
        { range: { start: 10, end: 15 } }, { deadlineMilliseconds: 0 }, { html: '<p>bad</p>' }
    ])('denies unsupported or broad projection %j before dispatch', async mutation => {
        const f = fixture();
        Object.assign(f.projection, mutation);
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        expect((await adapter.provider(request())).status).toBe('forbidden');
        expect(f.dispatch).not.toHaveBeenCalled();
        adapter.dispose();
    });

    it.each(['html', 'component', 'iframe', 'transaction', 'editorState'])('rejects %s result surfaces', async key => {
        const f = fixture();
        f.host.dispatch = async invocation => ({ identity: invocation.identity, status: 'resolved', [key]: 'bad' });
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        expect((await adapter.provider(request())).status).toBe('rejected');
        adapter.dispose();
    });

    it('rejects foreign result identity and enforces UTF-8 result budget', async () => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        f.host.dispatch = async () => ({ identity: 'foreign', status: 'resolved' });
        expect((await adapter.provider(request())).status).toBe('rejected');
        f.host.dispatch = async invocation => ({ identity: invocation.identity, status: 'resolved', title: 'é'.repeat(17) });
        expect((await adapter.provider(request())).status).toBe('size-exceeded');
        adapter.dispose();
    });

    it('contains transport crashes in the corresponding node and keeps the directive unchanged', async () => {
        const f = fixture();
        f.host.dispatch = async () => { throw new Error('provider-crashed'); };
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        const input = request();
        expect(await adapter.provider(input)).toEqual({ ...input, status: 'rejected' });
        expect(input.target).toBe('note');
        expect(f.projection.source).toBe('node');
        adapter.dispose();
    });

    it('does not reuse identical source across rapid document and revision switches', async () => {
        const f = fixture();
        f.host.current = input => ({
            ...f.projection, documentId: input.documentIdentity.id,
            documentEpoch: input.documentIdentity.epoch, sourceRevision: input.revision
        });
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        for (let epoch = 0; epoch < 1000; epoch += 1) {
            const input = request({ documentIdentity: { id: `document-${epoch % 2}`, epoch }, revision: epoch });
            const result = await adapter.provider(input);
            expect(result.status).toBe('resolved');
            expect(result.documentIdentity).toEqual(input.documentIdentity);
            expect(result.revision).toBe(epoch);
        }
        expect(f.dispatch).toHaveBeenCalledTimes(1000);
        adapter.dispose();
    });

    it('does not reuse target-only cache across plugin, version, config, range, runtime or lifecycle', async () => {
        const f = fixture();
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        await adapter.provider(request({ requestId: 'one' }));
        await adapter.provider(request({ requestId: 'two' }));
        expect(f.dispatch).toHaveBeenCalledTimes(1);
        for (const mutation of [
            { extensionVersion: '2.0' }, { packageSha256: 'e'.repeat(64) },
            { configurationSha256: 'f'.repeat(64) }, { runtimeIdentity: 'e'.repeat(64) },
            { lifecycleGeneration: 2 }, { grantIdentity: 'grant-2' },
            { range: { start: 11, end: 15 } }, { source: 'next', sourceSha256: 'f'.repeat(64) },
            { providerId: 'example.other' }
        ]) {
            Object.assign(f.projection, mutation);
            expect((await adapter.provider(request())).status).toBe('resolved');
        }
        expect(f.dispatch).toHaveBeenCalledTimes(10);
        adapter.dispose();
    });

    it('rejects same-source document switches, cancelled, disabled and uninstalled work', async () => {
        const f = fixture();
        let complete: (value: unknown) => void = () => {};
        let invocation: AuthoringMarkdownProviderInvocation;
        f.host.dispatch = value => {
            invocation = value;
            return new Promise(resolve => { complete = resolve; });
        };
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        const pending = adapter.provider(request());
        f.invalidate();
        complete({ identity: invocation!.identity, status: 'resolved', title: 'late' });
        expect((await pending).status).toBe('stale');
        const g = fixture();
        g.host.dispatch = () => new Promise(() => {});
        const cancellable = createAuthoringMarkdownEmbedProvider(g.host);
        const cancelled = cancellable.provider(request());
        g.authority.abort();
        expect((await cancelled).status).toBe('stale');
        adapter.dispose();
        expect((await adapter.provider(request())).status).toBe('missing');
        cancellable.dispose();
    });

    it('times out uncooperative transport and aborts in-flight work on dispose', async () => {
        vi.useFakeTimers();
        try {
            const f = fixture();
            let signal: AbortSignal;
            f.host.dispatch = (_invocation, value) => { signal = value; return new Promise(() => {}); };
            const adapter = createAuthoringMarkdownEmbedProvider(f.host);
            const pending = adapter.provider(request());
            await vi.advanceTimersByTimeAsync(1000);
            expect((await pending).status).toBe('time-exceeded');
            expect(signal!.aborted).toBe(true);
            const second = adapter.provider(request());
            adapter.dispose();
            expect((await second).status).toBe('stale');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds simultaneous invocations and survives 1000 canonical nodes without cross-node cache', async () => {
        const f = fixture();
        f.host.current = input => ({ ...f.projection, nodeId: input.nodeId });
        const adapter = createAuthoringMarkdownEmbedProvider(f.host);
        for (let node = 0; node < 1000; node += 1) {
            expect((await adapter.provider(request({ nodeId: `canonical-${node}` }))).status).toBe('resolved');
        }
        expect(f.dispatch).toHaveBeenCalledTimes(1000);
        f.host.dispatch = () => new Promise(() => {});
        const pending = Array.from({ length: 8 }, (_, node) => adapter.provider(request({ nodeId: `pending-${node}` })));
        expect((await adapter.provider(request({ nodeId: 'over-budget' }))).status).toBe('size-exceeded');
        adapter.dispose();
        expect((await Promise.all(pending)).every(result => result.status === 'stale')).toBe(true);
    });
});
