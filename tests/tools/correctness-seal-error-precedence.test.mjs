import assert from 'node:assert/strict';
import test from 'node:test';

const { retainCorrectnessSealRejectionError, readCorrectnessSealRejectionError } = await import(new URL('../../tools/test-matrix/scheduler-correctness-finalizer.mjs', import.meta.url));

test('ordinary extensible Error retains its cause and exposes secondary seal diagnostics', () =>
{
    const cause = new Error('original cause');
    const primary = new Error('primary', { cause });
    const secondary = new Error('seal rejection');
    assert.equal(retainCorrectnessSealRejectionError(primary, secondary), primary);
    assert.equal(primary.cause, cause);
    assert.equal(primary.correctnessSealRejectionError, secondary);
    assert.equal(readCorrectnessSealRejectionError(primary), secondary);
});

test('nonextensible but unfrozen Error keeps its original identity and descriptors', () =>
{
    const cause = new Error('original cause');
    const primary = Object.preventExtensions(new Error('primary', { cause }));
    const secondary = new Error('seal rejection');
    const before = Object.getOwnPropertyDescriptors(primary);
    assert.equal(Object.isFrozen(primary), false);
    assert.equal(retainCorrectnessSealRejectionError(primary, secondary), primary);
    assert.deepEqual(Object.getOwnPropertyDescriptors(primary), before);
    assert.equal(primary.cause, cause);
    assert.equal(readCorrectnessSealRejectionError(primary), secondary);
});

test('sealed Error retains secondary diagnostics without changing its own properties', () =>
{
    const primary = Object.seal(new Error('primary'));
    const secondary = new Error('seal rejection');
    const before = Object.getOwnPropertyDescriptors(primary);
    assert.equal(Object.isFrozen(primary), false);
    assert.equal(retainCorrectnessSealRejectionError(primary, secondary), primary);
    assert.deepEqual(Object.getOwnPropertyDescriptors(primary), before);
    assert.equal(readCorrectnessSealRejectionError(primary), secondary);
});

test('frozen Error retains its original secondary diagnostic outside the error object', () =>
{
    const primary = Object.freeze(new Error('primary'));
    const secondary = new Error('seal rejection');
    const before = Object.getOwnPropertyDescriptors(primary);
    assert.equal(retainCorrectnessSealRejectionError(primary, secondary), primary);
    assert.deepEqual(Object.getOwnPropertyDescriptors(primary), before);
    assert.equal(readCorrectnessSealRejectionError(primary), secondary);
});

test('an existing readonly diagnostic property cannot replace the primary error', () =>
{
    const primary = new Error('primary');
    const original = new Error('existing diagnostic');
    const secondary = new Error('seal rejection');
    Object.defineProperty(primary, 'correctnessSealRejectionError', { value: original });
    const before = Object.getOwnPropertyDescriptors(primary);
    assert.equal(retainCorrectnessSealRejectionError(primary, secondary), primary);
    assert.deepEqual(Object.getOwnPropertyDescriptors(primary), before);
    assert.equal(primary.correctnessSealRejectionError, original);
    assert.equal(readCorrectnessSealRejectionError(primary), secondary);
});
