import fs from 'node:fs';

import { sealDocument } from './release-reliability-receipt.mjs';

export function resolveScenarioSchedulerGrant({
    scenario,
    runId,
    ambientEnvironment = {},
    requireSchedulerGrant = false
})
{
    if (!requireSchedulerGrant)
    {
        return sealDocument({
            schema: 'fsusblog.release-reliability-scheduler-grant.v1',
            status: 'not-required',
            scenarioId: scenario.id,
            runId,
            tierId: null,
            profileDigest: scenario.schedulerProfileDigest ?? null,
            granted: null,
            reason: 'caller explicitly disabled scheduler grant admission'
        });
    }

    const grantFile = ambientEnvironment.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE;
    const schedulerRunId = ambientEnvironment.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_RUN_ID;
    const tierId = ambientEnvironment.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID;
    if (!grantFile || !schedulerRunId || !tierId)
    {
        throw new Error('scheduler resource grant file, run ID, and tier ID are required');
    }
    if (![scenario.id, 'release-reliability-fresh'].includes(tierId))
    {
        throw new Error(
            `scheduler grant tier ${tierId} cannot admit scenario ${scenario.id}`
        );
    }

    const document = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
    const granted = document?.grants?.[tierId];
    if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1'
        || document.runId !== schedulerRunId || !granted
        || !Number.isFinite(granted.cpuUnits)
        || granted.cpuUnits < scenario.scheduler.minCpuUnits
        || !Number.isFinite(granted.memoryGiB) || granted.memoryGiB <= 0)
    {
        throw new Error(
            `actual scheduler grant for ${scenario.id} is missing or below minCpuUnits=${scenario.scheduler.minCpuUnits}`
        );
    }

    return sealDocument({
        schema: 'fsusblog.release-reliability-scheduler-grant.v1',
        status: 'granted',
        scenarioId: scenario.id,
        runId,
        schedulerRunId,
        tierId,
        profileDigest: scenario.schedulerProfileDigest,
        granted: {
            cpuUnits: granted.cpuUnits,
            memoryGiB: granted.memoryGiB
        },
        reason: null
    });
}
