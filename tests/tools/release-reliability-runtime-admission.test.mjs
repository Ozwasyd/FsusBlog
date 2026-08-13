import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(root, 'tools/test/run-release-reliability-qualified-local.sh');
const admissionTool = path.join(
    root,
    'tools/test/release-reliability-runtime-admission.mjs'
);
const {
    createRuntimeAdmissionCandidate,
    finalizeRuntimeAdmissionReceipt,
    releaseReliabilityRuntimeAdmissionSchema,
    verifyRuntimeAdmissionCandidate,
    verifyRuntimeAdmissionReceipt
} = await import(pathToFileURL(admissionTool).href);
const {
    digestValue
} = await import(pathToFileURL(path.join(
    root,
    'tools/test/release-reliability-receipt.mjs'
)).href);
const {
    producerRouteIds,
    routeCatalogDigest,
    routeContract
} = await import(pathToFileURL(path.join(
    root,
    'tools/test/lanes/runtime-http-route-contract.mjs'
)).href);

const commit = 'a'.repeat(40);
const fingerprint = `sha256:${'b'.repeat(64)}`;
const imageDigest = `sha256:${'c'.repeat(64)}`;
const layer = `sha256:${'d'.repeat(64)}`;
const runId = 'admission-run';
const namespace = 'admission-namespace';
const invocationId = 'admission-invocation';
const backendId = '1'.repeat(64);
const postgresId = '2'.repeat(64);
const redisId = '3'.repeat(64);
const networkId = '4'.repeat(64);
const imageReference = 'fsusblog:admission';
const candidatePath =
    `.tmp/release-reliability/${invocationId}/runtime-admission-candidate.json`;
const receiptPath =
    `.tmp/release-reliability/${invocationId}/runtime-admission-receipt.json`;
const smokePath =
    `.tmp/release-reliability/${invocationId}/runtime-smoke-observation.json`;
const buildPath = `.tmp/ci-production-build/${runId}/receipt.json`;
const fixturePath = `.tmp/release-reliability/${runId}/fixture-authority.json`;

function seal(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = digestValue(sealed);
    return sealed;
}

function writeJson(repositoryRoot, relative, value)
{
    const file = path.join(repositoryRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
}

function smokeObservation(checkedAt = '2026-07-31T00:04:22.648Z')
{
    const routes = producerRouteIds('runtime-load-soak').map((routeId) =>
    {
        const contract = routeContract(routeId);
        return {
            routeId,
            method: contract.method,
            path: contract.pathTemplate,
            status: contract.expectedStatus,
            contentType: 'application/octet-stream',
            fsusHeaders: { 'x-fsus-frame-version': '2' },
            bodyBytes: 20,
            aeds: {
                version: 2,
                headerLength: 16,
                frameType: contract.expectedAedsFrameType,
                payloadLength: 4,
                crcValidated: true
            }
        };
    });
    return seal({
        schema: 'fsusblog.release-reliability-runtime-smoke.v1',
        status: 'passed',
        producer: {
            id: 'runtime-load-soak',
            routeCatalog: {
                path: 'config/testing/runtime-http-route-contracts.json',
                contentDigest: routeCatalogDigest()
            }
        },
        live: {
            method: 'GET',
            path: '/health/live',
            status: 200,
            contentType: 'application/json',
            bodyBytes: 56,
            reportStatus: 'live',
            checkedAt
        },
        routes,
        contentDigest: null
    });
}

function fixtureAuthority()
{
    return seal({
        schema: 'fsusblog.release-reliability-runtime-topology.v1',
        status: 'complete',
        runId,
        namespace,
        root: `.tmp/fixtures/${namespace}`,
        runtime: {
            profile: 'docker-final-image',
            imageDigest,
            sourceState: {
                commit,
                worktreeFingerprint: fingerprint
            },
            image: {
                reference: imageReference,
                id: imageDigest,
                revision: commit,
                layers: [layer],
                layersDigest: digestValue({ layers: [layer] })
            },
            backendContainer: {
                id: backendId,
                image: imageDigest,
                configuredImage: imageReference
            },
            network: {
                id: networkId,
                name: `fsusblog-test-network-${namespace}`,
                driver: 'bridge',
                backend: { containerId: backendId },
                postgres: { containerId: postgresId },
                redis: { containerId: redisId }
            }
        },
        postgres: { instance: postgresId },
        redis: { instance: redisId },
        contentDigest: null
    });
}

function cleanupOwnership()
{
    const processes = [
        ['backend', 'backend.pid', 101],
        ['debug-frontend', 'dev-server.pid', 102],
        ['release-preview', 'preview.pid', 103]
    ].map(([role, file, pid]) => ({
        kind: 'process',
        role,
        pid,
        processGroupId: pid,
        startTimeTicks: String(pid * 10),
        pidFile: `.tmp/acceptance/${namespace}/${file}`,
        identityFile:
            `.tmp/acceptance/${namespace}/${file.replace(/\.pid$/u, '.identity.json')}`
    }));
    return {
        owner: 'CleanupQualifiedRuntimeResources',
        status: 'pending',
        resources: {
            containers: [
                { kind: 'container', role: 'backend', id: backendId },
                { kind: 'container', role: 'postgres', id: postgresId },
                { kind: 'container', role: 'redis', id: redisId }
            ],
            network: {
                kind: 'network',
                id: networkId,
                name: `fsusblog-test-network-${namespace}`
            },
            processes,
            files: [
                ...processes.flatMap((managed) => [
                    {
                        kind: 'file',
                        path: managed.pidFile,
                        fileDigest: `sha256:${'5'.repeat(64)}`
                    },
                    {
                        kind: 'file',
                        path: managed.identityFile,
                        fileDigest: `sha256:${'6'.repeat(64)}`
                    }
                ]),
                {
                    kind: 'file',
                    path: `.tmp/env/${namespace}.${runId}.container.env`,
                    fileDigest: `sha256:${'7'.repeat(64)}`
                }
            ]
        }
    };
}

function createFixture(context, options = {})
{
    const repositoryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-runtime-admission-')
    );
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const build = seal({
        schema: 'fsusblog.ci-production-build-receipt.v1',
        status: 'complete',
        sourceState: {
            commit,
            worktreeFingerprint: fingerprint
        },
        producer: {
            workflow: 'Local production',
            runId,
            runAttempt: 1,
            job: 'production-build-artifacts'
        },
        contentDigest: null
    });
    writeJson(repositoryRoot, buildPath, build);
    writeJson(repositoryRoot, fixturePath, fixtureAuthority());
    writeJson(
        repositoryRoot,
        smokePath,
        smokeObservation(options.smokeCheckedAt)
    );
    const candidate = createRuntimeAdmissionCandidate({
        repositoryRoot,
        candidatePath,
        sourceCommit: commit,
        sourceFingerprint: fingerprint,
        buildReceiptPath: buildPath,
        buildReceiptContentDigest: build.contentDigest,
        imageReference,
        imageDigest,
        runId,
        namespace,
        invocationId,
        fixtureAuthorityPath: fixturePath,
        smokeObservationPath: smokePath,
        deadlineSeconds: 60,
        attemptCount: 2,
        elapsedSeconds: 3,
        cleanupOwnership: cleanupOwnership(),
        createdAt: options.createdAt ?? '2026-07-31T00:00:01.000Z'
    }, {
        inspectImage()
        {
            return {
                Id: imageDigest,
                Config: {
                    Labels: { 'org.opencontainers.image.revision': commit }
                },
                RootFS: { Layers: [layer] }
            };
        }
    });
    return { repositoryRoot, build, candidate };
}

function rewriteSealed(repositoryRoot, relative, mutate)
{
    const file = path.join(repositoryRoot, relative);
    fs.chmodSync(file, 0o600);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(value);
    value.contentDigest = digestValue(value);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return value;
}

test('qualified local wrapper exposes one bounded runtime-admission-only exit', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const branch = source.indexOf('if ((runtime_admission_only == 1)); then');
    const scenarioRunner = source.indexOf('run-release-reliability-scenarios.mjs');
    const branchEnd = source.indexOf('    exit 0\nfi', branch)
        + '    exit 0\nfi'.length;
    assert.match(source, /--runtime-admission-only/u);
    assert.match(
        source,
        /if \(\(runtime_admission_only == 1\)\); then[\s\S]*runtimeScope=\(FSUSBLOG_BOOTSTRAP_RUNTIME_SCOPE=backend-only\)/u
    );
    assert.match(
        source,
        /if \(\(runtime_admission_only == 0\)\); then[\s\S]*ManagedRuntimeOwned "\$managed_dev_pid_file"[\s\S]*ManagedRuntimeOwned "\$managed_preview_pid_file"/u
    );
    assert.ok(branch >= 0 && branchEnd > branch && branchEnd < scenarioRunner);
    const bounded = source.slice(branch, branchEnd);
    assert.match(bounded, /runtime-admission-candidate\.json/u);
    assert.match(bounded, /runtime-admission-receipt\.json/u);
    assert.match(bounded, /trap - EXIT[\s\S]*CleanupQualifiedRuntimeResources 0/u);
    assert.match(bounded, /finalize[\s\S]*verify[\s\S]*exit 0/u);
    assert.doesNotMatch(bounded, /run-release-reliability-scenarios\.mjs/u);
    assert.equal(
        source.slice(branchEnd).match(/run-release-reliability-scenarios\.mjs/gu)
            ?.length,
        1
    );
});

test('runtime admission candidate is independently sealed and ineligible', (context) =>
{
    const fixture = createFixture(context);
    assert.equal(
        releaseReliabilityRuntimeAdmissionSchema,
        'fsusblog.release-reliability.runtime-admission.v1'
    );
    assert.equal(fixture.candidate.schema, releaseReliabilityRuntimeAdmissionSchema);
    assert.equal(fixture.candidate.artifactKind, 'candidate');
    assert.equal(fixture.candidate.qualificationEligible, false);
    assert.equal(fixture.candidate.admission.deadline.seconds, 60);
    assert.equal(fixture.candidate.admission.routes.length, 6);
    assert.equal(fixture.candidate.cleanup.status, 'pending');
    assert.deepEqual(
        verifyRuntimeAdmissionCandidate({
            repositoryRoot: fixture.repositoryRoot,
            candidatePath
        }),
        fixture.candidate
    );
    assert.equal(
        fs.existsSync(path.join(
            fixture.repositoryRoot,
            `.tmp/release-reliability/${invocationId}/candidate-receipt.json`
        )),
        false
    );
});

test('runtime admission accepts canonical smoke time while keeping every artifact timestamp strict', async (context) =>
{
    const fixture = createFixture(context);
    assert.equal(
        fixture.candidate.admission.live.checkedAt,
        '2026-07-31T00:04:22.648Z'
    );

    await context.test('noncanonical smoke timestamp', (subtest) =>
    {
        assert.throws(
            () => createFixture(subtest, {
                smokeCheckedAt: '2026-07-31T00:04:22.6481393+00:00'
            }),
            /runtime live evidence is invalid/u
        );
    });

    await context.test('noncanonical candidate createdAt', (subtest) =>
    {
        assert.throws(
            () => createFixture(subtest, {
                createdAt: '2026-07-31T00:00:01+00:00'
            }),
            /runtime admission candidate envelope is invalid/u
        );
    });

    await context.test('noncanonical receipt finalizedAt', (subtest) =>
    {
        const receiptFixture = createFixture(subtest);
        assert.throws(
            () => finalizeRuntimeAdmissionReceipt({
                repositoryRoot: receiptFixture.repositoryRoot,
                candidatePath,
                receiptPath,
                finalizedAt: '2026-07-31T00:00:02+00:00'
            }, {
                resourceExists: () => false
            }),
            /runtime admission receipt envelope is invalid/u
        );
    });
});

test('runtime admission finalizes only after every owned identity is absent', (context) =>
{
    const fixture = createFixture(context);
    const receipt = finalizeRuntimeAdmissionReceipt({
        repositoryRoot: fixture.repositoryRoot,
        candidatePath,
        receiptPath,
        finalizedAt: '2026-07-31T00:00:02.000Z'
    }, {
        resourceExists: () => false
    });
    assert.equal(receipt.artifactKind, 'receipt');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.qualificationEligible, false);
    assert.equal(receipt.cleanup.status, 'complete');
    assert.equal(receipt.candidate.contentDigest, fixture.candidate.contentDigest);
    assert.deepEqual(
        verifyRuntimeAdmissionReceipt({
            repositoryRoot: fixture.repositoryRoot,
            receiptPath
        }, {
            resourceExists: () => false
        }),
        receipt
    );
});

test('runtime admission refuses cleanup residue and creates no pass receipt', async (context) =>
{
    for (const kind of ['container', 'network', 'process', 'file'])
    {
        await context.test(kind, (subtest) =>
        {
            const fixture = createFixture(subtest);
            assert.throws(
                () => finalizeRuntimeAdmissionReceipt({
                    repositoryRoot: fixture.repositoryRoot,
                    candidatePath,
                    receiptPath
                }, {
                    resourceExists: (_repositoryRoot, resource) =>
                        resource.kind === kind
                }),
                /cleanup left owned resources/u
            );
            assert.equal(
                fs.existsSync(path.join(fixture.repositoryRoot, receiptPath)),
                false
            );
        });
    }
});

test('runtime admission removes a pass receipt if owned resources reappear during final verification', (context) =>
{
    const fixture = createFixture(context);
    const resourceCount = 14;
    let observations = 0;
    assert.throws(
        () => finalizeRuntimeAdmissionReceipt({
            repositoryRoot: fixture.repositoryRoot,
            candidatePath,
            receiptPath,
            finalizedAt: '2026-07-31T00:00:02.000Z'
        }, {
            resourceExists()
            {
                observations += 1;
                return observations > resourceCount;
            }
        }),
        /cleanup left owned resources/u
    );
    assert.equal(
        fs.existsSync(path.join(fixture.repositoryRoot, receiptPath)),
        false
    );
});

test('runtime admission rejects source, build, image, run, fixture, topology, and route tamper', async (context) =>
{
    const cases = [
        ['source commit', (candidate) =>
        {
            candidate.source.commit = 'e'.repeat(40);
        }],
        ['source fingerprint', (candidate) =>
        {
            candidate.source.worktreeFingerprint = `sha256:${'e'.repeat(64)}`;
        }],
        ['build receipt', (candidate) =>
        {
            candidate.build.receipt.contentDigest = `sha256:${'e'.repeat(64)}`;
        }],
        ['image', (candidate) =>
        {
            candidate.build.image.imageDigest = `sha256:${'e'.repeat(64)}`;
        }],
        ['run', (candidate) =>
        {
            candidate.runId = 'tampered-run';
        }],
        ['namespace', (candidate) =>
        {
            candidate.namespace = 'tampered-namespace';
        }],
        ['invocation', (candidate) =>
        {
            candidate.invocationId = 'tampered-invocation';
        }],
        ['fixture', (candidate) =>
        {
            candidate.fixture.contentDigest = `sha256:${'e'.repeat(64)}`;
        }],
        ['fixture identity', (candidate) =>
        {
            candidate.fixture.identity.root = '.tmp/fixtures/tampered';
        }],
        ['topology', (candidate) =>
        {
            candidate.topology.network.id = 'e'.repeat(64);
        }],
        ['route', (candidate) =>
        {
            candidate.admission.routes[0].aeds.crcValidated = false;
        }]
    ];
    for (const [name, mutate] of cases)
    {
        await context.test(name, (subtest) =>
        {
            const fixture = createFixture(subtest);
            rewriteSealed(fixture.repositoryRoot, candidatePath, mutate);
            assert.throws(
                () => verifyRuntimeAdmissionCandidate({
                    repositoryRoot: fixture.repositoryRoot,
                    candidatePath
                }),
                /invalid|mismatch|canonical|digest/u
            );
        });
    }
});

test('runtime admission rejects candidate-final mismatch after cleanup', (context) =>
{
    const fixture = createFixture(context);
    finalizeRuntimeAdmissionReceipt({
        repositoryRoot: fixture.repositoryRoot,
        candidatePath,
        receiptPath,
        finalizedAt: '2026-07-31T00:00:02.000Z'
    }, {
        resourceExists: () => false
    });
    rewriteSealed(fixture.repositoryRoot, receiptPath, (receipt) =>
    {
        receipt.candidate.fileDigest = `sha256:${'e'.repeat(64)}`;
    });
    assert.throws(
        () => verifyRuntimeAdmissionReceipt({
            repositoryRoot: fixture.repositoryRoot,
            receiptPath
        }, {
            resourceExists: () => false
        }),
        /candidate-final binding mismatch/u
    );
});
