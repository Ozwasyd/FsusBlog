import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';
import {
    generateReleaseReliabilitySchedulerMatrix,
    loadReleaseReliabilityCatalog,
    releaseReliabilitySchedulerProjection,
    validateReleaseReliabilitySchedulerCatalog,
    validateReleaseReliabilitySchedulerMatrix
} from '../../tools/test-matrix/release-reliability-scheduler-projection.mjs';
import {
    resolveScenarioSchedulerGrant
} from '../../tools/test/release-reliability-scheduler-grant.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schedulerAuthorityAvailable = Object.hasOwn(
    loadReleaseReliabilityCatalog({ root }),
    'schedulerTimeoutPolicies'
);
const schedulerAuthorityTest = {
    skip: schedulerAuthorityAvailable ? false : 'scheduler catalog authority is activated by the dependent projection slice'
};

function inputs()
{
    const catalog = loadReleaseReliabilityCatalog({ root });
    const matrixText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    return { catalog, matrixText, matrix: parseMatrix(matrixText) };
}

test('catalog profiles are the unique exact matrix scheduler projection', schedulerAuthorityTest, () =>
{
    const { catalog, matrix, matrixText } = inputs();
    assert.deepEqual(validateReleaseReliabilitySchedulerCatalog(catalog), []);
    assert.deepEqual(validateReleaseReliabilitySchedulerMatrix(matrix, catalog), []);
    assert.equal(generateReleaseReliabilitySchedulerMatrix(matrixText, catalog), matrixText);
});

test('projection rejects every weakened or handwritten scheduler declaration', schedulerAuthorityTest, () =>
{
    const mutations = [
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-soak-min').resourceClass = 'io'; },
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-soak-min').exclusiveResources = []; },
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-load-burst').cpuWeight = 1; },
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-memory-leak-budget').memoryWeight = 1; },
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-data-scale-m').minCpuUnits = 1; },
        (matrix) => { matrix.tiers.find((tier) => tier.id === 'release-reliability-fresh').parallelizable = true; },
        (matrix) =>
        {
            matrix.tiers.push({
                ...structuredClone(matrix.tiers.find((tier) => tier.id === 'release-soak-min')),
                id: 'release-handwritten-diagnostic',
                command: 'node tools/test/run-release-reliability-scenarios.mjs --scenario release-not-cataloged'
            });
        }
    ];
    for (const mutate of mutations)
    {
        const { catalog, matrix } = inputs();
        mutate(matrix);
        assert.notDeepEqual(validateReleaseReliabilitySchedulerMatrix(matrix, catalog), []);
    }
});

test('catalog additions and profile weakening fail closed', schedulerAuthorityTest, () =>
{
    const { catalog } = inputs();
    const missing = structuredClone(catalog);
    delete missing.scenarios[0].scheduler;
    assert.match(
        validateReleaseReliabilitySchedulerCatalog(missing).join('\n'),
        /fixed profile|resourceClass/u
    );

    const staleDigest = structuredClone(catalog);
    staleDigest.scenarios[0].schedulerProfileDigest = `sha256:${'0'.repeat(64)}`;
    assert.match(
        validateReleaseReliabilitySchedulerCatalog(staleDigest).join('\n'),
        /schedulerProfileDigest/u
    );

    const added = structuredClone(catalog);
    added.scenarios.push({ ...structuredClone(added.scenarios[0]), id: 'release-extra' });
    added.canonicalScenarioIds.push('release-extra');
    added.catalogScenarioCount += 1;
    assert.match(
        validateReleaseReliabilitySchedulerCatalog(added).join('\n'),
        /exactly match/u
    );
});

test('actual scenario grant is sealed and rejects grants below minCpuUnits', schedulerAuthorityTest, () =>
{
    const { catalog } = inputs();
    const scenario = catalog.scenarios.find((entry) => entry.id === 'release-load-burst');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-reliability-grant-'));
    const grantFile = path.join(directory, 'grant.json');
    const write = (cpuUnits) => fs.writeFileSync(grantFile, JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'scheduler-run',
        grants: {
            'release-reliability-fresh': { cpuUnits, memoryGiB: 4 }
        }
    }));
    try
    {
        write(4);
        const granted = resolveScenarioSchedulerGrant({
            catalog,
            scenario,
            runId: 'scheduler-run',
            requireSchedulerGrant: true,
            ambientEnvironment: {
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: grantFile,
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_RUN_ID: 'scheduler-run',
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'release-reliability-fresh'
            }
        });
        assert.equal(granted.status, 'granted');
        assert.equal(granted.granted.cpuUnits, 4);
        assert.equal(
            granted.profileDigest,
            releaseReliabilitySchedulerProjection(catalog, scenario.id)
                .schedulerProfileDigest
        );

        write(3);
        assert.throws(() => resolveScenarioSchedulerGrant({
            catalog,
            scenario,
            runId: 'scheduler-run',
            requireSchedulerGrant: true,
            ambientEnvironment: {
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: grantFile,
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_RUN_ID: 'scheduler-run',
                FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'release-reliability-fresh'
            }
        }), /below minCpuUnits=4/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
