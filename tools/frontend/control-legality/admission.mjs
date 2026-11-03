import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadCatalog } from '@fsusblog/governance-tools/contracts/behavior-contract-catalog';
import { scanBehaviorTestBindings } from '@fsusblog/governance-tools/contracts/behavior-test-binding';
import { parseMatrix } from '@fsusblog/governance-tools/test-matrix/parse-matrix';
import { verifyBehaviorTestEvidence } from '@fsusblog/governance-tools/test-matrix/verify-behavior-test-evidence';
import { sourceIdentity } from '@fsusblog/governance-tools/test-observations/execution';

import {
    controlDigest,
    controlRegistryPath,
    createControlSourceResolver,
    scanControlLegality,
    verifyPublicControlParity
} from './source.mjs';

/** No second test catalog: project the canonical matrix and behavior bindings. */
export function loadControlTestCatalog(repositoryRoot)
{
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'));
    const bindings = scanBehaviorTestBindings({ repositoryRoot, catalog });
    if (bindings.errors?.length)
    {
        throw new Error(`canonical test bindings invalid: ${bindings.errors.join('; ')}`);
    }
    const tests = new Map();
    const tiers = matrix.tiers;
    const reaches = (id, target, visited = new Set()) =>
    {
        if (id === target)
        {
            return true;
        }
        if (visited.has(id))
        {
            return false;
        }
        visited.add(id);
        const tier = tiers.find((entry) => entry.id === id);
        return (tier?.executionDependsOn ?? []).some((dependency) => reaches(dependency, target, new Set(visited)));
    };
    for (const binding of bindings.bindings)
    {
        const owners = tiers.filter((tier) => (tier.evidence ?? []).includes(binding.sourcePath));
        const lanes = ['fast', 'ci', 'release'].filter((lane) => owners.some((owner) => reaches(lane, owner.id)));
        tests.set(binding.canonicalTestId, { executable: owners.some((owner) => owner.command || owner.steps?.length),
            lanes, kind: binding.canonicalTestId.startsWith('playwright:') ? 'browser' : 'unit', sourcePath: binding.sourcePath });
    }
    return { tests, matrixDigest: controlDigest(matrix), catalogDigest: controlDigest(catalog), bindingsDigest: controlDigest(bindings.bindings) };
}

/** Existing evidence verifier independently re-joins raw results and source. */
export function loadControlTestExecutions(repositoryRoot, currentSource, options)
{
    if (!options?.receipt)
    {
        return { tests: new Map(), errors: ['current canonical test execution evidence not supplied'] };
    }
    const verified = verifyBehaviorTestEvidence({ ...options, repositoryRoot,
        expectedSourceCommit: currentSource.sourceCommit, expectedWorktreeFingerprint: currentSource.worktreeFingerprint });
    if (verified.errors.length)
    {
        return { tests: new Map(), errors: verified.errors };
    }
    const tests = new Map();
    for (const file of options.observations ?? [])
    {
        const artifact = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, file), 'utf8'));
        for (const observation of artifact.observations)
        {
            tests.set(observation.testId, { verified: true, status: observation.outcome });
        }
    }
    return { tests, errors: [] };
}

export function checkControlLegality({ repositoryRoot, parserRoot = repositoryRoot, executionEvidence, fsusUIRoot })
{
    const git = (args) =>
    {
        const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
        if (result.status !== 0)
        {
            throw new Error(`source identity unavailable: git ${args.join(' ')}`);
        }
        return result.stdout.trim();
    };
    const identity = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
        trackedDiffDigest: controlDigest(git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'])), ...sourceIdentity(repositoryRoot) };
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot, controlRegistryPath), 'utf8'));
    const errors = [];
    let catalog;
    try
    {
        catalog = loadControlTestCatalog(repositoryRoot);
    }
    catch (failure)
    {
        catalog = { tests: new Map(), matrixDigest: null, catalogDigest: null, bindingsDigest: null };
        errors.push({ reason: failure.message, controlKind: 'canonical-test-catalog' });
    }
    const executions = loadControlTestExecutions(repositoryRoot, identity, executionEvidence);
    const upstream = fsusUIRoot;
    const reports = [];
    for (const mode of ['local', 'published'])
    {
        try
        {
            const resolver = createControlSourceResolver({ repositoryRoot, parserRoot, fsusUIRoot: upstream, mode });
            reports.push({ mode, ...scanControlLegality({ repositoryRoot, resolver, registry,
                testCatalog: catalog.tests, testExecutions: executions.tests }) });
        }
        catch (failure)
        {
            errors.push({ mode, reason: failure.message, controlKind: 'source-admission', path: 'src/frontend/package.json', line: 1, column: 1 });
        }
    }
    if (reports.length === 2)
    {
        try
        {
            verifyPublicControlParity(reports[0], reports[1]);
        }
        catch (failure)
        {
            errors.push({ reason: failure.message, controlKind: 'source-parity', path: 'src/frontend/package.json', line: 1, column: 1 });
        }
    }
    errors.push(...executions.errors.map((reason) => ({ reason, controlKind: 'execution-evidence' })));
    const analyzerFiles = ['tools/frontend/control-legality/source.mjs',
        'tools/frontend/control-legality/admission.mjs', 'tests/frontend/checks/static/check-fsusui-boundary.mjs'];
    return { schema: 'fsusblog.control-legality-admission.v1', identity, catalog: { matrixDigest: catalog.matrixDigest,
        catalogDigest: catalog.catalogDigest, bindingsDigest: catalog.bindingsDigest },
    analyzerDigest: controlDigest(analyzerFiles.map((file) => [file, controlDigest(fs.readFileSync(path.join(parserRoot, file), 'utf8'))])),
    reports, errors, warnings: [], qualified: reports.length === 2 && reports.every((report) => report.qualified) && errors.length === 0 };
}
