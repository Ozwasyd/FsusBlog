/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRuntimeExecutionSession } from '../../tools/test-runtime/runtime-execution-session.mjs';

import { digest, runtimeIdentity } from './support/runtime-state-fixture.mjs';

function adapter(domain, { failReset = false } = {})
{
    return {
        async clone({ identity, mutableRoot })
        {
            const owned = path.join(mutableRoot, domain.replaceAll('.', '-'));
            fs.mkdirSync(owned);
            return {
                owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
                mutableRoot: owned,
                namespace: `${identity.sessionId}-${domain.replaceAll('.', '-')}`,
                contentDigest: digest(domain)
            };
        },
        async reset()
        {
            return failReset ? { status: 'failed' } : { status: 'reset', postconditionDigest: digest(`reset-${domain}`) };
        },
        async ready()
        {
            return { status: 'ready', observationDigest: digest(`ready-${domain}`) };
        },
        async cleanup()
        {
            return { status: 'clean' };
        }
    };
}

function immutable(identity)
{
    const inputs = structuredClone(identity);
    delete inputs.sessionId;
    delete inputs.runId;
    delete inputs.attemptId;
    return { ...inputs, domainSources: {} };
}

test('RuntimeExecutionSession creates isolated mutable roots and append-only receipts', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-session-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const base = runtimeIdentity();
    const domains = ['postgres.article', 'redis.cache.public'];
    const adapters = Object.fromEntries(domains.map((domain) => [domain, adapter(domain)]));
    const first = await createRuntimeExecutionSession({
        sessionRoot: root,
        runId: base.runId,
        attemptId: base.attemptId,
        sessionId: 'session-a',
        immutableInputs: immutable(base),
        domains,
        adapters
    });
    const second = await createRuntimeExecutionSession({
        sessionRoot: root,
        runId: base.runId,
        attemptId: base.attemptId,
        sessionId: 'session-b',
        immutableInputs: immutable(base),
        domains,
        adapters
    });
    assert.notEqual(first.ownedRoot, second.ownedRoot);
    assert.notEqual(first.handles.get(domains[0]).namespace, second.handles.get(domains[0]).namespace);
    await first.reset();
    assert.throws(() => first.assertCurrent(runtimeIdentity({ sessionId: 'session-b' })), /stale or cross-attempt/);
    await first.cleanup();
    await second.cleanup();
    const events = fs.readFileSync(path.join(first.ownedRoot, 'evidence/lifecycle.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(events.some((event) => event.event === 'postflight-complete'), true);
    assert.equal(events.at(-1).event, 'cleanup-complete');
});

test('RuntimeExecutionSession fails closed on shared handles and reset without postcondition', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-session-negative-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const base = runtimeIdentity();
    const shared = adapter('postgres.article');
    shared.clone = async ({ identity, mutableRoot }) => ({
        owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: 'other-session', domain: 'postgres.article' },
        mutableRoot: path.join(mutableRoot, 'db')
    });
    await assert.rejects(createRuntimeExecutionSession({
        sessionRoot: root,
        runId: base.runId,
        attemptId: base.attemptId,
        sessionId: 'session-shared',
        immutableInputs: immutable(base),
        domains: ['postgres.article'],
        adapters: { 'postgres.article': shared }
    }), /shared, stale or cross-session/);
    const session = await createRuntimeExecutionSession({
        sessionRoot: root,
        runId: base.runId,
        attemptId: base.attemptId,
        sessionId: 'session-reset-fail',
        immutableInputs: immutable(base),
        domains: ['redis.cache.public'],
        adapters: { 'redis.cache.public': adapter('redis.cache.public', { failReset: true }) }
    });
    await assert.rejects(session.reset(), /did not prove its postcondition/);
});

test('cancelled creation cleans cloned domains without reusing the cancelled signal', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-session-cancel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const base = runtimeIdentity();
    const controller = new AbortController();
    const cleanupSignals = [];
    const first = adapter('postgres.article');
    first.clone = async (options) =>
    {
        const handle = await adapter('postgres.article').clone(options);
        controller.abort(new Error('creation deadline exceeded'));
        return handle;
    };
    first.cleanup = async ({ signal, cancellationReason }) =>
    {
        cleanupSignals.push({ signal, cancellationReason });
        return { status: 'clean' };
    };
    await assert.rejects(createRuntimeExecutionSession({
        sessionRoot: root,
        runId: base.runId,
        attemptId: base.attemptId,
        sessionId: 'session-cancel',
        immutableInputs: immutable(base),
        domains: ['postgres.article', 'redis.cache.public'],
        adapters: {
            'postgres.article': first,
            'redis.cache.public': adapter('redis.cache.public')
        },
        signal: controller.signal
    }), /creation deadline exceeded/);
    assert.equal(cleanupSignals.length, 1);
    assert.equal(cleanupSignals[0].signal, undefined);
    assert.match(String(cleanupSignals[0].cancellationReason), /creation deadline exceeded/);
});
