#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runMinimalContractBuild } from '../../docs/behavior-doc-minimal-contract-build.mjs';

export const runtimeRoleArtifactId = 'runtime-role-observation';
export const runtimeRoleProject = 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj';
export const runtimeRoleObservationRelative = '.tmp/contracts/runtime-role/runtime-role-observation.json';
export const runtimeRoleDeploymentObservationRelative = '.tmp/contracts/runtime-role/deployment-topology-observation.json';

// Convenience reader of the sole source-bound minimal producer. No independent
// v2 receipt, ambient build, latest pointer or partial extractor build is allowed.
export function produceRuntimeRoleObservation({ repositoryRoot, runId, sourceIdentity } = {})
{
    const result = runMinimalContractBuild({ repositoryRoot, runId, sourceIdentity });
    const artifact = result.receipt.artifacts[runtimeRoleArtifactId];
    const output = path.join(repositoryRoot, artifact.path);
    return {
        observation: JSON.parse(readFileSync(output, 'utf8')),
        output,
        deploymentOutput: path.join(repositoryRoot, artifact.deploymentArtifactPath),
        receiptPath: result.identityReceiptFile,
        buildIdentity: result.buildIdentities[runtimeRoleArtifactId]
    };
}
