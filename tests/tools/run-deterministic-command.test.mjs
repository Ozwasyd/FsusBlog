import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    preparationFailureProperty,
    preparationFailureText,
    retainPreparationCleanupFailure
} from '../../tools/test/run-deterministic-command.mjs';

// SOURCE COMPONENT_SIMULATION: actual production diagnostic helpers, not directory/tool/kernel execution.
// The SOURCE wiring checks below connect these helpers to the original cleanup owners without running them.
for (const [label, reason] of [['frozen', Object.freeze(new Error('first'))], ['zero', 0], ['false', false],
    ['empty', ''], ['null', null], ['undefined', undefined], ['string', 'specific first']])
{
    test(`production cleanup diagnostics preserve ${label} first reason and secondary recovery`, () =>
    {
        const owner = {};
        const recoveryObligation = { ownedRoot: '/component-fixture/retained', reason: 'not verified terminal' };
        const secondary = Object.assign(new Error('cleanup'), { recoveryObligation });
        const record = retainPreparationCleanupFailure(owner, reason, secondary);
        assert.equal(record.failed, true);
        assert.equal(record.reason, reason);
        assert.equal(record.cleanupFailed, true);
        assert.equal(record.cleanupReason, secondary);
        assert.equal(record.recoveryObligation, recoveryObligation);
        assert.equal(owner.cleanupFailures[0], record);
    });
}

test('production cleanup helper keeps benign mutable Error compatibility and all secondaries', () =>
{
    const owner = {};
    const first = new Error('first');
    const recoveryObligation = { ownedRoot: '/component-fixture/retained' };
    const cleanup = Object.assign(new Error('first cleanup'), { recoveryObligation });
    const later = new Error('later cleanup');
    retainPreparationCleanupFailure(owner, first, cleanup);
    retainPreparationCleanupFailure(owner, first, later);
    assert.equal(first.cleanupError, cleanup);
    assert.equal(first.recoveryObligation, recoveryObligation);
    assert.equal(owner.cleanupFailures[1].cleanupReason, later);
    assert.equal(owner.cleanupFailures[1].reason, first);
});

test('hostile metadata getters and compatibility setters cannot replace the retained first reason', () =>
{
    const owner = {};
    const metadataReason = Object.freeze(new Error('metadata getter'));
    const secondary = Object.defineProperty({}, 'recoveryObligation', { get() { throw metadataReason; } });
    const first = Object.defineProperty({}, 'cleanupError', { get() { throw metadataReason; } });
    const record = retainPreparationCleanupFailure(owner, first, secondary);
    assert.equal(record.reason, first);
    assert.equal(record.cleanupReason, secondary);
    assert.equal(record.recoveryObligation, null);
    assert.equal(owner.metadataFailures.length, 2);
    assert.ok(owner.metadataFailures.every((failure) => failure.reason === metadataReason));
});

test('failure text and physical metadata faults remain diagnostic rather than replacement errors', () =>
{
    const owner = {};
    const metadataReason = new Error('unreadable');
    const first = Object.defineProperties(Object.create(null), {
        message: { get() { throw metadataReason; } },
        physicalExecution: { get() { throw metadataReason; } }
    });
    assert.equal(preparationFailureProperty(owner, first, 'physicalExecution'), null);
    assert.equal(preparationFailureText(owner, first), 'unprintable execution failure');
    assert.equal(owner.metadataFailures[0].reason, metadataReason);
    assert.equal(preparationFailureText(owner, 0), '0');
    assert.equal(preparationFailureText(owner, undefined), 'undefined');
});

test('SOURCE original factory and CLI cleanup wiring retain diagnostics without truthy first-cause tests', () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url), 'utf8');
    assert.match(source, /retainPreparationCleanupFailure\(directoryEnvelope, error, cleanupError\);/u);
    assert.match(source, /retainPreparationCleanupFailure\(fragments\.directoryEnvelope, error, cleanupError\);/u);
    assert.match(source, /if \(executionFailed\)[\s\S]*?throw executionError;/u);
    assert.match(source, /if \(failureState\.failed\)[\s\S]*?retainPreparationCleanupFailure/u);
    assert.match(source, /retainPreparationCleanupFailure\(directoryEnvelope, postflightError, receiptError\);/u);
    assert.doesNotMatch(source, /if \(!?firstFailure\)|error\.cleanupError\s*=|firstFailure\.cleanupError/u);
    // Source wiring does not execute any factory, finalize an owned directory or prove an actual terminal.
});
