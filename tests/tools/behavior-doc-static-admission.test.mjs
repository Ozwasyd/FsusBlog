import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { parseWorkflow, validateBehaviorDocStaticAdmissionTopology } = await import(new URL("../../tools/check-workflow-matrix-sync.mjs", import.meta.url));
const { hostDeclarations, runMinimalContractBuild } = await import(new URL("../../tools/docs/behavior-doc-minimal-contract-build.mjs", import.meta.url));
const { behaviorDocAdmissionReceiptSchema, validateBehaviorDocStaticAdmissionReceipt } = await import(new URL("../../tools/docs/behavior-doc-static-admission.mjs", import.meta.url));
const { digestValue, sealSourceIdentity } = await import(new URL("../../tools/fact-extractors/identity.mjs", import.meta.url));
const { loadRegistry } = await import(new URL("../../tools/fact-extractors/registry.mjs", import.meta.url));
const { establishBehaviorDocAdmission, runLocalProfile } = await import(new URL("../../tools/run-test-matrix.mjs", import.meta.url));
const { behaviorDocStaticAdmissionTierId, localBehaviorDocCandidateBundleIds, validateBehaviorDocStaticAdmissionMatrix } = await import(new URL("../../tools/test-matrix/behavior-doc-static-admission-contract.mjs", import.meta.url));
const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));
const { runDag } = await import(new URL("../../tools/test-matrix/scheduler.mjs", import.meta.url));
const { validateJsonSchema } = await import(new URL("../../tools/test-matrix/schema-validator/validate.mjs", import.meta.url));

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

function fakeMinimalReceipt(runId, source)
{
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
        buildRoot: `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`,
        sourceClosureDigests: [
            {
                path: 'Directory.Build.props',
                digest: 'e'.repeat(64)
            }
        ],
        artifacts: Object.fromEntries(Object.entries(hostDeclarations).map(([artifactId, declaration]) => [
            artifactId,
            {
                project: declaration.project,
                projectDigest: 'c'.repeat(64),
                path: path.posix.join(
                    `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`,
                    declaration.cacheFile
                ),
                artifactDigest: 'd'.repeat(64)
            }
        ])),
        status: 'ok',
        failureReasons: []
    });
}

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
        'Directory.Build.props',
        'FsusBlog.slnx',
        'src/backend/FsusBlog.Server.csproj',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj',
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
        fs.copyFileSync(source, destination);
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

test('matrix and workflow declare one unconditional fixture-free admission before every candidate', () =>
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
        'needs: [validate-matrix, behavior-doc-static-admission]\n        timeout-minutes: 45',
        'needs: validate-matrix\n        timeout-minutes: 45'
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
        const separator = args.indexOf('--');
        const outputIndex = args.indexOf('--output', separator);
        assert.ok(separator > 0 && outputIndex > separator);
        assert.ok(args.includes('--artifacts-path'));
        assert.equal(args.includes('--no-build'), false);
        assert.equal(args.some((value) => String(value).includes('/bin/Release/')), false);
        fs.mkdirSync(path.dirname(args[outputIndex + 1]), { recursive: true });
        fs.writeFileSync(args[outputIndex + 1], '{"schema":"fixture"}\n');
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
    assert.equal(invocations.filter((args) => args[1] === 'run').length, 4);
    assert.match(result.receipt.buildRoot, /^\.tmp\/behavior-doc-contract-builds\/[a-f0-9]{64}$/u);
    assert.equal(fs.readFileSync(ambient, 'utf8'), '{"stale":true}\n');
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
output=""
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    break
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
printf '{"schema":"fixture"}\\n' > "$output"
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

    let logLines = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/u);
    assert.equal(logLines.filter((line) => line.startsWith('start ')).length, 4);
    assert.equal(logLines.filter((line) => line.startsWith('end ')).length, 4);
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
    assert.equal(logLines.filter((line) => line.startsWith('start ')).length, 8);
    assert.equal(logLines.filter((line) => line.startsWith('end ')).length, 8);
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

test('docs-only and source-only PR plans always select the admission tier', (t) =>
{
    const directory = path.join(root, '.tmp', `behavior-doc-smart-gate-${process.pid}`);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const [label, changedPath] of [
        ['docs', 'docs/testing.md'],
        ['source', 'src/backend/Program.cs']
    ])
    {
        const changedFile = path.join(directory, `${label}.txt`);
        const outputFile = path.join(directory, `${label}.json`);
        fs.writeFileSync(changedFile, `${changedPath}\n`);
        const result = spawnSync(process.execPath, [
            'tools/run-test-matrix.mjs',
            'ci-pr-plan',
            '--changed-files', path.relative(root, changedFile),
            '--event-name', 'pull_request',
            '--out', path.relative(root, outputFile)
        ], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000
        });
        assert.equal(result.status, 0, result.stderr);
        const plan = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.ok(plan.selectedTierIds.includes(behaviorDocStaticAdmissionTierId), label);
    }
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
