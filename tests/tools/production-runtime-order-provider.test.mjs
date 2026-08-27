/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionBoundaryCollector } from '../../tools/test-runtime/production-boundary-collector.mjs';
import { RuntimeExecutionSession } from '../../tools/test-runtime/runtime-execution-session.mjs';

import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs';

function immutable(identity)
{
    const inputs = structuredClone(identity);
    delete inputs.runId;
    delete inputs.attemptId;
    delete inputs.sessionId;
    return { ...inputs, domainSources: {} };
}

function adapter(domain)
{
    return {
        async clone({ identity, mutableRoot })
        {
            const root = path.join(mutableRoot, 'state');
            fs.mkdirSync(root);
            return {
                owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
                mutableRoot: root,
                namespace: `${identity.sessionId}-state`
            };
        },
        async reset()
        {
            return { status: 'reset', postconditionDigest: digest('reset') };
        },
        async ready()
        {
            return { status: 'ready', observationDigest: digest('ready') };
        },
        async cleanup()
        {
            return { status: 'clean' };
        }
    };
}

test('production boundary collector uses canonical observers at every live mutating boundary', async (t) =>
{
    const temporaryRoot = path.resolve('.tmp/runtime-order-test-bindings');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'production-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = runtimeIdentity({ sessionId: 'production-session' });
    const domain = 'fixture.public-content';
    const session = await RuntimeExecutionSession.create({
        sessionRoot: root,
        runId: identity.runId,
        attemptId: identity.attemptId,
        sessionId: identity.sessionId,
        immutableInputs: immutable(identity),
        domains: [domain],
        adapters: { [domain]: adapter(domain) }
    });
    const receiptFile = path.join(session.ownedRoot, 'evidence', 'session.json');
    fs.writeFileSync(receiptFile, `${JSON.stringify(session.receipt())}\n`, { flag: 'wx' });
    const bindingFile = path.join(root, 'binding.mjs');
    fs.writeFileSync(bindingFile, `
export async function createProductionSnapshotContext({ boundary, stepId }) {
  return { semantic: { boundary, stepId } }
}
export async function verifyProductionResetPostconditions() { return [] }
export async function verifyProductionCoordination() { return { status: 'verified', receiptDigest: '${digest('coordination')}' } }
`);
    const authority = {
        catalogDigest: identity.catalogDigest,
        accessedDomains: [domain],
        observerBindings: { [domain]: { observerId: 'live-state', observerVersion: 'v1' } },
        steps: {
            mutate: {
                stepId: 'mutate', reads: [domain], writes: [domain], creates: [], deletes: [], invalidates: [],
                exclusiveStateDomains: [], resetBefore: [], resetAfter: []
            }
        }
    };
    const observers = [{
        observerId: 'live-state', version: 'v1',
        async observe({ context })
        {
            return { status: 'observed', semantic: context.semantic, sideEffects: noSideEffects() };
        }
    }];
    const collector = await createProductionBoundaryCollector({
        bindingModule: bindingFile,
        sessionReceiptFile: receiptFile,
        authority,
        observers
    });
    await collector.capture('before-runtime');
    collector.beginResetBarriers('mutate');
    const before = await collector.capture('before-mutating-step', 'mutate');
    const after = await collector.capture('after-mutating-step', 'mutate');
    await collector.completeResetBarriers({ producerStepId: 'mutate', processResult: { code: 0 }, beforeCapture: before, afterCapture: after });
    await collector.capture('after-runtime');
    const evidence = await collector.finish();
    assert.deepEqual(evidence.captures.map(({ snapshot }) => [snapshot.boundary, snapshot.stepId]), [
        ['before-runtime', null],
        ['before-mutating-step', 'mutate'],
        ['after-mutating-step', 'mutate'],
        ['after-runtime', null]
    ]);
    assert.equal(evidence.resetReceipts.length, 0);
    await session.cleanup();
});

test('canonical runtime-order command uses shipped binding and fails closed without current-run identity', async () =>
{
    const script = path.resolve('tools/test/run-runtime-order-equivalence.mjs');
    const output = path.join(os.tmpdir(), `fsusblog-runtime-order-${process.pid}.json`);
    fs.rmSync(output, { force: true });
    const error = await import('node:child_process').then(({ spawnSync }) => spawnSync(
        process.execPath,
        [script, '--all-required-schedules', '--output', output],
        {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
                'FSUSBLOG_RUNTIME_ORDER_PROVIDER',
                'FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE'
            ].includes(key)))
        }
    ));
    assert.notEqual(error.status, 0);
    assert.match(error.stderr, /FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE/);
    assert.equal(fs.existsSync(output), false);
});
