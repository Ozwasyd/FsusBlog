import { admitMaterial, checkGraphMaterial, checkProjectionDigest, exactFields, hardFailureRoots,
    requireFact, sameFact, sealProjection, stableIds } from './projection-contract.mjs';

/**
 * Check externally captured execution observations. This is an analysis, not a
 * terminal acceptance receipt. Producer/attempt authentication and real domain
 * execution remain required before the canonical owner can admit acceptance.
 */
export function analyzeAtomicExecutionMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['graph', 'observations', 'ciProjection', 'localProjection', 'navigation', 'scanner'], 'conformance input');
    const byId = checkGraphMaterial(material.graph);
    sameFact(stableIds(material.observations.map((entry) => entry.producerId), 'observed producers'),
        [...byId.keys()].sort(), 'exact observed membership');
    checkProjectionDigest(material.ciProjection);
    checkProjectionDigest(material.localProjection);
    checkProjectionDigest(material.navigation);
    checkProjectionDigest(material.scanner);
    sameFact(material.ciProjection, material.localProjection, 'local/CI projection parity');
    for (const projection of [material.ciProjection, material.navigation, material.scanner])
    {
        sameFact(projection.dagDigest, material.graph.dagDigest, 'current compiled DAG');
        sameFact(projection.graphRef, material.graph.graphRef, 'current compiled graph reference');
    }
    requireFact(material.scanner.accepted === true && material.scanner.findings.length === 0, 'hidden executable authority remains');
    const states = new Map(material.observations.map((entry) => [entry.producerId, entry.terminalState]));
    const navigation = new Map(material.navigation.producers.map((entry) => [entry.producerId, entry]));
    sameFact([...navigation.keys()].sort(), [...byId.keys()].sort(), 'navigation membership');
    let independentFailures = 0;
    for (const observation of material.observations)
    {
        exactFields(observation, ['producerId', 'terminalState', 'spawnCount', 'attemptNumber', 'retries',
            'blockedBy', 'primaryFailureRefs'], 'execution observation');
        const node = byId.get(observation.producerId);
        const display = navigation.get(observation.producerId);
        sameFact(observation.terminalState, display.terminalState, 'navigation/raw terminal');
        sameFact(observation.primaryFailureRefs, display.primaryFailureRefs, 'navigation/raw primary failure');
        sameFact(observation.blockedBy, display.blockedBy, 'navigation/raw blocked closure');
        requireFact(observation.retries === 0, 'producer retry detected');
        const nonexecuted = ['blocked', 'not-selected'].includes(observation.terminalState);
        requireFact(observation.spawnCount === (nonexecuted ? 0 : 1)
            && observation.attemptNumber === (nonexecuted || node.evidenceClass === 'coordination' ? 0 : 1),
        'missing/duplicate/unexpected producer spawn');
        if (node.kind === 'finalizer')
        {
            requireFact(observation.terminalState !== 'blocked'
            && observation.terminalState !== 'not-selected', 'required finalizer omitted');
        }
        if (observation.terminalState === 'blocked')
        {
            sameFact(observation.blockedBy,
                hardFailureRoots(node.id, byId, states), 'dependency blocked closure');
        }
        else if (['producer', 'hard-prerequisite'].includes(node.kind) && !nonexecuted)
        {
            requireFact(node.dependsOn.every((id) => states.get(id) === 'success'), 'child spawned after hard prerequisite failure');
        }
        if (['failed', 'timed-out', 'internal-error'].includes(observation.terminalState)
            && node.evidenceClass === 'correctness')
        {
            independentFailures += 1;
        }
    }
    return sealProjection({ schema: 'fsusblog.atomic-execution-analysis-material.v1', graphRef: material.graph.graphRef,
        dagDigest: material.graph.dagDigest, independentFailures, producerCount: byId.size,
        localCiDrift: 0, retries: 0, unexpectedSpawns: 0, hiddenAuthorities: 0,
        terminalAcceptancePending: true });
}
