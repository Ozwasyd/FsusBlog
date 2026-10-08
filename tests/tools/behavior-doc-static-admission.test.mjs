import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { currentSchemaContractFixture, sealRuntimeRoleFixture } from './support/runtime-role-current-schema-fixture.mjs';

const { parseWorkflow, validateBehaviorDocStaticAdmissionTopology } = await import(new URL("../../tools/check-workflow-matrix-sync.mjs", import.meta.url));
const { buildIdentitiesFromMinimalReceipt, hostDeclarations, runMinimalContractBuild, runtimeReproduciblePathMapArgument } = await import(new URL("../../tools/docs/behavior-doc-minimal-contract-build.mjs", import.meta.url));
const { behaviorDocAdmissionReceiptSchema, validateBehaviorDocStaticAdmissionReceipt, writeFactObservationReceipts } = await import(new URL("../../tools/docs/behavior-doc-static-admission.mjs", import.meta.url));
const { digestPath, digestValue, sealSourceIdentity } = await import(new URL("../../tools/fact-extractors/identity.mjs", import.meta.url));
const { loadRegistry } = await import(new URL("../../tools/fact-extractors/registry.mjs", import.meta.url));
const { establishBehaviorDocAdmission, runLocalProfile } = await import(new URL("../../tools/run-test-matrix.mjs", import.meta.url));
const { behaviorDocStaticAdmissionTierId, localBehaviorDocCandidateBundleIds, validateBehaviorDocStaticAdmissionMatrix } = await import(new URL("../../tools/test-matrix/behavior-doc-static-admission-contract.mjs", import.meta.url));
const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));
const { runDag } = await import(new URL("../../tools/test-matrix/scheduler.mjs", import.meta.url));
const { validateJsonSchema } = await import(new URL("../../tools/test-matrix/schema-validator/validate.mjs", import.meta.url));

const { readProtectedBehaviorDocAdmissionReceipt, waitProtectedBehaviorDocRunner } = await import(new URL("../../tools/test-matrix/protected-behavior-doc-admission.mjs", import.meta.url));

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

function tempDirectory(label)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${label}-`));
}

function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

test('successful fact observations are materialized for canonical drift repair', (t) =>
{
    const componentsDirectory = tempDirectory('behavior-doc-fact-observations');
    t.after(() => fs.rmSync(componentsDirectory, { recursive: true, force: true }));
    const receipts = [
        {
            extractorId: 'test-asset-audit-fact-extractor',
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64),
            status: 'ok'
        },
        {
            extractorId: 'test-matrix-fact-extractor',
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64),
            status: 'ok'
        }
    ];

    writeFactObservationReceipts(componentsDirectory, receipts);

    for (const receipt of receipts)
    {
        const written = JSON.parse(fs.readFileSync(path.join(
            componentsDirectory,
            'fact-observations',
            `${receipt.extractorId}.json`
        ), 'utf8'));
        assert.deepEqual(written, receipt);
    }
});

function fakeMinimalReceipt(runId, source)
{
    const buildRoot = `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`;
    const runtimeBuildRoot = `.tmp/runtime-role-reproducible-builds/${'b'.repeat(64)}`;
    const runtimeAssemblyPath = `${runtimeBuildRoot}/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll`;
    const runtimeDeploymentPath = `${buildRoot}/observations/runtime-role-deployment-observation.json`;
    const sourceClosureDigests = [
        {
            path: 'Directory.Build.props',
            digest: 'e'.repeat(64)
        },
        {
            path: 'Directory.Packages.props',
            digest: 'f'.repeat(64)
        },
        {
            path: 'src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs',
            digest: '9'.repeat(64)
        }
    ];
    return seal({
        schema: 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1',
        runId,
        sourceCommit: source.sourceCommit,
        worktreeFingerprint: source.worktreeFingerprint,
        toolchain: {
            dotnet: '10.0.100',
            configuration: 'Release',
            targetFramework: 'net10.0'
        },
        buildKey: 'b'.repeat(64),
        buildRoot,
        sourceClosureDigests,
        sourceDigest: digestValue(sourceClosureDigests),
        artifacts: Object.fromEntries(Object.entries(hostDeclarations).map(([artifactId, declaration]) => [
            artifactId,
            {
                project: declaration.project,
                projectDigest: 'c'.repeat(64),
                path: path.posix.join(
                    buildRoot,
                    declaration.cacheFile
                ),
                artifactPath: declaration.output,
                artifactDigest: 'd'.repeat(64),
                ...(artifactId === 'runtime-role-observation'
                    ? {
                        assemblyPath: runtimeAssemblyPath,
                        assemblyDigest: '3'.repeat(64),
                        deploymentArtifactPath: runtimeDeploymentPath,
                        deploymentArtifactDigest: '4'.repeat(64)
                    }
                    : {}),
                buildReceipt: {
                    schema: declaration.buildReceiptSchema,
                    artifactId,
                    artifactPath: declaration.output,
                    artifactDigest: 'd'.repeat(64),
                    configuration: 'Release',
                    ...(artifactId === 'openapi-aeds-observation'
                        ? {
                            openapiPath: `${buildRoot}/observations/fsusblog.openapi.observed.json`,
                            openapiArtifactPath: '.tmp/contracts/openapi/fsusblog.openapi.observed.json',
                            openapiDigest: '8'.repeat(64)
                        }
                        : {}),
                    ...(artifactId === 'runtime-role-observation'
                        ? {
                            sourceCommit: source.sourceCommit,
                            worktreeFingerprint: source.worktreeFingerprint,
                            projectDigest: 'c'.repeat(64),
                            assemblyPath: runtimeAssemblyPath,
                            assemblyDigest: '3'.repeat(64),
                            reproducibleBuild: {
                                schema: 'fsusblog.runtime-role-reproducible-build-attestation.v1',
                                project: declaration.project,
                                command: [
                                    'dotnet', 'build', declaration.project, '--configuration', 'Release',
                                    '--no-incremental', '--disable-build-servers', '--artifacts-path',
                                    runtimeBuildRoot,
                                    '/p:Deterministic=true', '/p:ContinuousIntegrationBuild=true',
                                    runtimeReproduciblePathMapArgument,
                                    `/p:FsusBlogCommitSha=${source.sourceCommit}`,
                                    '/p:NuGetAudit=false', '/m:1'
                                ],
                                outputRoot: runtimeBuildRoot,
                                assemblyPath: runtimeAssemblyPath,
                                assemblyDigest: '3'.repeat(64),
                                sourceClosureDigest: digestValue(sourceClosureDigests)
                            },
                            deploymentArtifactPath: runtimeDeploymentPath,
                            deploymentArtifactDigest: '4'.repeat(64),
                            producer: 'dotnet-run-content-addressed-minimal-contract-host',
                            externalOracle: 'docker-compose-config-json-no-interpolate',
                            externalOracleVersion: '5.3.1',
                            dockerExecutable: {
                                canonicalPath: '/usr/bin/docker',
                                digest: '6'.repeat(64),
                                version: '29.6.2'
                            },
                            composeImplementation: {
                                canonicalPath: '/usr/lib/docker/cli-plugins/docker-compose',
                                digest: '7'.repeat(64),
                                version: '5.3.1'
                            },
                            effectiveComposeModelDigest: `sha256:${'5'.repeat(64)}`,
                            deploymentAuthoritySchema: 'fsusblog.monolithic-distributed-architecture.v2',
                            deploymentAuthorityContentDigest: `sha256:${'1'.repeat(64)}`,
                            deploymentObservationDigest: `sha256:${'2'.repeat(64)}`
                        }
                        : {})
                }
            }
        ])),
        status: 'ok',
        failureReasons: []
    });
}

test('minimal build identity preserves the canonical receipt and source digest binding', () =>
{
    const receipt = fakeMinimalReceipt('minimal-build-identity', {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    });
    const identity = buildIdentitiesFromMinimalReceipt(receipt)['runtime-role-observation'];
    assert.equal(identity.schema, 'fsusblog.build-identity.v1');
    assert.equal(identity.receiptDigest, receipt.contentDigest);
    assert.deepEqual(identity.sourceDigests, receipt.sourceClosureDigests);
    assert.equal(identity.sourceDigest, digestValue(receipt.sourceClosureDigests));
});

test('directory source digests ignore generated dotnet outputs while binding source files', (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-source-digest');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    for (const relative of ['src/migration', 'src/migration/bin/Release', 'src/migration/obj/Release'])
    {
        fs.mkdirSync(path.join(repositoryRoot, relative), { recursive: true });
    }
    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/Schema.cs'), 'sealed class Schema {}\n');
    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/bin/Release/output.dll'), 'first-build');
    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/obj/Release/cache.bin'), 'first-cache');

    const initial = digestPath(repositoryRoot, 'src/migration');
    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/bin/Release/output.dll'), 'second-build');
    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/obj/Release/cache.bin'), 'second-cache');
    assert.equal(digestPath(repositoryRoot, 'src/migration'), initial);

    fs.writeFileSync(path.join(repositoryRoot, 'src/migration/Schema.cs'), 'sealed class Schema { public int Version => 2; }\n');
    assert.notEqual(digestPath(repositoryRoot, 'src/migration'), initial);
});

test('config/error minimal build identity binds the production mapper source digest', () =>
{
    const receipt = fakeMinimalReceipt('minimal-build-config-error-source', {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    });
    const identity = buildIdentitiesFromMinimalReceipt(receipt)['config-error-security-policy-observation'];
    const mapperPath = 'src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs';

    assert.equal(
        identity.sourceDigests.find(({ path: sourcePath }) => sourcePath === mapperPath)?.digest,
        '9'.repeat(64)
    );
    assert.deepEqual(identity.sourceDigests, receipt.sourceClosureDigests);
    assert.equal(identity.sourceDigest, digestValue(identity.sourceDigests));
});

function validAdmissionReceipt({
    runId = 'behavior-doc-test',
    source = {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    },
    worktree = root
} = {})
{
    const registry = loadRegistry(path.join(root, 'config/contracts/behavior-fact-extractors.json'));
    const factObservations = Object.fromEntries(registry.extractors.map((extractor) => [
        extractor.id,
        {
            status: 'ok',
            extractorDigest: 'd'.repeat(64),
            semanticDigest: 'e'.repeat(64),
            contentDigest: 'f'.repeat(64)
        }
    ]));
    return seal({
        schema: behaviorDocAdmissionReceiptSchema,
        run: { id: runId },
        source: {
            commit: source.sourceCommit,
            worktreeFingerprint: source.worktreeFingerprint
        },
        worktree: { root: worktree },
        toolchain: {
            node: 'v24.0.0',
            dotnet: '10.0.100',
            platform: 'linux',
            architecture: 'x64',
            directoryBuildPropsDigest: '1'.repeat(64)
        },
        authorityDigests: {
            catalog: '2'.repeat(64),
            claim: '3'.repeat(64),
            extractorRegistry: '4'.repeat(64),
            generatedSectionCatalog: '5'.repeat(64),
            generatedRenderer: '6'.repeat(64),
            proseRenderer: '7'.repeat(64),
            mutationCatalog: '8'.repeat(64)
        },
        implementationOwner: {
            status: 'ok',
            bindingCount: 1,
            contentDigest: '9'.repeat(64)
        },
        factObservations,
        minimalContractBuild: fakeMinimalReceipt(runId, source),
        generated: {
            status: 'ok',
            documentCount: 0,
            contentDigest: 'a'.repeat(64)
        },
        prose: {
            status: 'ok',
            verifiedClaimCount: 0,
            contentDigest: 'b'.repeat(64)
        },
        mutationFixtures: {
            status: 'ok',
            caseCount: 9,
            contentDigest: 'c'.repeat(64)
        },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok',
        failureReasons: [],
        durationMs: 1
    });
}

function schedulerTier(id, overrides = {})
{
    return {
        id,
        command: `${process.execPath} -e "process.exit(0)"`,
        executionDependsOn: [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        maxParallel: 2,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: `behavior-doc-test/${id}`,
        executionVariant: 'ordinary',
        coverage: [],
        artifacts: [],
        evidence: [],
        ...overrides
    };
}

function copyMinimalBuildFixture(repositoryRoot)
{
    const registry = loadRegistry(path.join(root, 'config/contracts/behavior-fact-extractors.json'));
    const copiedPaths = new Set([
        'config/contracts/behavior-fact-extractors.json',
        'tools/docs/behavior-doc-minimal-contract-build.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs',
        'tools/fact-extractors/identity.mjs',
        'Directory.Build.props',
        'Directory.Packages.props',
        'FsusBlog.slnx',
        'src/backend/FsusBlog.Server.csproj',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj',
        'tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj',
        ...registry.extractors
            .filter((extractor) => extractor.kind === 'compiled-assembly')
            .flatMap((extractor) => extractor.consumedInputs),
        ...Object.values(hostDeclarations).map((entry) => entry.project)
    ]);
    for (const relative of copiedPaths)
    {
        const source = path.join(root, relative);
        const destination = path.join(repositoryRoot, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(source, destination, { recursive: true });
    }
}

function collectChild(child)
{
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    return new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
            code,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8')
        }));
    });
}

test('matrix and workflow declare one fixture-free admission before every applicable candidate', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    assert.deepEqual(validateBehaviorDocStaticAdmissionMatrix(matrix, { repositoryRoot: root }), []);
    const admission = matrix.tiers.find((tier) => tier.id === behaviorDocStaticAdmissionTierId);
    assert.equal(admission.executionClass, 'static-governance');
    assert.equal(admission.fixtureProfile, 'none');
    assert.equal(admission.qualificationEligible, true);
    assert.deepEqual(admission.services, []);
    assert.equal(admission.requiresPlaywright, 'none');
    for (const bundleId of localBehaviorDocCandidateBundleIds)
    {
        const bundle = matrix.localProfiles.production.bundles.find((entry) => entry.id === bundleId);
        assert.deepEqual(bundle.dependsOn, [behaviorDocStaticAdmissionTierId]);
    }

    const newUnlistedCandidate = structuredClone(matrix);
    newUnlistedCandidate.tiers.push({
        id: 'future-unlisted-expensive-browser-tier',
        command: 'tools/test/lanes/future-expensive-browser-tier.sh',
        executionDependsOn: [],
        services: ['postgres', 'backend'],
        requiresPlaywright: 'chromium'
    });
    const newCandidateErrors = validateBehaviorDocStaticAdmissionMatrix(newUnlistedCandidate);
    assert.ok(newCandidateErrors.some((error) =>
        /future-unlisted-expensive-browser-tier must depend/u.test(error)));
    newUnlistedCandidate.tiers.at(-1).executionDependsOn = [behaviorDocStaticAdmissionTierId];
    assert.equal(
        validateBehaviorDocStaticAdmissionMatrix(newUnlistedCandidate)
            .some((error) => /future-unlisted-expensive-browser-tier/u.test(error)),
        false
    );

    const disguisedAggregate = structuredClone(matrix);
    const fastAggregate = disguisedAggregate.tiers.find((tier) => tier.id === 'fast');
    fastAggregate.command = 'tools/test/lanes/load-smoke.sh';
    assert.ok(validateBehaviorDocStaticAdmissionMatrix(disguisedAggregate).some((error) =>
        /fast must depend on behavior-doc-static-admission/u.test(error)));

    const workflowSource = fs.readFileSync(
        path.join(root, '.github/workflows/quality-gate.yml'),
        'utf8'
    );
    const workflow = parseWorkflow(workflowSource);
    const errors = [];
    validateBehaviorDocStaticAdmissionTopology(workflow, errors);
    assert.deepEqual(errors, []);

    const missingDependency = workflowSource.replace(
        'needs: [validate-matrix, behavior-doc-static-admission, plan-pr-risk]\n        if: github.event_name != \'pull_request\' || needs.plan-pr-risk.outputs.fast_backend == \'true\'\n        timeout-minutes: 45',
        'needs: [validate-matrix, plan-pr-risk]\n        if: github.event_name != \'pull_request\' || needs.plan-pr-risk.outputs.fast_backend == \'true\'\n        timeout-minutes: 45'
    );
    const mutatedErrors = [];
    validateBehaviorDocStaticAdmissionTopology(parseWorkflow(missingDependency), mutatedErrors);
    assert.ok(mutatedErrors.some((error) => /fast-backend.*must depend/u.test(error)));

    const consumerBlock = `            - uses: ./.github/actions/consume-behavior-doc-admission
              with:
                  source-fingerprint: \${{ needs.behavior-doc-static-admission.outputs.source_fingerprint }}
                  receipt-digest: \${{ needs.behavior-doc-static-admission.outputs.receipt_digest }}
`;
    const missingReceiptVerification = workflowSource.replace(consumerBlock, '');
    const missingReceiptErrors = [];
    validateBehaviorDocStaticAdmissionTopology(
        parseWorkflow(missingReceiptVerification),
        missingReceiptErrors
    );
    assert.ok(missingReceiptErrors.some((error) =>
        /must verify the sealed behavior-doc-static-admission receipt/u.test(error)));

    const consumerWithUnexpectedCacheInputs = workflowSource.replace(
        '                  receipt-digest: ${{ needs.behavior-doc-static-admission.outputs.receipt_digest }}',
        `                  receipt-digest: \${{ needs.behavior-doc-static-admission.outputs.receipt_digest }}
                  cache: npm
                  cache-dependency-path: src/frontend/package-lock.json`
    );
    const consumerInputErrors = [];
    validateBehaviorDocStaticAdmissionTopology(
        parseWorkflow(consumerWithUnexpectedCacheInputs),
        consumerInputErrors
    );
    assert.ok(consumerInputErrors.some((error) =>
        /BehaviorDoc consumer must pass exactly.*cache/u.test(error)));

    const setupNodeWithoutCache = workflowSource.replace(
        `                  node-version: 24.x
                  cache: npm
                  cache-dependency-path: src/frontend/package-lock.json
            - uses: ./.github/actions/consume-behavior-doc-admission`,
        `                  node-version: 24.x
            - uses: ./.github/actions/consume-behavior-doc-admission`
    );
    const setupNodeCacheErrors = [];
    validateBehaviorDocStaticAdmissionTopology(
        parseWorkflow(setupNodeWithoutCache),
        setupNodeCacheErrors
    );
    assert.ok(setupNodeCacheErrors.some((error) =>
        /must keep the frontend npm cache inputs.*setup-node/u.test(error)));

    const failOpenAlwaysJob = workflowSource.replace(
        "if: always() && needs.behavior-doc-static-admission.result == 'success'",
        'if: always()'
    );
    const failOpenAlwaysErrors = [];
    validateBehaviorDocStaticAdmissionTopology(
        parseWorkflow(failOpenAlwaysJob),
        failOpenAlwaysErrors
    );
    assert.ok(failOpenAlwaysErrors.some((error) =>
        /always\(\).*behavior-doc-static-admission.*success/u.test(error)));
});

test('sealed receipt rejects every fail-open static result and candidate spawn', () =>
{
    const receipt = validAdmissionReceipt();
    const schema = JSON.parse(fs.readFileSync(
        path.join(root, 'config/schemas/behavior-doc-static-admission-receipt.schema.json'),
        'utf8'
    ));
    assert.deepEqual(validateJsonSchema(receipt, schema), []);
    const expected = {
        expectedRunId: receipt.run.id,
        expectedSourceIdentity: {
            sourceCommit: receipt.source.commit,
            worktreeFingerprint: receipt.source.worktreeFingerprint
        },
        expectedWorktree: root
    };
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt, expected), receipt);

    const mutations = [
        ['missing generated line', (value) =>
        {
            value.generated.status = 'failed';
        }],
        ['stale prose without lifecycle self-certification', (value) =>
        {
            value.prose.status = 'failed';
        }],
        ['double implementation owner', (value) =>
        {
            value.implementationOwner.status = 'failed';
        }],
        ['warning mutation result', (value) =>
        {
            value.mutationFixtures.status = 'warning';
        }],
        ['candidate spawned before receipt', (value) =>
        {
            value.candidateSpawnCountBeforeReceipt = 1;
        }],
        ['missing current extractor', (value) =>
        {
            delete value.factObservations[Object.keys(value.factObservations)[0]];
        }],
        ['reproducible build command drift', (value) =>
        {
            value.minimalContractBuild.artifacts['runtime-role-observation']
                .buildReceipt.reproducibleBuild.command[11] = '/p:PathMap=untrusted';
        }]
    ];
    for (const [label, mutate] of mutations)
    {
        const value = structuredClone(receipt);
        mutate(value);
        assert.throws(
            () => validateBehaviorDocStaticAdmissionReceipt(seal(value), expected),
            undefined,
            label
        );
    }

    const tampered = structuredClone(receipt);
    tampered.generated.documentCount += 1;
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(tampered, expected),
        /content digest mismatch/u
    );
});

test('OpenAPI projection schema is closed without broadening other minimal hosts', () =>
{
    const receipt = validAdmissionReceipt();
    const schema = JSON.parse(fs.readFileSync(
        path.join(root, 'config/schemas/behavior-doc-static-admission-receipt.schema.json'),
        'utf8'
    ));
    const expected = {
        expectedRunId: receipt.run.id,
        expectedSourceIdentity: {
            sourceCommit: receipt.source.commit,
            worktreeFingerprint: receipt.source.worktreeFingerprint
        },
        expectedWorktree: root
    };
    assert.deepEqual(validateJsonSchema(receipt, schema), []);

    const invalidProjections = [
        ['openapiPath', '.tmp/contracts/openapi/fsusblog.openapi.observed.json'],
        ['openapiArtifactPath', '.tmp/contracts/openapi/other.json'],
        ['openapiDigest', 'A'.repeat(64)],
        ['schema', 'fsusblog.other-build-receipt.v1'],
        ['unexpectedProjection', 'unexpected']
    ];
    for (const key of ['openapiPath', 'openapiArtifactPath', 'openapiDigest'])
    {
        invalidProjections.push([key, undefined]);
    }
    for (const [key, invalidValue] of invalidProjections)
    {
        const value = structuredClone(receipt);
        const buildReceipt = value.minimalContractBuild.artifacts['openapi-aeds-observation'].buildReceipt;
        if (invalidValue === undefined)
        {
            delete buildReceipt[key];
        }
        else
        {
            buildReceipt[key] = invalidValue;
        }
        value.minimalContractBuild = seal(value.minimalContractBuild);
        const sealed = seal(value);
        assert.notEqual(validateJsonSchema(sealed, schema).length, 0, key);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(sealed, expected), undefined, key);
    }

    for (const artifactId of [
        'runtime-role-observation',
        'auth-session-permission-observation',
        'config-error-security-policy-observation',
        'content-lifecycle-observation'
    ])
    {
        const value = structuredClone(receipt);
        value.minimalContractBuild.artifacts[artifactId].buildReceipt.openapiDigest = '8'.repeat(64);
        value.minimalContractBuild = seal(value.minimalContractBuild);
        const sealed = seal(value);
        assert.notEqual(validateJsonSchema(sealed, schema).length, 0, artifactId);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(sealed, expected), undefined, artifactId);
    }
});

test('minimal contract build uses only a content-addressed root and never ambient bin output', (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-minimal-build');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    copyMinimalBuildFixture(repositoryRoot);
    const ambient = path.join(
        repositoryRoot,
        'tools/contracts/FsusBlog.AuthSessionObservation/bin/Release/net10.0/stale.json'
    );
    fs.mkdirSync(path.dirname(ambient), { recursive: true });
    fs.writeFileSync(ambient, '{"stale":true}\n');

    const invocations = [];
    const fakeSpawn = (command, args) =>
    {
        invocations.push([command, ...args]);
        if (args[0] === '--version')
        {
            return { status: 0, stdout: '10.0.100\n', stderr: '' };
        }
        if (args[0] === 'build')
        {
            const artifactsIndex = args.indexOf('--artifacts-path');
            const assembly = path.join(
                args[artifactsIndex + 1],
                'bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll'
            );
            fs.mkdirSync(path.dirname(assembly), { recursive: true });
            fs.writeFileSync(assembly, 'fixture-runtime-role-assembly');
            return { status: 0, stdout: '', stderr: '' };
        }
        const outputIndex = args.indexOf('--output');
        assert.ok(outputIndex > 0);
        fs.mkdirSync(path.dirname(args[outputIndex + 1]), { recursive: true });
        const deploymentIndex = args.indexOf('--deployment-observation');
        const runtime = deploymentIndex >= 0;
        const deployment = runtime
            ? JSON.parse(fs.readFileSync(args[deploymentIndex + 1], 'utf8'))
            : null;
        fs.writeFileSync(args[outputIndex + 1], runtime
            ? `${JSON.stringify(sealRuntimeRoleFixture({
                schema: 'fsusblog.runtime-role-observation.v3',
                modes: [], staticRoleCapabilities: {}, unsupportedCombinations: [], ownership: {},
                deploymentAuthority: {
                    authoritySchema: deployment.authoritySchema,
                    authorityContentDigest: deployment.authorityContentDigest,
                    observationDigest: deployment.observationDigest,
                    effectiveCompose: deployment.effectiveCompose
                },
                currentSchemaContract: currentSchemaContractFixture()
            }))}\n`
            : '{"schema":"fixture"}\n');
        if (args.includes(hostDeclarations['openapi-aeds-observation'].project))
        {
            fs.writeFileSync(path.join(path.dirname(args[outputIndex + 1]), 'fsusblog.openapi.observed.json'), '{"openapi":"unit-fixture"}\n');
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    const result = runMinimalContractBuild({
        repositoryRoot,
        runId: 'minimal-build-test',
        sourceIdentity: {
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64)
        },
        spawn: fakeSpawn
    });
    assert.equal(
        invocations.filter((args) => args[1] === 'run').length,
        Object.keys(hostDeclarations).length - 1
    );
    assert.equal(invocations.filter((args) => args[1] === 'build').length, 1);
    assert.match(result.receipt.buildRoot, /^\.tmp\/behavior-doc-contract-builds\/[a-f0-9]{64}$/u);
    assert.equal(fs.readFileSync(ambient, 'utf8'), '{"stale":true}\n');
    const projection = result.receipt.artifacts['openapi-aeds-observation'].buildReceipt;
    for (const file of [projection.openapiPath, projection.openapiArtifactPath])
    {
        assert.equal(digestPath(repositoryRoot, file), projection.openapiDigest);
        assert.equal(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'), '{"openapi":"unit-fixture"}\n');
    }
    assert.equal(projection.openapiPath, `${result.receipt.buildRoot}/observations/fsusblog.openapi.observed.json`);
    const countBeforeReuse = invocations.length;
    const reused = runMinimalContractBuild({
        repositoryRoot,
        runId: 'minimal-build-new-run',
        sourceIdentity: { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        spawn: fakeSpawn
    });
    assert.equal(reused.cacheHit, true);
    assert.equal(invocations.length, countBeforeReuse + 1);
    assert.equal(reused.identityReceiptFile, path.join(repositoryRoot, result.receipt.buildRoot, 'receipts/minimal-build-new-run.json'));
    assert.equal(reused.receipt.runId, 'minimal-build-new-run');
    assert.notEqual(reused.receipt.contentDigest, result.receipt.contentDigest);
    assert.deepEqual(reused.receipt.artifacts, result.receipt.artifacts);
    const writtenReceipt = JSON.parse(fs.readFileSync(reused.identityReceiptFile, 'utf8'));
    assert.deepEqual(writtenReceipt, reused.receipt);
    const noProjectionSpawn = (command, args) =>
    {
        const produced = fakeSpawn(command, args);
        if (args.includes(hostDeclarations['openapi-aeds-observation'].project))
        {
            fs.rmSync(path.join(path.dirname(args[args.indexOf('--output') + 1]), 'fsusblog.openapi.observed.json'));
        }
        return produced;
    };
    assert.throws(() => runMinimalContractBuild({
        repositoryRoot,
        runId: 'minimal-build-missing-projection',
        sourceIdentity: { sourceCommit: 'c'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        spawn: noProjectionSpawn
    }), /missing consumed input|ENOENT|missing input/u);
});

test('concurrent admission builds elect one publisher and reject a corrupted reusable build', async (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-concurrent-build');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    copyMinimalBuildFixture(repositoryRoot);

    const fakeBin = path.join(repositoryRoot, 'fake-bin');
    const activeRoot = path.join(repositoryRoot, 'fake-dotnet-active');
    const invocationLog = path.join(repositoryRoot, 'fake-dotnet.log');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(activeRoot);
    const fakeDotnet = path.join(fakeBin, 'dotnet');
    fs.writeFileSync(fakeDotnet, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '10.0.100\\n'
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  artifacts=""
  while (( $# > 0 )); do
    if [[ "$1" == "--artifacts-path" ]]; then
      artifacts="$2"
      shift 2
      continue
    fi
    shift
  done
  assembly="$artifacts/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll"
  mkdir -p "$(dirname "$assembly")"
  printf 'fixture-runtime-role-assembly' > "$assembly"
  exit 0
fi
output=""
deployment=""
artifacts=""
runtime="0"
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift 2
    continue
  fi
  if [[ "$1" == "--deployment-observation" ]]; then
    runtime="1"
    deployment="$2"
    shift 2
    continue
  fi
  if [[ "$1" == "--artifacts-path" ]]; then
    artifacts="$2"
    shift 2
    continue
  fi
  shift
done
[[ -n "$output" ]]
token="$$-\${RANDOM}"
active="\${FSUSBLOG_FAKE_DOTNET_ACTIVE}/\${token}"
printf 'start %s\\n' "$$" >> "\${FSUSBLOG_FAKE_DOTNET_LOG}"
touch "$active"
trap 'rm -f "$active"' EXIT
sleep 0.08
mkdir -p "$(dirname "$output")"
if [[ "$runtime" == "1" ]]; then
  node --input-type=module --eval '
    import fs from "node:fs";
    import { currentSchemaContractFixture, sealRuntimeRoleFixture } from "${pathToFileURL(path.join(root, 'tests/tools/support/runtime-role-current-schema-fixture.mjs')).href}";
    const deployment = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], JSON.stringify(sealRuntimeRoleFixture({
      schema: "fsusblog.runtime-role-observation.v3",
      modes: [], staticRoleCapabilities: {}, unsupportedCombinations: [], ownership: {},
      deploymentAuthority: {
        authoritySchema: deployment.authoritySchema,
        authorityContentDigest: deployment.authorityContentDigest,
        observationDigest: deployment.observationDigest,
        effectiveCompose: deployment.effectiveCompose
      },
      currentSchemaContract: currentSchemaContractFixture()
    })) + "\\n");
  ' "$deployment" "$output"
else
  printf '{"schema":"fixture"}\\n' > "$output"
  if [[ "$output" == */openapi-aeds-observation.json ]]; then
    printf '{"openapi":"unit-fixture"}\\n' > "$(dirname "$output")/fsusblog.openapi.observed.json"
  fi
fi
printf 'end %s\\n' "$$" >> "\${FSUSBLOG_FAKE_DOTNET_LOG}"
`);
    fs.chmodSync(fakeDotnet, 0o755);

    const moduleUrl = pathToFileURL(
        path.join(root, 'tools/docs/behavior-doc-minimal-contract-build.mjs')
    ).href;
    const workerSource = `
import { runMinimalContractBuild } from ${JSON.stringify(moduleUrl)}
const result = runMinimalContractBuild({
  repositoryRoot: process.argv[1],
  runId: process.argv[2],
  sourceIdentity: {
    sourceCommit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
  }
})
process.stdout.write(JSON.stringify({
  runId: result.receipt.runId,
  buildRoot: result.receipt.buildRoot,
  cacheHit: result.cacheHit,
  receipt: result.receipt
}))
`;
    const env = {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        FSUSBLOG_FAKE_DOTNET_ACTIVE: activeRoot,
        FSUSBLOG_FAKE_DOTNET_LOG: invocationLog
    };
    const startWorker = (runId) =>
    {
        const child = spawn(process.execPath, [
            '--input-type=module',
            '--eval',
            workerSource,
            repositoryRoot,
            runId
        ], {
            cwd: root,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return collectChild(child);
    };

    const [firstRaw, secondRaw] = await Promise.all([
        startWorker('concurrent-admission-a'),
        startWorker('concurrent-admission-b')
    ]);
    assert.equal(firstRaw.code, 0, firstRaw.stderr);
    assert.equal(secondRaw.code, 0, secondRaw.stderr);
    const first = JSON.parse(firstRaw.stdout);
    const second = JSON.parse(secondRaw.stdout);
    assert.deepEqual(
        [first.runId, second.runId].sort(),
        ['concurrent-admission-a', 'concurrent-admission-b']
    );
    assert.equal(first.buildRoot, second.buildRoot);
    assert.deepEqual([first.cacheHit, second.cacheHit].sort(), [false, true]);

    const hostCount = Object.keys(hostDeclarations).length;
    let logLines = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/u);
    assert.equal(logLines.filter((line) => line.startsWith('start ')).length, hostCount);
    assert.equal(logLines.filter((line) => line.startsWith('end ')).length, hostCount);
    assert.deepEqual(fs.readdirSync(activeRoot), []);

    const corruptedArtifact = Object.values(first.receipt.artifacts)[0];
    fs.writeFileSync(
        path.join(repositoryRoot, corruptedArtifact.path),
        '{"schema":"corrupted-old-build"}\n'
    );
    const repairedRaw = await startWorker('concurrent-admission-repair');
    assert.equal(repairedRaw.code, 0, repairedRaw.stderr);
    const repaired = JSON.parse(repairedRaw.stdout);
    assert.equal(repaired.cacheHit, false);
    assert.equal(repaired.runId, 'concurrent-admission-repair');
    logLines = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/u);
    assert.equal(logLines.filter((line) => line.startsWith('start ')).length, hostCount * 2);
    assert.equal(logLines.filter((line) => line.startsWith('end ')).length, hostCount * 2);
    assert.deepEqual(fs.readdirSync(activeRoot), []);

    const buildCache = path.join(repositoryRoot, '.tmp/behavior-doc-contract-builds');
    assert.deepEqual(fs.readdirSync(path.join(buildCache, '.locks')), []);
    assert.deepEqual(fs.readdirSync(path.join(buildCache, '.staging')), []);
});

test('failed admission blocks backend, service preheat and candidate output mutation', async (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-scheduler-block');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const candidateOutput = path.join(repositoryRoot, 'candidate-output');
    let candidateSpawnCount = 0;
    let servicePreheatCount = 0;
    let containerPreheatCount = 0;
    let browserSpawnCount = 0;
    const result = await runDag({
        tiers: [
            schedulerTier(behaviorDocStaticAdmissionTierId),
            schedulerTier('backend-candidate', {
                executionDependsOn: [behaviorDocStaticAdmissionTierId],
                services: ['postgres']
            }),
            schedulerTier('container-candidate', {
                executionDependsOn: [behaviorDocStaticAdmissionTierId],
                services: ['container-runtime']
            }),
            schedulerTier('browser-candidate', {
                executionDependsOn: [behaviorDocStaticAdmissionTierId]
            })
        ],
        root: repositoryRoot,
        runsRoot: path.join(repositoryRoot, 'runs'),
        runId: 'behavior-doc-blocked',
        mode: 'fresh',
        maxParallel: 2,
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async (tier) =>
        {
            if (tier.id === behaviorDocStaticAdmissionTierId)
            {
                return { code: 1, signal: null, reason: 'static admission failed' };
            }
            candidateSpawnCount += 1;
            servicePreheatCount += tier.services.length;
            if (tier.id === 'container-candidate')
            {
                containerPreheatCount += 1;
            }
            if (tier.id === 'browser-candidate')
            {
                browserSpawnCount += 1;
            }
            fs.mkdirSync(candidateOutput);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(candidateSpawnCount, 0);
    assert.equal(servicePreheatCount, 0);
    assert.equal(containerPreheatCount, 0);
    assert.equal(browserSpawnCount, 0);
    assert.equal(fs.existsSync(candidateOutput), false);
});

test('local production holds and releases capacity while admission fails before cleanup and outputs', async (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-local-preflight');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    let admissionCalls = 0;
    let reservationCalls = 0;
    let reservationReleases = 0;
    let reservationHeld = false;
    let cleanupCalls = 0;
    let containerRootProbes = 0;
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: true, resume: false, maxParallel: null },
            {
                root: repositoryRoot,
                productionFreshLeaseHeld: true,
                productionFreshLeaseOwner: {
                    ownerToken: 'behavior-doc-fixture-lease',
                    candidateIdentityDigest: `sha256:${'a'.repeat(64)}`
                },
                productionFreshSourceState: {
                    commit: 'a'.repeat(40),
                    worktreeFingerprint: `sha256:${'b'.repeat(64)}`
                },
                snapshotSourceState: async () => ({
                    commit: 'a'.repeat(40),
                    worktreeFingerprint: `sha256:${'b'.repeat(64)}`
                }),
                detectedResources: {
                    cpuCount: 8,
                    availableCpuUnits: 8,
                    availableMemoryGiB: 16,
                    load1: 0,
                    launchParallelism: 2,
                    memoryReserveGiB: 1
                },
                schedulerRunIdentity: () => ({
                    runsRoot: path.join(repositoryRoot, 'candidate-runs'),
                    runId: 'local-preflight'
                }),
                inspectProductionFreshCacheTransactions: () => [],
                resolveFilesystem: (candidate) => ({
                    filesystemIdentity: 'fixture:behavior-doc-capacity',
                    canonicalPath: path.resolve(candidate),
                    availableBytes: 128 * 1024 ** 3
                }),
                acquireProductionCapacityReservation: () =>
                {
                    reservationCalls += 1;
                    reservationHeld = true;
                    return {
                        guardProducer: () => assert.equal(reservationHeld, true),
                        completeProducer: () => assert.fail('failed admission cannot complete its producer'),
                        assertPlan: () =>
                        {},
                        release: () =>
                        {
                            reservationReleases += 1;
                            reservationHeld = false;
                        }
                    };
                },
                runBehaviorDocStaticAdmission: async () =>
                {
                    admissionCalls += 1;
                    assert.equal(reservationHeld, true);
                    fs.mkdirSync(path.join(
                        repositoryRoot,
                        '.tmp/behavior-doc-contract-builds/admission-only'
                    ), { recursive: true });
                    fs.mkdirSync(path.join(
                        repositoryRoot,
                        '.tmp/behavior-doc-static-admission'
                    ), { recursive: true });
                    throw new Error('BehaviorDoc static admission failed');
                },
                cleanLocalProductionOutputs: () =>
                {
                    cleanupCalls += 1;
                    return {};
                },
                resolveDockerRoot: () =>
                {
                    containerRootProbes += 1;
                    return path.join(repositoryRoot, 'candidate-container-root');
                }
            }
        ),
        /BehaviorDoc static admission failed/u
    );
    assert.equal(admissionCalls, 1);
    assert.equal(reservationCalls, 1);
    assert.equal(reservationReleases, 1);
    assert.equal(reservationHeld, false);
    assert.equal(cleanupCalls, 0);
    assert.equal(containerRootProbes, 1);
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'candidate-runs')), false);
    assert.equal(fs.existsSync(path.join(repositoryRoot, '.tmp/local-production')), false);
    assert.equal(fs.existsSync(
        path.join(repositoryRoot, '.tmp/behavior-doc-contract-builds/admission-only')
    ), true);
    assert.equal(fs.existsSync(
        path.join(repositoryRoot, '.tmp/behavior-doc-static-admission')
    ), true);
});

test('matrix validation binds scheduler identity while plan-only paths never establish admission', (t) =>
{
    const directory = tempDirectory('behavior-doc-pure-plan');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const matrixFile = path.join(directory, 'matrix.yml');
    const marker = path.join(directory, 'dotnet-invoked');
    const deniedIdentityEvidence = path.join(directory, 'identity-evidence.jsonl');
    const inventoryEvidenceDirectory = path.join(
        root,
        '.tmp/behavior-doc-static-admission-fixtures',
        path.basename(directory)
    );
    const identityEvidence = path.join(
        inventoryEvidenceDirectory,
        'identity',
        'identity-evidence.jsonl'
    );
    const inventoryEvidence = path.join(
        inventoryEvidenceDirectory,
        'inventory',
        'inventory-evidence.json'
    );
    const identityEvidenceRelative = path.relative(root, identityEvidence).replaceAll('\\', '/');
    const inventoryEvidenceRelative = path.relative(root, inventoryEvidence).replaceAll('\\', '/');
    const identityProbe = path.join(directory, 'identity-probe.mjs');
    const inventoryProbe = path.join(directory, 'inventory-probe.mjs');
    t.after(() => fs.rmSync(inventoryEvidenceDirectory, { recursive: true, force: true }));
    fs.writeFileSync(identityProbe, [
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        'const identity = {',
        '    runId: process.env.FSUSBLOG_TEST_RUN_ID,',
        '    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,',
        '    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT',
        '};',
        'if (!identity.runId || !identity.commit || !identity.worktreeFingerprint)',
        '{',
        "    throw new Error('matrix prerequisite identity is incomplete');",
        '}',
        'assert.throws(',
        `    () => fs.appendFileSync(${JSON.stringify(deniedIdentityEvidence)}, 'undeclared'),`,
        "    (error) => ['EACCES', 'EROFS'].includes(error?.code)",
        ');',
        `fs.appendFileSync(${JSON.stringify(identityEvidence)}, \`\${JSON.stringify(identity)}\\n\`);`,
        "fs.mkdirSync('.tmp/release-evidence', { recursive: true });",
        "fs.writeFileSync('.tmp/release-evidence/test-plan.json',",
        '    `${JSON.stringify({ schedulerRunId: identity.runId })}\\n`);'
    ].join('\n'));
    fs.writeFileSync(inventoryProbe, [
        "import fs from 'node:fs';",
        'const identity = {',
        '    runId: process.env.FSUSBLOG_TEST_RUN_ID,',
        '    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,',
        '    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT',
        '};',
        'if (!identity.runId || !identity.commit || !identity.worktreeFingerprint)',
        '{',
        "    throw new Error('test inventory identity is incomplete');",
        '}',
        `fs.mkdirSync(${JSON.stringify(path.dirname(inventoryEvidence))}, { recursive: true });`,
        `fs.writeFileSync(${JSON.stringify(inventoryEvidence)}, \`\${JSON.stringify(identity)}\\n\`);`
    ].join('\n'));
    const fakeBin = path.join(directory, 'bin');
    fs.mkdirSync(fakeBin);
    const dotnet = path.join(fakeBin, process.platform === 'win32' ? 'dotnet.cmd' : 'dotnet');
    fs.writeFileSync(dotnet, process.platform === 'win32'
        ? `@echo invoked>${marker}\r\n@exit /b 97\r\n`
        : `#!/usr/bin/env bash\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`);
    fs.chmodSync(dotnet, 0o755);
    const guardedPath = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    const producerCommand = [
        JSON.stringify(process.execPath),
        'tools/test/run-deterministic-command.mjs',
        '--key matrix-governance',
        '--execution-class correctness',
        '--producer-id validate-matrix',
        '--consumer validate-matrix',
        `--cwd ${JSON.stringify(root)}`,
        '--projection-directory .tmp/physical-execution-projections',
        '--path tools/test/run-deterministic-command.mjs',
        '--output .tmp/release-evidence/test-plan.json',
        `--output ${JSON.stringify(identityEvidenceRelative)}`,
        '--test-id matrix-validate',
        '--',
        JSON.stringify(process.execPath),
        JSON.stringify(identityProbe)
    ].join(' ');
    const matrixSource = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
        .replace(
            'command: tools/test/run-matrix-governance-once.sh validate-matrix',
            `command: ${JSON.stringify(producerCommand)}`
        )
        .replace(
            'command: tools/test/lanes/test-inventory.sh',
            `command: ${JSON.stringify(`${process.execPath} ${inventoryProbe}`)}`
        )
        .replaceAll('.tmp/release-evidence/test-inventory.json', inventoryEvidenceRelative);
    fs.writeFileSync(matrixFile, matrixSource);
    const env = {
        ...process.env,
        FSUSBLOG_MATRIX_FILE: matrixFile,
        FSUSBLOG_TEST_RUN_ID: '',
        FSUSBLOG_TEST_SOURCE_COMMIT: '',
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: '',
        PATH: guardedPath
    };
    const validate = spawnSync(process.execPath, [
        'tools/run-test-matrix.mjs',
        'ci-tier',
        'validate-matrix',
        '--no-deps'
    ], {
        cwd: root,
        encoding: 'utf8',
        env,
        timeout: 30_000
    });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(fs.existsSync(marker), false);

    const validateJob = spawnSync(process.execPath, [
        'tools/run-test-matrix.mjs',
        'ci-job',
        'validate-matrix',
        '--fresh'
    ], {
        cwd: root,
        encoding: 'utf8',
        env,
        timeout: 30_000
    });
    assert.equal(validateJob.status, 0, validateJob.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(JSON.parse(fs.readFileSync(inventoryEvidence, 'utf8')).runId.length > 0, true);
    const identities = fs.readFileSync(identityEvidence, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(identities.length, 2);
    for (const identity of identities)
    {
        assert.ok(identity.runId);
        assert.match(identity.commit, /^[a-f0-9]{40}$/u);
        assert.match(identity.worktreeFingerprint, /^(?:sha256:)?[a-f0-9]{64}$/u);
    }
    assert.equal(fs.existsSync(deniedIdentityEvidence), false);

    const plan = spawnSync(process.execPath, [
        'tools/run-test-matrix.mjs',
        'ci-tier',
        'frontend-build',
        '--plan-only'
    ], {
        cwd: root,
        encoding: 'utf8',
        env,
        timeout: 30_000
    });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(fs.existsSync(marker), false);
});

test('nested runners consume the pinned admission receipt instead of regenerating it', async (t) =>
{
    const directory = tempDirectory('behavior-doc-consume-existing');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = sealSourceIdentity(root);
    const receipt = validAdmissionReceipt({
        runId: 'consume-existing',
        source,
        worktree: root
    });
    const receiptFile = path.join(directory, 'receipt.json');
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
    const previous = {
        receipt: process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT,
        digest: process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST,
        runId: process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID
    };
    t.after(() =>
    {
        for (const [key, value] of Object.entries({
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: previous.receipt,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: previous.digest,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: previous.runId
        }))
        {
            if (value === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = value;
            }
        }
    });
    process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT = receiptFile;
    process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST = receipt.contentDigest;
    process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID = receipt.run.id;

    const state = await establishBehaviorDocAdmission({
        repositoryRoot: root,
        runId: 'different-fallback-run-id'
    });
    assert.equal(state.receiptFile, receiptFile);
    assert.equal(state.runId, receipt.run.id);
    assert.equal(state.contentDigest, receipt.contentDigest);

    process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST = '0'.repeat(64);
    await assert.rejects(
        establishBehaviorDocAdmission({
            repositoryRoot: root,
            runId: 'different-fallback-run-id'
        }),
        /existing BehaviorDoc admission receipt digest mismatch/u
    );
});

test('shared testing policy and affected backend source retain admission; ordinary documents do not claim qualification', async () =>
{
    const { selectAffectedPrTiers } = await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const executionAuthority = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/test-matrix/release-final-execution-target-authority.json'), 'utf8'));
    for (const changedPath of ['docs/testing.md', 'src/backend/Program.cs'])
    {
        const plan = selectAffectedPrTiers(matrix, [changedPath], { executionAuthority });
        assert.ok(plan.selectedTierIds.includes(behaviorDocStaticAdmissionTierId), changedPath);
    }
    const sourceOnly = selectAffectedPrTiers(matrix, ['docs/unindexed-ordinary-note.md'], { executionAuthority });
    assert.equal(sourceOnly.selectedTierIds.includes(behaviorDocStaticAdmissionTierId), false);
    assert.ok(sourceOnly.selectedTierIds.includes('source-governance'));
});

test('package scripts cannot expose a direct BehaviorDoc bypass', (t) =>
{
    const repositoryRoot = tempDirectory('behavior-doc-package-bypass');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(repositoryRoot, 'package.json'), JSON.stringify({
        scripts: {
            'check:docs-direct': 'node tools/docs/behavior-doc-static-admission.mjs'
        }
    }));
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const errors = validateBehaviorDocStaticAdmissionMatrix(matrix, { repositoryRoot });
    assert.ok(errors.some((error) => /package\.json script check:docs-direct bypasses/u.test(error)));
});

test('protected admission reads the original receipt API with exact run, source and worktree expectations', (t) =>
{
    // Sealed unit fixture only: this tests reader wiring, not actual SDK or physical execution.
    const directory = tempDirectory('protected-admission-reader');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const receiptFile = path.join(directory, 'receipt.json');
    const source = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const runId = 'protected-admission-reader';
    fs.writeFileSync(receiptFile, JSON.stringify(validAdmissionReceipt({ source, runId, worktree: root })));
    const read = (overrides = {}) => readProtectedBehaviorDocAdmissionReceipt({
        receiptFile, runId, source, repositoryRoot: root, ...overrides
    });
    assert.equal(read().status, 'ok');
    assert.throws(() => read({ runId: 'foreign-run' }));
    assert.throws(() => read({ source: { ...source, sourceCommit: 'c'.repeat(40) } }));
    assert.throws(() => read({ source: { ...source, worktreeFingerprint: 'd'.repeat(64) } }));
    assert.throws(() => read({ repositoryRoot: directory }));
});

test('protected runner remains asynchronous and forwards cancellation before awaiting close', async () =>
{
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    const cancellations = [];
    child.kill = (signal) =>
    {
        cancellations.push(signal);
        return true;
    };
    const controller = new AbortController();
    const pending = waitProtectedBehaviorDocRunner('fixture', [], {}, {
        signal: controller.signal, spawn: () => child
    });
    let settled = false;
    const observed = pending.then(() =>
    {
        settled = true;
    }, (error) =>
    {
        settled = true;
        return error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const cancellationReason = new Error('fixture cancellation');
    controller.abort(cancellationReason);
    assert.deepEqual(cancellations, ['SIGTERM']);
    assert.equal(settled, false);
    child.emit('exit', 1, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    child.emit('close', 1, 'SIGTERM');
    const failure = await observed;
    assert.match(failure.message, /cancelled/u);
    assert.equal(failure.name, 'AbortError');
    assert.equal(failure.cause, cancellationReason);
});

test('protected runner accepts close zero and refuses launch errors or nonzero terminal', async () =>
{
    const { EventEmitter } = await import('node:events');
    for (const mode of ['success', 'failure', 'launch-error'])
    {
        const child = new EventEmitter();
        child.kill = () => true;
        const result = waitProtectedBehaviorDocRunner('fixture', [], {}, { spawn: () => child });
        const observed = result.then(() => null, (error) => error);
        if (mode === 'launch-error')
        {
            child.emit('error', new Error('launch-canary'));
        }
        child.emit('close', mode === 'success' ? 0 : 1, null);
        const error = await observed;
        if (mode === 'success')
        {
            assert.equal(error, null);
        }
        else
        {
            assert.ok(error instanceof Error);
        }
    }
});
