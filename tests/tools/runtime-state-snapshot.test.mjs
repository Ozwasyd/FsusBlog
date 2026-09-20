/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    captureRuntimeStateSnapshot,
    firstSemanticMismatch,
    validateRuntimeStateSnapshot
} from '../../tools/test-runtime/state-snapshot.mjs';

import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs';

const identity = runtimeIdentity();
const authority = {
    catalogDigest: identity.catalogDigest,
    accessedDomains: ['fixture.public-content'],
    observerBindings: {
        'fixture.public-content': { domain: 'fixture.public-content', observerId: 'test-observer', observerVersion: 'v1' }
    }
};
const observer = {
    observerId: 'test-observer',
    version: 'v1',
    async observe()
    {
        return { status: 'observed', semantic: { rows: [{ id: 2 }, { id: 1 }], absent: null }, metadata: { pid: 1 }, sideEffects: noSideEffects() };
    }
};

test('snapshot binds exact observer/domain/session and content-addressed fragments', async () =>
{
    const result = await captureRuntimeStateSnapshot({
        authority,
        identity,
        boundary: 'before-runtime',
        requiredDomains: ['fixture.public-content'],
        observers: [observer]
    });
    assert.equal(result.snapshot.fragments.length, 1);
    assert.equal(Object.hasOwn(result.snapshot.fragments[0], 'semantic'), false);
    assert.equal(validateRuntimeStateSnapshot(result.snapshot, { authority, identity, fragments: result.fragments }), true);
    assert.throws(() => validateRuntimeStateSnapshot({ ...result.snapshot, semanticDigest: digest('tampered') }, { authority, identity }), /Digest mismatch/);
    assert.throws(() => validateRuntimeStateSnapshot(result.snapshot, { authority, identity: runtimeIdentity({ sessionId: 'other' }) }), /cross-session/);
});

test('snapshot rejects missing observer, observer side effects and locates null/absent mismatch', async () =>
{
    await assert.rejects(captureRuntimeStateSnapshot({ authority, identity, boundary: 'before-runtime', observers: [] }), /observer is unavailable/);
    await assert.rejects(captureRuntimeStateSnapshot({
        authority,
        identity,
        boundary: 'before-runtime',
        observers: [{ ...observer, observe: async () => ({ status: 'observed', semantic: {}, sideEffects: { ...noSideEffects(), writes: 1 } }) }]
    }), /side effect detected/);
    assert.deepEqual(firstSemanticMismatch({ value: null }, {}, '$'), { path: '$.value', left: null, right: '<absent>' });
});
