/* eslint-disable import-x/no-relative-parent-imports -- These controls exercise the canonical catalog and runtime step owners. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runtimeSteps } from '../../tools/test/bundles/bundle-steps.mjs';
import { analyzeRuntimeStepCommand, validateRuntimeStateDomainCatalog } from '../../tools/test-matrix/runtime-state-domain-catalog.mjs';

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

for (const stepId of ['security-runtime-core', 'resilience'])
{
    test(`${stepId} binds public-content creation to the existing fixture shell owner`, () =>
    {
        const step = runtimeSteps().find((candidate) => candidate.id === stepId);
        const analysis = analyzeRuntimeStepCommand(step);
        assert.ok(analysis.calledFunctions.includes('InvokeLaneFixtureOrchestrator'));
        assert.ok(analysis.findings.some((finding) =>
            finding.operation === 'creates' && finding.domain === 'fixture.public-content'
            && finding.source === 'tools/test/lanes/_suite-support.sh#InvokeLaneFixtureOrchestrator'));
    });
    test(`${stepId} rejects omitted or incorrect public-content creation`, () =>
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
    });
    test(`${stepId} rejects omitted or incorrect public-content operation overlap`, () =>
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
    });
    test(`${stepId} rejects a forged public-content creation owner`, () =>
    {
        rejects((data) =>
        {
            const entry = data.steps.find((candidate) => candidate.stepId === stepId);
            entry.evidence.find((proof) => proof.operation === 'creates' && proof.domain === 'fixture.public-content').source = 'tools/test/lanes/_suite-support.sh#RunIntegrationOnly';
        }, new RegExp(`${stepId} invalid static analyzer proof for creates fixture\\.public-content`));
    });
}
