import assert from 'node:assert/strict';
import test from 'node:test';

const {
    executionFailureDiagnostic,
    formatExecutionFailure,
    restoreExecutionFailureDiagnostic,
    selectExecutionFailure
} = await import(new URL('../../tools/test/execution-failure-diagnostic.mjs', import.meta.url));

test('successful execution and postflight do not acquire a failure', () =>
{
    assert.equal(selectExecutionFailure({ executionError: null, finalizationError: null, physicalExecution: {} }), null);
});

test('execution-only failure preserves the original physical error', () =>
{
    const evidence = { cleanup: { status: 'verified' } };
    const error = Object.assign(new Error('supervisor identity is unverifiable: access denied'), { code: 'EACCES', physicalExecution: evidence });
    assert.equal(selectExecutionFailure({ executionError: error, finalizationError: null, physicalExecution: evidence }), error);
    assert.equal(executionFailureDiagnostic(error).primary.code, 'EACCES');
    assert.equal(executionFailureDiagnostic(error).secondary, null);
    assert.equal(error.physicalExecution, evidence);
});

test('finalization-only refusal remains a failure with the original evidence', () =>
{
    const error = new Error('correctness network observation is unavailable');
    const evidence = { exitCode: 0, cleanup: { childTerminal: { exitCode: 0 } } };
    assert.equal(selectExecutionFailure({ executionError: null, finalizationError: error, physicalExecution: evidence }), error);
    assert.equal(error.physicalExecution, evidence);
    assert.equal(executionFailureDiagnostic(error).primary.exitCode, null);
    assert.equal(executionFailureDiagnostic(error).secondary, null);
});

test('simultaneous failure preserves the primary and the secondary refusal', () =>
{
    const first = Object.assign(new Error('physical execution supervisor identity is unverifiable: EACCES'), { code: 'EACCES' });
    const secondary = new Error('correctness network observation is unavailable');
    const selected = selectExecutionFailure({ executionError: first, finalizationError: secondary, physicalExecution: null });
    assert.equal(selected, first);
    const value = executionFailureDiagnostic(selected);
    assert.match(value.primary.message, /supervisor identity/u);
    assert.equal(value.secondary.message, secondary.message);
    assert.match(formatExecutionFailure(selected), /supervisor identity/u);
    assert.match(formatExecutionFailure(selected), /network observation/u);
    assert.equal(first.cause, undefined);
});

test('cancellation stays primary without erasing the finalization refusal', () =>
{
    const first = Object.assign(new Error('received SIGTERM'), { name: 'AbortError', signal: 'SIGTERM' });
    const selected = selectExecutionFailure({ executionError: first, finalizationError: new Error('missing observation'), physicalExecution: null });
    assert.equal(selected.name, 'AbortError');
    assert.equal(selected.signal, 'SIGTERM');
    assert.equal(executionFailureDiagnostic(selected).secondary.message, 'missing observation');
});

test('successful supervisor cleanup never replaces a failed direct-child exit', () =>
{
    const first = Object.assign(new Error('command failed (exit 7): executable opaque-value'), {
        exitCode: 7,
        physicalExecution: { exitCode: 7, cleanup: { childTerminal: { exitCode: 0 } } }
    });
    selectExecutionFailure({ executionError: first, finalizationError: new Error('missing network trace'), physicalExecution: first.physicalExecution });
    assert.equal(executionFailureDiagnostic(first).primary.exitCode, 7);
    assert.equal(executionFailureDiagnostic(first).primary.message, 'command failed (exit 7)');
    assert.equal(formatExecutionFailure(first).includes('opaque-value'), false);
});

test('incomplete containment is never inferred successful from cleanup exit zero', () =>
{
    const first = Object.assign(new Error('physical execution cleanup is unverifiable'), {
        physicalExecution: { cleanup: { status: 'unverifiable', childTerminal: { exitCode: 0 } } }
    });
    selectExecutionFailure({ executionError: first, finalizationError: new Error('missing observation'), physicalExecution: first.physicalExecution });
    assert.equal(executionFailureDiagnostic(first).primary.exitCode, null);
    assert.equal(first.physicalExecution.cleanup.status, 'unverifiable');
});

test('signal failures preserve the signal without publishing opaque command arguments', () =>
{
    const first = Object.assign(new Error('command failed (signal SIGTERM): executable opaque-private-value'), { signal: 'SIGTERM' });
    selectExecutionFailure({ executionError: first, finalizationError: new Error('missing observation') });
    const value = executionFailureDiagnostic(first);
    assert.equal(value.primary.message, 'command failed (signal SIGTERM)');
    assert.equal(value.primary.signal, 'SIGTERM');
    assert.equal(value.primary.exitCode, null);
    assert.equal(formatExecutionFailure(first).includes('opaque-private-value'), false);
});

test('diagnostics bound UTF-8, nested causes and cycles without invoking accessors', () =>
{
    const error = new Error('界'.repeat(1024));
    let current = error;
    for (let index = 0; index < 6; index += 1)
    {
        current.cause = new Error(`cause ${index}`);
        current = current.cause;
    }
    selectExecutionFailure({ executionError: error, finalizationError: null });
    const value = executionFailureDiagnostic(error);
    assert.ok(Buffer.byteLength(value.primary.message) <= 1024);
    assert.equal(value.primary.truncated, true);
    assert.equal(value.causes.length, 4);
    assert.equal(value.causesTruncated, true);
    const cycle = new Error('cycle');
    cycle.cause = cycle;
    selectExecutionFailure({ executionError: cycle });
    assert.equal(executionFailureDiagnostic(cycle).causes.length, 0);
    let reads = 0;
    const accessor = new Error('safe');
    Object.defineProperty(accessor, 'cause', { get() { reads += 1; throw new Error('do not inspect'); } });
    selectExecutionFailure({ executionError: accessor });
    assert.equal(reads, 0);
});

test('sensitive messages use a digest and never publish values, stacks or extra objects', () =>
{
    const error = Object.assign(new Error('PASSWORD=private-value'), { environment: { PASSWORD: 'private-value' } });
    selectExecutionFailure({ executionError: error, finalizationError: new Error('https://user:private-value@example.invalid') });
    const value = executionFailureDiagnostic(error);
    assert.equal(value.primary.redacted, true);
    assert.equal(value.secondary.redacted, true);
    assert.match(value.primary.messageDigest, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(value).includes('private-value'), false);
    assert.equal(Object.hasOwn(value.primary, 'stack'), false);
    assert.equal(Object.hasOwn(value.primary, 'environment'), false);
    const bearer = new Error('Bearer private-value');
    selectExecutionFailure({ executionError: bearer });
    assert.equal(executionFailureDiagnostic(bearer).primary.redacted, true);
    assert.equal(formatExecutionFailure(bearer).includes('private-value'), false);
});

test('sealed projection diagnostic roundtrip rejects widened or oversized records', () =>
{
    const first = Object.assign(new Error('primary'), { exitCode: 9 });
    selectExecutionFailure({ executionError: first, finalizationError: new Error('secondary') });
    const value = JSON.parse(JSON.stringify(executionFailureDiagnostic(first)));
    const restored = new Error('primary');
    restoreExecutionFailureDiagnostic(restored, value);
    assert.deepEqual(executionFailureDiagnostic(restored), value);
    assert.throws(() => restoreExecutionFailureDiagnostic(restored, { ...value, pass: true }), /invalid/u);
    assert.throws(() => restoreExecutionFailureDiagnostic(restored, { ...value, primary: { ...value.primary, message: 'a'.repeat(1025) } }), /invalid/u);
    assert.throws(() => restoreExecutionFailureDiagnostic(restored, { ...value, primary: { ...value.primary, message: 'TOKEN=private-value' } }), /invalid/u);
});

test('reselection preserves sealed causes and the earlier secondary without duplication', () =>
{
    const first = new Error('primary', { cause: new Error('original cause') });
    const secondary = new Error('original postflight refusal');
    selectExecutionFailure({ executionError: first, finalizationError: secondary });
    const sealed = JSON.parse(JSON.stringify(executionFailureDiagnostic(first)));
    const restored = new Error('primary');
    restoreExecutionFailureDiagnostic(restored, sealed);
    selectExecutionFailure({ executionError: restored, finalizationError: secondary });
    assert.deepEqual(executionFailureDiagnostic(restored), sealed);
    selectExecutionFailure({ executionError: restored, finalizationError: new Error('current postflight refusal') });
    const value = executionFailureDiagnostic(restored);
    assert.deepEqual(value.primary, sealed.primary);
    assert.deepEqual(value.secondary, sealed.secondary);
    assert.deepEqual(value.causes[0], sealed.causes[0]);
    assert.equal(value.causes[1].message, 'current postflight refusal');
    assert.equal(value.causesTruncated, false);
});
