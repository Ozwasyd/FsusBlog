import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { projectFrontendPropertyModelPerf } from './property-model-perf.mjs';
import { validateFrontendChildReplayContext } from './property-replay.mjs';

const { canonicalDigest } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));
const { measurementEnvelopeOwnerEnvironment, runTaskScopedPerformanceAdmission } = await import(new URL('../performance-admission.mjs', import.meta.url));

/** Prepare the existing benchmark owner, separately from correctness-only atomic compilation. */
export function prepareFrontendBenchmarkAdmission(options)
{
    const prepared = validateFrontendChildReplayContext(options);
    const projection = projectFrontendPropertyModelPerf(options.matrix, options.packageDocument);
    const entry = projection.entries.find((candidate) => candidate.id === 'frontend-perf-regression');
    if (prepared.context.producerId !== entry.id || prepared.plan.randomStreams.length !== 0)
    {
        throw new Error('frontend benchmark requires its own non-random replay identity');
    }
    if (canonicalDigest(options.command) !== canonicalDigest(['npm', 'run', entry.commandSourceRef.script]))
    {
        throw new Error('frontend benchmark must retain the canonical package command');
    }
    if (prepared.environment[measurementEnvelopeOwnerEnvironment])
    {
        throw new Error('frontend benchmark cannot inherit another measurement owner');
    }
    if (options.attemptSequence !== 1 || !options.authorityRoot || !options.authorityManifestRoot
        || !options.evidenceFile || !options.productEvidenceFile || !options.repositoryRoot)
    {
        throw new Error('frontend benchmark requires explicit first-attempt evidence and authority roots');
    }
    if (canonicalDigest(options.resources) !== canonicalDigest(entry.resources)
        || entry.resources.exclusiveCapacity !== true)
    {
        throw new Error('frontend benchmark must preserve full-capacity exclusive resources');
    }
    return Object.freeze({ ...prepared, sourceDigest: projection.sourceDigest,
        workingDirectory: path.resolve(options.repositoryRoot, 'src/frontend'),
        executionClass: 'benchmark-window', measurement: Object.freeze({ ...entry.measurement }),
        resources: Object.freeze(structuredClone(entry.resources)) });
}

/** Delegate exactly once; physical collection, noise refusal and original errors stay with the owner. */
export async function runFrontendBenchmarkAdmission(options)
{
    const prepared = prepareFrontendBenchmarkAdmission(options);
    if (process.cwd() !== prepared.workingDirectory)
    {
        throw new Error('frontend benchmark requires the canonical frontend working directory');
    }
    return runTaskScopedPerformanceAdmission({
        windowId: prepared.measurement.windowId,
        evidenceFile: options.evidenceFile,
        productEvidenceFile: options.productEvidenceFile,
        command: [...options.command],
        env: prepared.environment,
        runId: prepared.context.schedulerRunId,
        attemptSequence: 1,
        authorityRoot: options.authorityRoot,
        authorityManifestRoot: options.authorityManifestRoot,
        priorAuthorityRoots: options.priorAuthorityRoots ?? [],
        policy: options.policy,
        onMeasurementStarted: options.onMeasurementStarted
    });
}
