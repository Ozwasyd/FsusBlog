
/* eslint-disable import-x/no-relative-parent-imports -- Integrate the existing canonical lifecycle and resource observer owners. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    loadLifecycleActionContracts,
    validateLifecycleActionRegistry
} from '../../tools/test/release-reliability-lifecycle-actions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (relativePath) => JSON.parse(
    fs.readFileSync(path.join(root, relativePath), 'utf8')
);
const schema = source(
    'config/schemas/release-reliability-lifecycle-action-registry.schema.json'
);
const catalog = source(
    'config/testing/release-reliability-scenario-catalog.json'
);
const registry = source(
    'config/testing/release-reliability-lifecycle-action-registry.json'
);
const stateDomainRegistry = source(
    'config/testing/runtime-state-domain-registry.json'
);

function errorsFor(change)
{
    const candidateCatalog = structuredClone(catalog);
    const candidateRegistry = structuredClone(registry);
    const candidateDomains = structuredClone(stateDomainRegistry);
    change({
        catalog: candidateCatalog,
        registry: candidateRegistry,
        stateDomainRegistry: candidateDomains
    });
    return validateLifecycleActionRegistry({
        registry: candidateRegistry,
        schema,
        catalog: candidateCatalog,
        stateDomainRegistry: candidateDomains
    }).join('\n');
}

test('canonical lifecycle action registry is schema-valid and exact for seven scenarios', () =>
{
    const contracts = loadLifecycleActionContracts({ repositoryRoot: root });
    assert.equal(contracts.catalog.scenarios.length, 7);
    assert.equal(contracts.registry.actions.length, 35);
    assert.equal(contracts.actions.size, 35);
});

test('catalog action references are closed-world in both directions', () =>
{
    assert.match(
        errorsFor(({ registry: candidate }) =>
        {
            candidate.actions.pop();
        }),
        /action is missing from registry|referenced exactly once/u
    );
    assert.match(
        errorsFor(({ registry: candidate }) =>
        {
            candidate.actions.push({
                ...candidate.actions[0],
                actionId: 'soak-unreferenced-observation'
            });
        }),
        /referenced exactly once/u
    );
});

test('exclusive state domains require a canonical lifecycle owner', () =>
{
    assert.match(
        errorsFor(({ catalog: candidate }) =>
        {
            candidate.scenarios[0].isolation.exclusiveResources.push('postgres.article');
            candidate.scenarios[0].isolation.exclusiveResources.sort();
        }),
        /domain inventory is not exact/u
    );
    assert.match(
        errorsFor(({ registry: candidate }) =>
        {
            candidate.actions[0].stateDomains = ['database'];
        }),
        /sorted canonical domains|unknown state domain/u
    );
});

test('measurement cannot be the only lifecycle owner for an exclusive domain', () =>
{
    assert.match(
        errorsFor(({ registry: candidate }) =>
        {
            for (const action of candidate.actions.filter(
                (entry) => entry.scenarioId === 'release-mutation-critical-slice'
                    && entry.phase !== 'measurement'
            ))
            {
                action.stateDomains = action.stateDomains.filter(
                    (domain) => domain !== 'artifact.production-build'
                );
            }
        }),
        /owned only by measurement/u
    );
});

test('evidence-file preparation cannot claim database or runtime reset', () =>
{
    assert.match(
        errorsFor(({ registry: candidate }) =>
        {
            const preparation = candidate.actions.find(
                (action) => action.actionId === 'soak-prepare-evidence-files'
            );
            preparation.operation = 'prepare-evidence-files';
        }),
        /artifact targets only/u
    );
});

test('ordinary runtime resets cannot omit database or cache state verification', () =>
{
    assert.match(errorsFor(({ registry: candidate }) =>
    {
        candidate.actions[1].stateDomains = ['artifact.release-derived'];
    }), /runtime reset must verify database state and reset public cache/u);
});
