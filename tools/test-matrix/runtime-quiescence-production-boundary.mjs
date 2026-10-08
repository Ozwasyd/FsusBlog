import {observeProductionFreshExclusiveLease} from './production-fresh-exclusive-lease.mjs';
import {loadQuiescenceAuthorities, quiescenceSourceGates} from './quiescence-contract.mjs';

// Read real current owners. This diagnostic explicitly does not adapt repository
// exclusivity, release-drain counts or caller-stamped run IDs into quiescence authority.
export function inspectProductionQuiescenceBarrierBoundary({root, runId})
{
    const sources = quiescenceSourceGates(root);
    const authority = loadQuiescenceAuthorities(root);
    const repositoryLease = observeProductionFreshExclusiveLease({root, runId});
    return {status: 'unavailable', runtimeQualified: false,
        repositoryLease, inventoryDigest: sources.inventory.contentDigest, sourceErrors: sources.errors,
        missingCapabilities: [
            {owner: 'tools/test-matrix/production-fresh-exclusive-lease.mjs',
                required: 'runtime/catalog-bound quiescence generation; acquire/validate/renew/release and same-attempt abort/postObserve',
                available: 'repository/source candidate exclusivity only'},
            {owner: 'src/backend/Infrastructure/Operations/ActiveReleaseFence.cs',
                required: 'current-run namespace quiescence scope and generation',
                available: 'release execution ticket and IsCurrentAsync; no quiescence namespace lease'},
            ...authority.registry.quiescence.contracts.map((contract) => ({owner: contract.owner,
                domainId: contract.domainId, required: contract.freezeAdmissionHook,
                available: 'declared hook contract; live admission fence proof unavailable'})),
            {owner: 'src/backend/Infrastructure/Operations/OutboxQuiescenceSourceReader.cs',
                required: 'current-namespace immutable/committed watermarks, worker incarnation and live claims',
                available: 'actual last-cycle diagnostics; source captures stay unqualified'},
            {owner: 'src/backend/Infrastructure/Operations/PublicProjectionQuiescenceSourceReader.cs',
                required: 'protected namespace, watermark/incarnation, active manifest, ACK and live flush commit coverage',
                available: 'actual projection activity snapshots; missing facts stay unavailable'}
        ]};
}
