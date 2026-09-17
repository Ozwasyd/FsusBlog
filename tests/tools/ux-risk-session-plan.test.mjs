import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUxRiskSessionPlan } from '../../tools/ux/ux-risk-session-plan.mjs';

test('persistent and direct CLI UX session plans follow the scheduler lane prefix', () =>
{
    const env = {
        FSUSBLOG_TEST_SESSION_PREFIX: 'Lane UX Risk 41F0F4C0'
    };
    const plan = buildUxRiskSessionPlan(3, { env });

    assert.deepEqual(plan.sessionIds, [
        'lane-ux-risk-41f0f4c0-0',
        'lane-ux-risk-41f0f4c0-1',
        'lane-ux-risk-41f0f4c0-2'
    ]);
    assert.deepEqual(Object.keys(plan), ['sessionIds']);
});

test('persistent UX session plan rejects invalid capacity instead of inventing a slot', () =>
{
    for (const count of [0, -1, 1.5, Number.NaN])
    {
        assert.throws(
            () => buildUxRiskSessionPlan(count),
            /session count must be a positive integer/u
        );
    }
});
