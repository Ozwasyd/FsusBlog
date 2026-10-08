import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { canonicalJson, sealContentDigest, sha256 } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { validateRuntimeScenarioCatalog } = await import(new URL('../runtime-scenario-host.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const suiteSource = 'tools/test/lanes/_suite-support.sh';
const catalogSource = 'config/testing/runtime-scenario-catalog.json';
const frontendManifest = 'src/frontend/package.json';
const schema = 'fsusblog.public-runtime-producer-declarations.v1';

function clientNode(id, command, target, timeoutProfile, environment = {})
{
    return {
        id,
        kind: 'correctness',
        execution: { owner: 'RunInClient', cwd: 'src/frontend', command, target, timeoutProfile, environment },
        dependsOn: [],
        settledDependsOn: [],
        stateAccessRef: null,
        requiredAuthorities: ['fixture-verify', 'state-access', 'execution-envelope', 'replay-plan', 'temporal-context'],
        attemptPolicy: { policyId: 'correctness-first-attempt', attemptNumber: 1, allowedRetries: 0 }
    };
}

function releaseNodes()
{
    const checks = [
        ['public-aot-regression', 'aot-regression.mjs', 'preview'],
        ['public-hydration-identity', 'check-public-hydration-identity.mjs', 'backend'],
        ['public-hydration-smoke', 'public-hydration-smoke.mjs', 'backend'],
        ['public-clock-hydration-matrix', 'check-public-clock-hydration-matrix.mjs', 'backend'],
        ['public-browser-env-hydration-matrix', 'check-public-browser-env-hydration-matrix.mjs', 'backend'],
        ['public-payload-fixture-matrix', 'check-public-payload-fixture-matrix.mjs', 'backend'],
        ['public-dom-diff-hydration', 'check-public-dom-diff-hydration.mjs', 'backend']
    ].map(([id, file, target]) => clientNode(id, ['node', `../../tests/frontend/checks/public/${file}`], target, 'release'));
    checks.push(clientNode('public-hydration-matrix-governance', [
        'node', '../../tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs', '--lane', 'release'
    ], 'backend', 'release', { FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS: '1' }));
    checks.push(clientNode('public-seo-smoke', ['npm', 'run', 'check:public-seo-smoke'], 'backend', 'release'));
    return checks.map((node) => ({
        ...node,
        dependsOn: ['release-public-hydration'],
        requiredAuthorities: [...node.requiredAuthorities, 'release-public-hydration', 'current-preview-build-manifest']
    }));
}

function resilienceNodes(catalog)
{
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    // Membership and scenario semantics come exclusively from the existing host catalog.
    return catalog.scenarios.filter((scenario) => scenario.phase === 'resilience' && scenario.executor !== 'fixture-only')
        .map((scenario) =>
        {
            const node = clientNode(scenario.id.replaceAll('.', '-'), null, 'backend', 'resilience');
            return {
                ...node,
                execution: {
                    owner: 'tools/test/runtime-scenario-host.mjs',
                    cwd: 'src/frontend',
                    target: 'backend',
                    timeoutProfile: 'resilience',
                    scenario: structuredClone(scenario)
                },
                dependsOn: ['runtime-readiness'],
                requiredAuthorities: [...node.requiredAuthorities, 'runtime-readiness', 'release-preview',
                    `reset:${scenario.resetBarrier}`, 'resident-host-lease', 'host-health-state-postflight']
            };
        });
}

function loadNodes()
{
    const first = clientNode('load-public-api', ['npm', 'run', 'check:load:public-api'], 'backend-and-preview', 'load');
    const second = clientNode('load-notification-stream-pressure', ['npm', 'run', 'check:load:notification-stream-pressure'], 'backend-and-preview', 'load');
    for (const [node, noiseEvidencePath] of [
        [first, '.tmp/perf/load/measurement-noise-public-api.json'],
        [second, '.tmp/perf/load/measurement-noise-notification-stream.json']
    ])
    {
        node.execution.owner = 'RunInClientMeasurement';
        node.execution.measurementWindowId = node.id;
        node.execution.noiseEvidencePath = noiseEvidencePath;
        node.requiredAuthorities.push('runtime-readiness', 'measurement-admission', 'quiescence-lease');
    }
    first.dependsOn = ['runtime-readiness', 'runtime-quiescence'];
    second.dependsOn = ['reset-pre-notification-stream'];
    return [first, {
        id: 'reset-pre-notification-stream',
        kind: 'verified-postcondition-barrier',
        execution: null,
        dependsOn: ['runtime-readiness'],
        settledDependsOn: [first.id],
        stateAccessRef: null,
        requiredAuthorities: ['state-access', 'fixture-verify', 'runtime-readiness', 'reset-postcondition', 'quiescence-lease'],
        attemptPolicy: null
    }, second];
}

function readSource(root, relativePath)
{
    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || fs.lstatSync(absolute).isSymbolicLink())
    {
        throw new Error(`invalid producer source: ${relativePath}`);
    }
    return { path: relativePath, digest: sha256(fs.readFileSync(absolute)) };
}

/** Verify command membership only; this never infers dependencies from shell order. */
export function verifyPublicRuntimeCommandParity(tier, suiteText, nodes)
{
    const functionName = tier === 'release-public' ? 'RunReleaseOnly' : tier === 'load' ? 'RunLoadOnly' : null;
    if (functionName === null)
    {
        return;
    }
    const body = suiteText.match(new RegExp(`^${functionName}\\(\\) \\{([\\s\\S]*?)^\\}`, 'mu'))?.[1];
    if (body === undefined)
    {
        throw new Error(`missing original command owner: ${functionName}`);
    }
    const observed = body.replaceAll(/\\\n\s*/gu, ' ').split('\n')
        .map((line) => line.trim().replaceAll(/\s+/gu, ' ')).filter((line) => /^RunInClient(?:Measurement)? /u.test(line));
    const expected = nodes.filter((node) => node.kind === 'correctness').map((node) =>
    {
        const execution = node.execution;
        if (execution.owner === 'RunInClientMeasurement')
        {
            return `RunInClientMeasurement ${node.id} "$ROOT_DIR/${execution.noiseEvidencePath}" ${execution.command.join(' ')}`;
        }
        const environment = Object.entries(execution.environment).map(([key, value]) => `${key}=${value}`).join(' ');
        return `RunInClient ${environment ? `env ${environment} ` : ''}${execution.command.join(' ')}`;
    });
    if (canonicalJson(observed) !== canonicalJson(expected))
    {
        throw new Error('original public runtime command membership/arguments drift');
    }
}

/** Produce source declarations only; compilation/admission belongs to the canonical owners. */
export function buildPublicRuntimeDeclarations(tier, { root = repositoryRoot } = {})
{
    let nodes;
    let summaryId;
    const sourcePaths = [suiteSource, frontendManifest];
    if (tier === 'release-public')
    {
        nodes = releaseNodes();
        summaryId = 'release-public-summary';
        sourcePaths.push(...nodes.flatMap((node) => node.execution.command.filter((argument) => argument.startsWith('../../tests/'))
            .map((argument) => argument.slice(6))));
    }
    else if (tier === 'resilience')
    {
        nodes = resilienceNodes(JSON.parse(fs.readFileSync(path.join(root, catalogSource), 'utf8')));
        summaryId = 'resilience-summary';
        sourcePaths.push(catalogSource, ...nodes.flatMap((node) => node.execution.scenario.module ? [node.execution.scenario.module] : []));
    }
    else if (tier === 'load')
    {
        nodes = loadNodes();
        summaryId = 'load-summary';
        sourcePaths.push('tools/test/performance-admission.mjs');
    }
    else
    {
        throw new Error(`unsupported public runtime tier: ${tier}`);
    }
    verifyPublicRuntimeCommandParity(tier, fs.readFileSync(path.join(root, suiteSource), 'utf8'), nodes);
    const childIds = nodes.map((node) => node.id);
    nodes.push({
        id: summaryId,
        kind: 'settled-projection',
        execution: null,
        dependsOn: [],
        settledDependsOn: childIds,
        stateAccessRef: null,
        requiredAuthorities: ['current-run-terminal-receipts'],
        attemptPolicy: null
    });
    const internalIds = new Set(nodes.map((node) => node.id));
    return sealContentDigest({
        schema,
        authority: 'DATA_ONLY',
        qualificationEligible: false,
        tier,
        sources: [...new Set(sourcePaths)].sort().map((sourcePath) => readSource(root, sourcePath)),
        externalDependencies: [...new Set(nodes.flatMap((node) => node.dependsOn).filter((id) => !internalIds.has(id)))].sort(),
        nodes
    });
}

/** Reconstruct from held repository sources so resealing altered edges cannot pass. */
export function verifyPublicRuntimeDeclarations(declarations, options = {})
{
    const expected = buildPublicRuntimeDeclarations(declarations?.tier, options);
    if (canonicalJson(declarations) !== canonicalJson(expected))
    {
        throw new Error('public runtime declaration/source identity mismatch');
    }
    return expected;
}
