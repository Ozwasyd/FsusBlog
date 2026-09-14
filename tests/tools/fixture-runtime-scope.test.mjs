import assert from 'node:assert/strict';
import test from 'node:test';

const {FIXTURE_TEST_SESSION_HEADER, fixtureTestSessionHeaders, fixtureTestSessionSchema, resolveFixtureTestSession} = await import(new URL('../../tools/test-fixtures/runtime-scope.mjs', import.meta.url));
test('fixture runtime scope binds one backend session to the exact run and namespace', () =>
{
    const context = { namespace: 'comment-a', runIdentity: 'run-a' };
    const session = resolveFixtureTestSession(context);
    assert.match(session, /^fx-[a-f0-9]{24}$/u);
    assert.equal(fixtureTestSessionHeaders(context)[FIXTURE_TEST_SESSION_HEADER], session);
    assert.equal(fixtureTestSessionSchema(context), `fsus_e2e_${session.replaceAll('-', '_')}`);
    assert.equal(resolveFixtureTestSession({ ...context }), session);
    assert.notEqual(resolveFixtureTestSession({ ...context, namespace: 'comment-b' }), session);
    assert.notEqual(resolveFixtureTestSession({ ...context, runIdentity: 'run-b' }), session);
});

test('fixture runtime scope rejects missing execution identity', () =>
{
    assert.throws(() => resolveFixtureTestSession({ namespace: 'comment-a' }), /current run and namespace/u);
    assert.throws(() => resolveFixtureTestSession({ runIdentity: 'run-a' }), /current run and namespace/u);
});
