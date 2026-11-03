import { URL } from 'node:url';

const { canonicalDigest } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));

/**
 * Source-stage split of the existing three commands. Package scripts, including
 * the existing property random-stream owner, remain verbatim until their owner
 * supplies child-bound replay declarations. Perf retains the measurement helper
 * and full-capacity isolation; this projection grants no attempt authority.
 */
export function projectFrontendPropertyModelPerf(matrix, packageDocument)
{
    const parents = matrix.tiers.filter((tier) => tier.id === 'frontend-property-model-perf');
    if (parents.length !== 1)
    {
        throw new Error('frontend-property-model-perf requires exactly one matrix parent');
    }
    const parentDeclaration = structuredClone(parents[0]);
    const commands = [
        ['frontend-property', 'test:property'],
        ['frontend-state-machines', 'check:frontend-state-machines'],
        ['frontend-perf-regression', 'check:frontend-perf-regression']
    ];
    const entries = commands.map(([id, script]) =>
    {
        const scriptCommand = packageDocument.scripts?.[script];
        if (typeof scriptCommand !== 'string' || !scriptCommand.trim())
        {
            throw new Error(`missing canonical frontend script: ${script}`);
        }
        const measurement = id === 'frontend-perf-regression';
        return {
            id,
            logicalParentId: parentDeclaration.id,
            command: `tools/test/lanes/${id}.sh`,
            commandSourceRef: { path: 'src/frontend/package.json', script },
            scriptCommand,
            dependsOn: [],
            settledDependsOn: [],
            resources: {
                cpuWeight: parentDeclaration.cpuWeight,
                memoryWeight: parentDeclaration.memoryWeight,
                minCpuUnits: parentDeclaration.minCpuUnits,
                exclusiveResources: measurement ? [...parentDeclaration.exclusiveResources] : [],
                exclusiveCapacity: measurement
            },
            measurement: measurement ? {
                windowId: id,
                evidenceFile: '.tmp/frontend/frontend-perf-regression.measurement-noise.json',
                commandOwner: 'tools/test/performance-admission.mjs'
            } : null,
            missingContracts: ['atomic-disposition', 'attempt-and-replay-binding']
        };
    });
    return {
        qualificationEligible: false,
        sourceDigest: canonicalDigest({ parentDeclaration, entries }),
        parentDeclaration,
        entries,
        settledProjection: {
            id: 'frontend-property-model-perf-summary',
            dependsOn: [],
            settledDependsOn: entries.map((entry) => entry.id)
        }
    };
}
