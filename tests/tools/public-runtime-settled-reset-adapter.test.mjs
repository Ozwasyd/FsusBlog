import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { publicRuntimeCompilerFixture } from './support/public-runtime-compiler-fixture.mjs';

const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));

const { adaptPublicRuntimeSettledReset, publicRuntimeSettledResetContract } = await import(new URL('../../tools/test/public-runtime-producers/settled-reset-adapter.mjs', import.meta.url));

test('settled reset reports the actual missing canonical postcondition capability', () =>
{
    const contract = publicRuntimeSettledResetContract();
    assert.equal(contract.producerId, 'reset-pre-notification-stream');
    assert.equal(contract.supported, false);
    assert.equal(contract.verifierExport, 'consumeResetPostconditionReceipt');
});

test('ordinary failed reset terminal remains failed without asking verifier to manufacture success', () =>
{
    const terminal = { terminalState: 'failed', reasonCode: 'reset-command-failed', primaryFailureRefs: ['reset-pre-notification-stream'] };
    assert.deepEqual(adaptPublicRuntimeSettledReset({ terminal }), terminal);
});

test('actual exit-zero reset attempt remains unverified until canonical postcondition exists', async () =>
{
    const fixture = publicRuntimeCompilerFixture('load');
    try
    {
        const contract = publicRuntimeSettledResetContract();
        const supplied = fixture.producerContexts[contract.producerId];
        const source = fixture.authorities.commandSources.find((entry) => entry.id === `${contract.producerId}-command`);
        const replay = JSON.parse(fixture.authorities.replayPlans.find((entry) => entry.id === `${contract.producerId}-replay`).bytes);
        const attemptResult = await runProducerAttempts({
            ...fixture.context, ...supplied,
            producerId: contract.producerId, retryPolicyId: 'correctness-first-attempt',
            command: source.command, expectedTestIds: replay.testEnumerationOrder
        });
        assert.equal(attemptResult.aggregate.cleanFirstAttempt, true);
        assert.throws(() => adaptPublicRuntimeSettledReset({
            terminal: { terminalState: 'success' }, attemptResult, verifyAuthority: supplied.verifyAuthority,
            producerStep: { id: contract.producerId },
            reset: { producer: contract.producerId, assertionId: contract.assertionId, receiptSchema: contract.receiptSchema },
            runIdentity: null, root: fixture.root
        }), /no pre-notification-stream postcondition capability/u);
    }
    finally
    {
        fixture.cleanup();
    }
});
