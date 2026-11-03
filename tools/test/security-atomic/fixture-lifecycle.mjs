import { URL } from 'node:url';

import { consumeOwnerReference, validateContext } from './contract.mjs';

const { plan, prepare, verify, cleanup } = await import(new URL('../../test-fixtures/orchestrator.mjs', import.meta.url));
const { createPortsForProducerIds } = await import(new URL('../../test-fixtures/producers/catalog-ports.mjs', import.meta.url));
const { readFixtureCatalogs } = await import(new URL('../../testing/fixture-catalog.mjs', import.meta.url));

/**
 * Security's owned lifecycle binding. Canonical producers and receipts perform
 * all mutation/postcondition work; no local receipt or reset proof is minted.
 */
export function createSecurityFixtureLifecycle({ context, profileIdentity, executionIdentity,
    runtimeReference, ownerVerifiers, catalogs = readFixtureCatalogs(), ports,
    artifactOutlet } = {})
{
    const binding = validateContext(context);
    if (profileIdentity?.profileId !== binding.profileId
        || executionIdentity?.runId !== binding.runId
        || executionIdentity.namespace !== binding.namespace
        || executionIdentity.sourceIdentity?.commit !== binding.sourceRevision
        || !executionIdentity.sourceIdentity?.worktreeFingerprint)
    {
        throw new Error('fixture lifecycle requires exact current-run/profile/source binding');
    }
    const planned = plan(profileIdentity, executionIdentity, { catalogs });
    if (planned.producers.length === 0)
    {
        throw new Error('security fixture lifecycle requires a non-empty canonical profile');
    }
    const producerPorts = ports ?? createPortsForProducerIds(planned.producers, catalogs);
    let preparation;
    let finalization;
    let state;
    let receipt;
    let primaryFailure;

    return Object.freeze({
        plan: planned,
        async prepareFixture({ signal } = {})
        {
            if (finalization)
            {
                throw new Error('fixture preparation cannot start after finalization');
            }
            preparation ??= (async () =>
            {
                try
                {
                    await consumeOwnerReference('runtime', runtimeReference, binding, ownerVerifiers);
                    state = await prepare(planned, producerPorts, signal, { catalogs, artifactOutlet });
                    receipt = await verify(state, producerPorts, { catalogs, signal, artifactOutlet });
                    return receipt;
                }
                catch (error)
                {
                    primaryFailure = error;
                    // prepare owns rollback of partial mutations; retain its exact
                    // state. A verify rejection leaves prepared state for cleanup.
                    state = error.receipt?.plan ? error.receipt : state;
                    throw error;
                }
            })();
            return preparation;
        },
        async admitReset(reference)
        {
            // The reset owner must verify actual before/after observations and
            // current candidate binding. Fixture cleanup is not such admission.
            return consumeOwnerReference('reset', reference, binding, ownerVerifiers);
        },
        async finalizeFixture({ cleanupSignal } = {})
        {
            finalization ??= (async () =>
            {
                if (preparation)
                {
                    await preparation.catch(() => undefined);
                }
                // Use a separately owned cleanup budget/signal, never the aborted
                // producer signal. The canonical finalizer still reports failure.
                const cleanupRequired = Boolean(state && (state.mutations?.length
                    || Object.keys(state.producerOutputs ?? {}).length || state.producerReceipts?.length));
                let cleanedState = state ?? null;
                try
                {
                    if (cleanupRequired)
                    {
                        cleanedState = await cleanup(state, producerPorts, cleanupSignal, { catalogs, artifactOutlet });
                    }
                }
                catch (error)
                {
                    const failure = new Error('security fixture finalization failed', { cause: error });
                    failure.name = 'SecurityFixtureFinalizationError';
                    failure.primaryFailure = primaryFailure ?? null;
                    failure.cleanupFailure = error;
                    throw failure;
                }
                return Object.freeze({ fixtureReceipt: receipt ?? null, cleanedState,
                    cleanupRequired, primaryFailure: primaryFailure ?? null, qualificationEligible: false });
            })();
            return finalization;
        }
    });
}
