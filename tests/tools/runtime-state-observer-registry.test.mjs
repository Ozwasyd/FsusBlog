/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runtimeSteps } from '../../tools/test/bundles/bundle-steps.mjs';
import { createRuntimeStateObservers } from '../../tools/test-fixtures/observers/index.mjs';
import { analyzeRuntimeStepCommand, validateRuntimeStateDomainCatalog } from '../../tools/test-matrix/runtime-state-domain-catalog.mjs';
import { loadRuntimeStateAuthority } from '../../tools/test-runtime/catalog.mjs';
import { validateRuntimeStateObserverRegistry } from '../../tools/test-runtime/state-snapshot.mjs';

test('every catalog domain has exact-one registered observer and no second authority', () =>
{
    const authority = loadRuntimeStateAuthority();
    const observers = createRuntimeStateObservers();
    assert.equal(validateRuntimeStateObserverRegistry(authority, observers), true);
    const observerIds = new Set(observers.map((observer) => observer.observerId));
    assert.deepEqual(observerIds, new Set(Object.values(authority.observerBindings).map((binding) => binding.observerId)));
    assert.throws(() => validateRuntimeStateObserverRegistry(authority, observers.slice(1)), /observer is unavailable/);
    assert.throws(() => validateRuntimeStateObserverRegistry(authority, [...observers, { observerId: 'second-snapshot', version: 'v1', observe()
    {} }]), /unknown.*registration/);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(root, 'config/testing/runtime-state-domain-catalog.json');

function rejects(change, pattern)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'runtime-fixture-declaration-'));
    try
    {
        const catalog = JSON.parse(readFileSync(source, 'utf8'));
        change(catalog);
        const file = path.join(directory, 'catalog.json');
        writeFileSync(file, JSON.stringify(catalog));
        assert.match(validateRuntimeStateDomainCatalog(file).join('\n'), pattern);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

function assertFixtureCreationOwner(stepId)
{
    const step = runtimeSteps().find((candidate) => candidate.id === stepId);
    const analysis = analyzeRuntimeStepCommand(step);
    assert.ok(analysis.calledFunctions.includes('InvokeLaneFixtureOrchestrator'));
    assert.ok(analysis.findings.some((finding) =>
        finding.operation === 'creates' && finding.domain === 'fixture.public-content'
        && finding.source === 'tools/test/lanes/_suite-support.sh#InvokeLaneFixtureOrchestrator'));
}

function assertFixtureCreateDeclarationsReject(stepId)
{
    for (const replacement of [null, 'fixture.runtime-config'])
    {
        rejects((data) =>
        {
            const entry = data.steps.find((candidate) => candidate.stepId === stepId);
            entry.creates = entry.creates.filter((domain) => domain !== 'fixture.public-content');
            if (replacement)
            {
                entry.creates.push(replacement);
            }
            entry.creates.sort();
            entry.operationOverlaps = entry.operationOverlaps.filter((overlap) => overlap.domain !== 'fixture.public-content');
        }, new RegExp(`${stepId} analyzer detected undeclared creates fixture\\.public-content`));
    }
}

function assertFixtureOverlapDeclarationsReject(stepId)
{
    rejects((data) =>
    {
        const entry = data.steps.find((candidate) => candidate.stepId === stepId);
        entry.operationOverlaps = entry.operationOverlaps.filter((overlap) => overlap.domain !== 'fixture.public-content');
    }, new RegExp(`${stepId} has unexplained operation overlap for fixture\\.public-content`));
    rejects((data) =>
    {
        const entry = data.steps.find((candidate) => candidate.stepId === stepId);
        entry.operationOverlaps.find((overlap) => overlap.domain === 'fixture.public-content').operations = ['reads', 'writes'];
    }, new RegExp(`${stepId} has unexplained operation overlap for fixture\\.public-content`));
}

function assertFixtureCreationProofReject(stepId)
{
    rejects((data) =>
    {
        const entry = data.steps.find((candidate) => candidate.stepId === stepId);
        entry.evidence.find((proof) => proof.operation === 'creates' && proof.domain === 'fixture.public-content').source = 'tools/test/lanes/_suite-support.sh#RunIntegrationOnly';
    }, new RegExp(`${stepId} invalid static analyzer proof for creates fixture\\.public-content`));
}

test('security-runtime-core binds public-content creation to the existing fixture shell owner', () =>
{
    assertFixtureCreationOwner('security-runtime-core');
});

test('security-runtime-core rejects omitted or incorrect public-content creation', () =>
{
    assertFixtureCreateDeclarationsReject('security-runtime-core');
});

test('security-runtime-core rejects omitted or incorrect public-content operation overlap', () =>
{
    assertFixtureOverlapDeclarationsReject('security-runtime-core');
});

test('security-runtime-core rejects a forged public-content creation owner', () =>
{
    assertFixtureCreationProofReject('security-runtime-core');
});

test('resilience binds public-content creation to the existing fixture shell owner', () =>
{
    assertFixtureCreationOwner('resilience');
});

test('resilience rejects omitted or incorrect public-content creation', () =>
{
    assertFixtureCreateDeclarationsReject('resilience');
});

test('resilience rejects omitted or incorrect public-content operation overlap', () =>
{
    assertFixtureOverlapDeclarationsReject('resilience');
});

test('resilience rejects a forged public-content creation owner', () =>
{
    assertFixtureCreationProofReject('resilience');
});
