import { createHash } from 'node:crypto';

export const FIXTURE_TEST_SESSION_HEADER = 'X-Fsus-Test-Session';

const testSessionPattern = /^[a-z0-9][a-z0-9-]{0,40}$/u;

export function resolveFixtureTestSession(context)
{
    const namespace = String(context?.namespace ?? '').trim();
    const runIdentity = String(context?.runIdentity ?? '').trim();
    if (!namespace || !runIdentity)
    {
        throw new Error('fixture test session requires current run and namespace');
    }
    const digest = createHash('sha256')
        .update(['fsusblog-fixture-test-session-v1', namespace, runIdentity].join('\u0000'), 'utf8')
        .digest('hex');
    const session = `fx-${digest.slice(0, 24)}`;
    if (!testSessionPattern.test(session))
    {
        throw new Error('fixture test session is outside the backend isolation contract');
    }
    return session;
}

export function fixtureTestSessionHeaders(context)
{
    return Object.freeze({
        [FIXTURE_TEST_SESSION_HEADER]: resolveFixtureTestSession(context)
    });
}

export function fixtureTestSessionSchema(context)
{
    const session = resolveFixtureTestSession(context);
    return `fsus_e2e_${session.replaceAll('-', '_')}`;
}
