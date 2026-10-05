import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {fileBackedCleanAttemptEvidence} = await import(new URL('../../tools/release/clean-first-attempt-verifier.mjs', import.meta.url));
const {admitCleanAttemptCohort, appendCleanAttemptCohortSlot, createCleanAttemptCohort, persistCleanAttemptCohortRevision, validateCleanAttemptCohort} = await import(new URL('../../tools/release/release-clean-attempt-cohort.mjs', import.meta.url));
const {sealContentDigest, sha256} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {runProducerAttempts} = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const {requiredCleanAttemptCohortMembers, verifyCleanAttemptCohortManifest} = await import(new URL('../../tools/release/release-clean-attempt-cohort.mjs', import.meta.url));
import { createCleanAttemptEvidenceFixture, writeCleanAttemptEvidenceFixtureSource } from './support/clean-attempt-evidence-fixture.mjs';
const { createProductionBuildReceipt } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const { archiveCleanAttemptCohortInputs } = await import(new URL('../../tools/release/release-clean-attempt-cohort.mjs', import.meta.url));
const { readCleanAttemptEvidenceSource } = await import(new URL('../../tools/release/clean-attempt-evidence-source.mjs', import.meta.url));
const { requiredEvidenceAuthoritiesForContext, checkRequiredEvidenceCatalog } = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const { loadCanonicalReleaseFinalEvidenceInputs } = await import(new URL('../../tools/test-matrix/release-final-evidence-contract.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const commandFixture = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const buildIdentity = `sha256:${'9'.repeat(64)}`;

test('release-final roster follows its canonical context, not an all-context authority union', () =>
{
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const entries = checkRequiredEvidenceCatalog();
    const unrelated = { authorityId: 'foreign-context-only', canonicalOwner: 'foreign-context-producer',
        producerTierIds: ['foreign-context-tier'], allowDiagnostic: false };
    assert.deepEqual(requiredEvidenceAuthoritiesForContext(canonical, [...entries, unrelated]), entries);
    for (const entry of entries)
    {
        assert.throws(() => requiredEvidenceAuthoritiesForContext(canonical,
            entries.filter((candidate) => candidate !== entry)), /missing required authority families/u);
    }
    assert.throws(() => requiredEvidenceAuthoritiesForContext({ ...canonical, targetTier: 'diagnostic' }, entries), /target release-final/u);
});

function authorityReferences()
{
    return [
        ['execution-envelope', '3'],
        ['replay-plan', '4'],
        ['temporal-context', '5']
    ].map(([kind, digit]) => ({
        kind,
        artifactPath: `${kind}.json`,
        artifactDigest: `sha256:${digit.repeat(64)}`,
        verificationReceiptPath: `${kind}.verification.json`,
        verificationReceiptDigest: `sha256:${digit.repeat(64)}`
    }));
}

function verification(producerId, schedulerRunId, producerCommit = sourceCommit)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit: producerCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function producer(evidenceRoot, schedulerRunId, {
    producerId = 'release-candidate',
    producerCommit = sourceCommit,
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    evidenceRoot = fs.realpathSync(evidenceRoot);
    const result = await runProducerAttempts({
        evidenceRoot,
        producerId,
        retryPolicyId,
        sourceCommit: producerCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, commandFixture, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences: authorityReferences(),
        verifyAuthority: verification(producerId, schedulerRunId, producerCommit),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        evidenceRoot,
        aggregateReceipt: result.aggregate,
        verifyAuthority: verification(producerId, schedulerRunId, producerCommit),
        aggregateReference: {
            path: path.relative(evidenceRoot, path.join(result.producerRoot, 'aggregate.json')),
            digest: result.aggregate.contentDigest,
            fileDigest: sha256(fs.readFileSync(path.join(result.producerRoot, 'aggregate.json')))
        }
    };
}

function add(cohort, slot, evidence)
{
    return appendCleanAttemptCohortSlot(cohort, {
        slot,
        ...evidence,
        expectedIdentity: { sourceCommit, worktreeFingerprint }
    });
}

test('file reader supports root-level receipts and hashes artifacts across chunks', (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-stream-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const aggregate = sealContentDigest({ marker: 'root' });
    const raw = JSON.stringify(aggregate);
    fs.writeFileSync(path.join(temporary, 'aggregate.json'), raw);
    fs.mkdirSync(path.join(temporary, 'attempt-1'));
    const bytes = Buffer.alloc(128 * 1024 + 17, 91);
    fs.writeFileSync(path.join(temporary, 'attempt-1/stdout.log'), bytes);
    const reader = fileBackedCleanAttemptEvidence({ evidenceRoot: temporary,
        aggregateReference: { path: 'aggregate.json', digest: aggregate.contentDigest, fileDigest: sha256(raw) } });
    assert.deepEqual(reader.loadAggregate(), aggregate);
    assert.equal(reader.verifyArtifact('stdout.log', sha256(bytes), { attemptNumber: 1 }), true);
    const originalRead = fs.readSync;
    let changed = false;
    context.mock.method(fs, 'readSync', (...args) =>
    {
        const count = originalRead(...args);
        if (!changed)
        {
            changed = true;
            fs.appendFileSync(path.join(temporary, 'attempt-1/stdout.log'), 'changed');
        }
        return count;
    });
    assert.throws(() => reader.verifyArtifact('stdout.log', sha256(bytes), { attemptNumber: 1 }),
        /changed while being read/u);
});

test('receipt size limit is inclusive and descriptors close after parse and size failures', (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-size-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const aggregate = sealContentDigest({ marker: 'size' });
    const raw = JSON.stringify(aggregate).padEnd(16 * 1024 * 1024, ' ');
    const file = path.join(temporary, 'aggregate.json');
    fs.writeFileSync(file, raw);
    const reader = fileBackedCleanAttemptEvidence({ evidenceRoot: temporary,
        aggregateReference: { path: 'aggregate.json', digest: aggregate.contentDigest, fileDigest: sha256(raw) } });
    assert.deepEqual(reader.loadAggregate(), aggregate);
    const opened = [];
    const originalOpen = fs.openSync;
    context.mock.method(fs, 'openSync', (...args) =>
    {
        const descriptor = originalOpen(...args);
        if (args[0] === file && typeof args[1] === 'number')
        {
            opened.push(descriptor);
        }
        return descriptor;
    });
    fs.appendFileSync(file, ' ');
    assert.throws(() => reader.loadAggregate(), /size limit/u);
    fs.writeFileSync(file, '{malformed');
    assert.throws(() => reader.loadAggregate(), SyntaxError);
    assert.equal(opened.length, 2);
    for (const descriptor of opened)
    {
        assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    }
});

test('three independent generic clean runs cannot substitute the formal producer roster', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-clean-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    let cohort = createCleanAttemptCohort('candidate-1', buildIdentity);
    for (const slot of [1, 2, 3])
    {
        const evidence = await producer(temporary, `cohort-run-${slot}`);
        cohort = add(cohort, slot, evidence);
        assert.equal(cohort.events.at(-1).status, 'admitted');
    }
    assert.equal(cohort.qualificationEligible, false);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
    const revision = path.join(temporary, 'cohorts/candidate-1/revision-3.json');
    persistCleanAttemptCohortRevision(revision, cohort);
    assert.equal(fs.statSync(revision).mode & 0o222, 0);
    assert.throws(() => persistCleanAttemptCohortRevision(revision, cohort), /EEXIST/u);
});

test('release collector admission persists an exact three-slot qualified cohort', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-cohort-adapter-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const { slots, expectedCandidate, buildIdentity } = await formalCohortFixture(context, temporary);
    const outputFile = path.join(temporary, 'release-evidence/cohort.json');
    const cohort = admitCleanAttemptCohort({
        cohortId: 'release-candidate-adapter',
        buildIdentity,
        slots,
        expectedCandidate,
        candidateRepositoryRoot: fs.realpathSync(temporary),
        outputFile
    });
    assert.equal(cohort.qualificationEligible, true);
    assert.deepEqual(cohort.events.map((event) => event.evidence.buildIdentity), [
        buildIdentity,
        buildIdentity,
        buildIdentity
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf8')), cohort);
    assert.equal(fs.statSync(outputFile).mode & 0o222, 0);
});

async function formalCohortFixture(context, temporary)
{
    temporary = fs.realpathSync(temporary);
    fs.mkdirSync(path.join(temporary, 'build/frontend-dist'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'inputs.json'), '{}\n');
    fs.writeFileSync(path.join(temporary, 'build/frontend-dist/index.html'), '<!doctype html>\n');
    const receipt = createProductionBuildReceipt({ root: temporary, artifactRoot: path.join(temporary, 'build'),
        sourceState: { commit: sourceCommit, worktreeFingerprint },
        producer: { workflow: 'cohort-fixture', runId: 'formal-slot-1', runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: { node: 'v24.0.0', npm: '11.0.0', dotnet: '10.0.100', vite: '7.0.0',
            vitest: '3.0.0', playwright: '1.55.0', emsdk: '4.0.0' },
        inputPaths: ['inputs.json'], domains: [{ name: 'frontend-dist', path: 'frontend-dist' }] });
    const buildIdentity = receipt.contentDigest;
    const receiptFileDigest = sha256(fs.readFileSync(path.join(temporary, 'build/receipt.json')));
    const imageDigest = `sha256:${'8'.repeat(64)}`;
    const imageIdentity = sealContentDigest({ schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete', runId: 'formal-slot-1', sourceState: receipt.sourceState,
        build: { contentDigest: buildIdentity, fileDigest: receiptFileDigest, imageDigest,
            image: { imageDigest, revision: sourceCommit } } });
    fs.writeFileSync(path.join(temporary, 'image-identity.json'), JSON.stringify(imageIdentity));
    const slots = [];
    const expectedSlots = [];
    for (const slot of [1, 2, 3])
    {
        const members = [];
        const expectedMembers = [];
        for (const member of requiredCleanAttemptCohortMembers())
        {
            const fixture = await createCleanAttemptEvidenceFixture({ consumerId: 'production-correctness',
                membership: { selectedTierIds: [member.authorityId], testVectors: ['fixture:attempt-runner'] },
                producerId: member.producerId, schedulerRunId: `formal-slot-${slot}`, buildIdentity });
            context.after(() => fixture.cleanup());
            const directory = path.join(temporary, `slot-${slot}`, member.authorityId);
            fs.mkdirSync(directory, { recursive: true });
            const evidenceSource = writeCleanAttemptEvidenceFixtureSource(fixture, path.join(directory, 'source.json'));
            members.push({ authorityId: member.authorityId, attemptEvidence: fixture.attemptEvidence, evidenceSource });
            expectedMembers.push({ authorityId: member.authorityId, ...fixture.expectedCandidate });
        }
        slots.push({ slot, members });
        const runContext = sealContentDigest({ schema: 'fsusblog.current-run-evidence-context.v1',
            schedulerRunId: `formal-slot-${slot}`, attemptId: `formal-attempt-${slot}`,
            sourceCommit, worktreeFingerprint, candidateIdentity: { id: 'release-final', digest: imageDigest },
            buildIdentity: { id: 'production-build-artifacts', digest: buildIdentity }, ownedRoots: [`slot-${slot}`] });
        const contextPath = `slot-${slot}/current-run-context.json`;
        fs.writeFileSync(path.join(temporary, contextPath), JSON.stringify(runContext));
        expectedSlots.push({ slot, schedulerRunId: `formal-slot-${slot}`, members: expectedMembers,
            contextReference: { path: contextPath, fileDigest: sha256(fs.readFileSync(path.join(temporary, contextPath))) } });
    }
    return { slots, buildIdentity, expectedCandidate: { targetTier: 'release-final', sourceCommit, worktreeFingerprint,
        buildIdentity, imageDigest, slots: expectedSlots,
        buildGraph: { artifactRoot: 'build', receiptFile: 'receipt.json', producer: receipt.producer,
            receiptReference: { path: 'build/receipt.json', fileDigest: receiptFileDigest, digest: receipt.contentDigest } },
        imageIdentityReference: { path: 'image-identity.json', digest: imageIdentity.contentDigest,
            fileDigest: sha256(fs.readFileSync(path.join(temporary, 'image-identity.json'))) } } };
}

test('archive rejects unsafe producer graph before reading or exporting root-external bytes', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-archive-boundary-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const fixture = await formalCohortFixture(context, temporary);
    const original = fixture.slots[0].members[0];
    const evidenceRoot = original.attemptEvidence.evidenceRoot;
    const aggregateFile = path.join(evidenceRoot, original.attemptEvidence.aggregateReference.path);
    const aggregateBytes = fs.readFileSync(aggregateFile);
    const aggregate = JSON.parse(aggregateBytes);
    const producerRoot = path.dirname(aggregateFile);
    const attemptFile = path.join(producerRoot, aggregate.attempts[0].path);
    const attemptBytes = fs.readFileSync(attemptFile);
    const outside = path.join(temporary, 'outside-owned-test-root');
    fs.mkdirSync(outside);
    const secret = 'ROOT-EXTERNAL-BYTES-MUST-NEVER-BE-ARCHIVED';
    const secretFile = path.join(outside, 'secret.json');
    const secretBytes = JSON.stringify(sealContentDigest({ secret }));
    fs.writeFileSync(secretFile, secretBytes);

    for (const kind of ['subsequent-attempt-traversal', 'artifact-traversal', 'symlink-parent', 'archive-destination-escape'])
    {
        await context.test(kind, (check) =>
        {
            const slots = fixture.slots.map((slot) => ({ ...slot, members: slot.members.map((member) => ({ ...member,
                attemptEvidence: { ...member.attemptEvidence, aggregateReference: { ...member.attemptEvidence.aggregateReference } } })) }));
            const member = slots[0].members[0];
            let modifiedAggregate = structuredClone(aggregate);
            let modifiedAttempt = JSON.parse(attemptBytes);
            const archiveRoot = path.join(temporary, `archive-${kind}`);
            fs.mkdirSync(archiveRoot);
            const rejection = path.join(archiveRoot, 'cohort.json');
            const link = path.join(path.dirname(attemptFile), 'external-parent');
            check.after(() =>
            {
                for (const [file, bytes] of [[aggregateFile, aggregateBytes], [attemptFile, attemptBytes]])
                {
                    fs.chmodSync(file, 0o600);
                    fs.writeFileSync(file, bytes);
                }
                if (kind === 'symlink-parent')
                {
                    fs.unlinkSync(link);
                }
            });
            if (kind === 'subsequent-attempt-traversal')
            {
                modifiedAggregate.attempts.push({ ...modifiedAggregate.attempts[0], attemptNumber: 2,
                    path: path.relative(producerRoot, secretFile).replaceAll(path.sep, '/'),
                    digest: JSON.parse(secretBytes).contentDigest });
            }
            if (kind === 'artifact-traversal' || kind === 'symlink-parent')
            {
                if (kind === 'symlink-parent')
                {
                    fs.symlinkSync(outside, link, 'dir');
                }
                const artifact = kind === 'artifact-traversal'
                    ? path.relative(path.dirname(attemptFile), secretFile).replaceAll(path.sep, '/')
                    : 'external-parent/secret.json';
                modifiedAttempt.artifactPaths = [...modifiedAttempt.artifactPaths, artifact].sort();
                modifiedAttempt.artifactDigests[artifact] = sha256(secretBytes);
                modifiedAttempt = sealContentDigest(modifiedAttempt);
                fs.chmodSync(attemptFile, 0o600);
                fs.writeFileSync(attemptFile, JSON.stringify(modifiedAttempt));
                modifiedAggregate.attempts[0].digest = modifiedAttempt.contentDigest;
            }
            if (kind === 'archive-destination-escape')
            {
                fs.symlinkSync(outside, path.join(archiveRoot, 'cohort-evidence'), 'dir');
            }
            modifiedAggregate = sealContentDigest(modifiedAggregate);
            fs.chmodSync(aggregateFile, 0o600);
            fs.writeFileSync(aggregateFile, JSON.stringify(modifiedAggregate));
            member.attemptEvidence.aggregateReference.digest = modifiedAggregate.contentDigest;
            member.attemptEvidence.aggregateReference.fileDigest = sha256(fs.readFileSync(aggregateFile));

            let externalReads = 0;
            const originalOpen = fs.openSync;
            const originalRead = fs.readFileSync;
            const outsidePath = (file) => typeof file === 'string' && fs.existsSync(file)
                && fs.realpathSync(file) === secretFile;
            check.mock.method(fs, 'openSync', (...args) =>
            {
                if (outsidePath(args[0]))
                {
                    externalReads++;
                }
                return originalOpen(...args);
            });
            check.mock.method(fs, 'readFileSync', (...args) =>
            {
                if (outsidePath(args[0]))
                {
                    externalReads++;
                }
                return originalRead(...args);
            });
            assert.throws(() => archiveCleanAttemptCohortInputs({ ...fixture, slots, cohortId: `boundary-${kind}`,
                repositoryRoot: temporary, archiveRoot, rejectedOutputFile: rejection }), /rejected|non-symlink/u);
            assert.equal(externalReads, 0, 'no outside file may be opened/read before rejection');
            const archiveBytes = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory() ? archiveBytes(path.join(directory, entry.name))
                    : entry.isFile() ? [fs.readFileSync(path.join(directory, entry.name), 'utf8')] : []);
            assert.equal(archiveBytes(archiveRoot).some((bytes) => bytes.includes(secret)), false);
            assert.deepEqual(fs.readdirSync(outside), ['secret.json'], 'destination parents cannot redirect archive writes');
            if (kind !== 'archive-destination-escape')
            {
                const rejected = JSON.parse(fs.readFileSync(rejection));
                assert.equal(rejected.qualificationEligible, false);
                assert.equal(rejected.events[0].status, 'rejected');
                assert.equal(fs.existsSync(path.join(archiveRoot, 'cohort-evidence')), false, 'preflight precedes every graph copy');
            }
            else
            {
                assert.equal(fs.existsSync(path.join(outside, 'build')), false);
                const escaping = slots.map((slot) => ({ ...slot, members: [...slot.members] }));
                escaping[0].members[0] = { ...escaping[0].members[0], authorityId: '../../escaped' };
                assert.throws(() => archiveCleanAttemptCohortInputs({ ...fixture, slots: escaping, cohortId: 'escape',
                    repositoryRoot: temporary, archiveRoot }), /rejected/u);
            }
        });
    }
});

test('formal cohort rejects missing duplicate cross-candidate and tampered producer evidence', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-formal-negative-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const fixture = await formalCohortFixture(context, temporary);
    const buildIdentity = fixture.buildIdentity;
    const admit = (slots = fixture.slots, expectedCandidate = fixture.expectedCandidate) => admitCleanAttemptCohort({
        cohortId: 'negative', buildIdentity, slots, expectedCandidate, candidateRepositoryRoot: temporary });
    for (const mutate of [
        (slots) => slots[0].members.pop(),
        (slots) => slots[0].members.push(slots[0].members[0]),
        (slots) => slots[0].members[0].attemptEvidence.buildIdentity = `sha256:${'a'.repeat(64)}`,
        (slots) => slots[0].members[0].attemptEvidence.domainReceiptReference.digest = `sha256:${'a'.repeat(64)}`,
        (slots) => slots[0].members[0].attemptEvidence.aggregateReference.fileDigest = `sha256:${'a'.repeat(64)}`
    ])
    {
        const slots = fixture.slots.map((entry) => ({ ...entry, members: entry.members.map((member) => ({
            ...member, attemptEvidence: { ...member.attemptEvidence,
                aggregateReference: { ...member.attemptEvidence.aggregateReference },
                domainReceiptReference: { ...member.attemptEvidence.domainReceiptReference } } })) }));
        mutate(slots);
        assert.throws(() => admit(slots), /rejected/u);
    }
    for (const field of ['sourceCommit', 'worktreeFingerprint'])
    {
        assert.throws(() => admit(fixture.slots, { ...fixture.expectedCandidate,
            [field]: field === 'sourceCommit' ? 'a'.repeat(40) : `sha256:${'a'.repeat(64)}` }), /rejected/u);
    }
    for (const field of ['executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        const candidate = structuredClone(fixture.expectedCandidate);
        candidate.slots[0].members[0][field] = `sha256:${'a'.repeat(64)}`;
        assert.throws(() => admit(fixture.slots, candidate), /rejected/u);
    }
    for (const mutate of [
        (candidate) =>
        {
            delete candidate.buildGraph;
        },
        (candidate) =>
        {
            candidate.buildGraph.receiptReference.digest = `sha256:${'a'.repeat(64)}`;
        },
        (candidate) =>
        {
            candidate.slots[0].contextReference.fileDigest = `sha256:${'a'.repeat(64)}`;
        },
        (candidate) =>
        {
            candidate.imageDigest = `sha256:${'a'.repeat(64)}`;
        }
    ])
    {
        const candidate = structuredClone(fixture.expectedCandidate);
        mutate(candidate);
        assert.throws(() => admit(fixture.slots, candidate), /rejected/u);
    }
    const candidate = structuredClone(fixture.expectedCandidate);
    candidate.slots[1].schedulerRunId = candidate.slots[0].schedulerRunId;
    assert.throws(() => admit(fixture.slots, candidate), /rejected/u);
    const cohort = admit();
    const memberMutation = structuredClone(cohort);
    memberMutation.events[0].evidence.members.pop();
    memberMutation.events[0] = sealContentDigest(memberMutation.events[0]);
    memberMutation.events[1].previousEventDigest = memberMutation.events[0].contentDigest;
    memberMutation.events[1] = sealContentDigest(memberMutation.events[1]);
    memberMutation.events[2].previousEventDigest = memberMutation.events[1].contentDigest;
    memberMutation.events[2] = sealContentDigest(memberMutation.events[2]);
    assert.throws(() => validateCleanAttemptCohort(sealContentDigest(memberMutation)), /formal producer/u);
    const archiveRoot = path.join(temporary, 'release-archive');
    fs.mkdirSync(archiveRoot);
    const archived = archiveCleanAttemptCohortInputs({ ...fixture, cohortId: 'negative', repositoryRoot: temporary, archiveRoot });
    const archivedCohort = admitCleanAttemptCohort({ cohortId: 'negative', buildIdentity,
        slots: archived.slots, expectedCandidate: archived.expectedCandidate, candidateRepositoryRoot: archiveRoot });
    persistCleanAttemptCohortRevision(path.join(archiveRoot, 'cohort.json'), archivedCohort);
    const movedRoot = path.join(temporary, 'moved-release-archive');
    fs.renameSync(archiveRoot, movedRoot);
    const artifacts = { cleanAttemptCohort: 'cohort.json', cleanAttemptCandidate: 'clean-attempt-expected-candidate.json',
        cleanAttemptGraph: 'clean-attempt-archive-graph.json' };
    const manifest = { artifacts,
        artifactDigests: Object.fromEntries(Object.entries(artifacts).map(([key, relative]) => [key,
            { algorithm: 'sha256', value: sha256(fs.readFileSync(path.join(movedRoot, relative))).slice(7) }])),
        commitSha: sourceCommit, imageDigest: fixture.expectedCandidate.imageDigest, releaseNamespace: 'negative' };
    const manifestPath = path.join(movedRoot, 'manifest.json');
    for (const slot of fixture.slots)
    {
        for (const member of slot.members)
        {
            fs.rmSync(member.attemptEvidence.evidenceRoot, { recursive: true, force: true });
        }
        fs.rmSync(path.join(temporary, `slot-${slot.slot}`), { recursive: true, force: true });
    }
    fs.rmSync(path.join(temporary, 'build'), { recursive: true, force: true });
    assert.equal(verifyCleanAttemptCohortManifest(manifest, manifestPath, temporary), true);
    for (const field of ['schedulerRunId', 'worktreeFingerprint', 'executionEnvelopeDigest'])
    {
        const stale = structuredClone(archivedCohort);
        for (const event of stale.events)
        {
            if (field !== 'executionEnvelopeDigest')
            {
                event.evidence[field] = field === 'schedulerRunId' ? `stale-run-${event.slot}` : `sha256:${'a'.repeat(64)}`;
            }
            for (const member of event.evidence.members)
            {
                member[field] = field === 'schedulerRunId' ? `stale-run-${event.slot}` : `sha256:${'a'.repeat(64)}`;
            }
        }
        for (let index = 0; index < stale.events.length; index++)
        {
            stale.events[index].previousEventDigest = stale.events[index - 1]?.contentDigest ?? null;
            stale.events[index] = sealContentDigest(stale.events[index]);
        }
        const cohortFile = path.join(movedRoot, 'cohort.json');
        fs.chmodSync(cohortFile, 0o600);
        fs.writeFileSync(cohortFile, JSON.stringify(sealContentDigest(stale)));
        const rehashedManifest = { ...manifest, artifactDigests: { ...manifest.artifactDigests,
            cleanAttemptCohort: { algorithm: 'sha256', value: sha256(fs.readFileSync(cohortFile)).slice(7) } } };
        assert.throws(() => verifyCleanAttemptCohortManifest(rehashedManifest, manifestPath, temporary), /replay differs/u,
            `rehashed coherent ${field} cohort cannot replace independent current candidate receipts`);
        fs.writeFileSync(cohortFile, `${JSON.stringify(archivedCohort)}\n`);
        manifest.artifactDigests.cleanAttemptCohort.value = sha256(fs.readFileSync(cohortFile)).slice(7);
        fs.chmodSync(cohortFile, 0o444);
    }
    assert.throws(() => verifyCleanAttemptCohortManifest({ ...manifest, artifacts: {} }, manifestPath, temporary), /cleanAttemptCandidate/u);
    assert.throws(() => verifyCleanAttemptCohortManifest({ ...manifest, imageDigest: `sha256:${'a'.repeat(64)}` }, manifestPath, temporary), /identity/u);
    assert.throws(() => verifyCleanAttemptCohortManifest({ ...manifest, artifactDigests: {} }, manifestPath, temporary), /digest/u);
    const member = archivedCohort.events[0].evidence.members[0];
    const evidence = readCleanAttemptEvidenceSource(member.evidenceSource.path, { repositoryRoot: movedRoot });
    const log = path.join(evidence.evidenceRoot, path.dirname(evidence.aggregateReference.path), 'attempt-1/stdout.log');
    fs.chmodSync(log, 0o600);
    fs.appendFileSync(log, 'tampered');
    assert.throws(() => verifyCleanAttemptCohortManifest(manifest, manifestPath, temporary), /digest|rejected/u);
});

test('release collector require-ok fails before collection without cohort admission input', () =>
{
    const result = spawnSync('bash', [
        path.join(root, 'tools/operations/collect-release-evidence.sh'),
        '--require-ok'
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            FSUSBLOG_RELEASE_STAMP: 'issue-2647-missing-cohort'
        }
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /FSUSBLOG_RELEASE_CLEAN_ATTEMPT_COHORT_INPUT/u);
});

test('a real producer rooted at the evidence directory is admitted with its attempt and logs', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-root-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'root-producer');
    evidence.evidenceRoot = path.dirname(path.join(temporary, evidence.aggregateReference.path));
    evidence.aggregateReference.path = 'aggregate.json';
    const cohort = add(createCleanAttemptCohort('candidate-root', buildIdentity), 1, evidence);
    assert.equal(cohort.events[0].status, 'admitted');
    assert.equal(cohort.events[0].evidence.attemptNumber, 1);
    assert.ok(cohort.events[0].evidence.logs.stdout.digest);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
});

test('individually valid runs cannot change source identity across cohort slots', async (context) =>
{
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-source-')));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const first = await producer(temporary, 'first-source');
    const changed = await producer(temporary, 'changed-source', { producerCommit: '7'.repeat(40) });
    const original = add(createCleanAttemptCohort('candidate-source', buildIdentity), 1, first);
    const cohort = appendCleanAttemptCohortSlot(original, { slot: 2, ...changed });
    assert.equal(cohort.events[1].status, 'rejected');
    assert.equal(cohort.events[1].reasons[0].code, 'cohort.source-identity-mismatch');
    assert.equal(cohort.events[1].reasons[0].field, 'sourceCommit');
    assert.deepEqual(cohort.events[0], original.events[0]);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
    const rewritten = sealContentDigest({ ...cohort.events[1], status: 'admitted', reasons: [] });
    const forged = sealContentDigest({ ...cohort, events: [cohort.events[0], rewritten] });
    assert.throws(() => validateCleanAttemptCohort(forged), /changes source identity/u);
});

test('aggregate reference digest must bind the validated receipt', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-reference-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'reference-run');
    evidence.aggregateReference = {
        ...evidence.aggregateReference,
        digest: `sha256:${'8'.repeat(64)}`
    };
    const cohort = add(createCleanAttemptCohort('candidate-reference', buildIdentity), 1, evidence);
    const event = cohort.events[0];
    assert.equal(event.status, 'rejected');
    assert.equal(event.reasons[0].code, 'attempt.content-tamper');
    assert.equal(event.reasons[0].actual.digest, evidence.aggregateReceipt.contentDigest);
    assert.equal(event.reasons[0].expected.digest, evidence.aggregateReference.digest);
    assert.equal(event.reasons[0].ref, evidence.aggregateReference.path);
    assert.equal(cohort.qualificationEligible, false);
    assert.throws(() => add(cohort, 1, evidence), /cohort\.slot-immutable/u);
});

test('persisted cohort validates slot and disposition independently of content digests', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-schema-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'schema-run');
    const original = add(createCleanAttemptCohort('candidate-schema', buildIdentity), 1, evidence);
    for (const change of [
        { slot: 0 },
        { slot: 4 },
        { slot: 1.5 },
        { schema: 'unknown' },
        { status: 'success' },
        { reasons: [{ code: 'failed', message: 'must not be admitted' }] },
        { status: 'rejected', reasons: [] },
        { status: 'rejected', reasons: [{ code: '', message: '' }] }
    ])
    {
        const event = sealContentDigest({ ...original.events[0], ...change });
        const malformed = sealContentDigest({ ...original, events: [event] });
        assert.throws(() => validateCleanAttemptCohort(malformed), /cohort event 1/u);
    }
});

test('a failed slot is retained and cannot be replaced by a later clean run', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-failed-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const failed = await producer(temporary, 'failed-run', { scenario: 'product-failure' });
    const cohort = add(createCleanAttemptCohort('candidate-2', buildIdentity), 1, failed);
    assert.equal(cohort.events[0].status, 'rejected');
    assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    const laterClean = await producer(temporary, 'later-clean-run');
    assert.throws(() => add(cohort, 1, laterClean), /cohort\.slot-immutable/u);
});

test('recovered diagnostic or restore attempts cannot occupy a clean cohort slot', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-recovered-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const [producerId, retryPolicyId, scenario] of [
        ['browser-diagnostics', 'diagnostic-browser-process-crash', 'browser-crash-once'],
        ['dependency-restore', 'dependency-transfer-observed-recovery', 'restore-timeout-once']
    ])
    {
        const evidence = await producer(temporary, `${producerId}-run`, {
            producerId,
            retryPolicyId,
            scenario
        });
        const cohort = add(createCleanAttemptCohort(`candidate-${producerId}`, buildIdentity), 1, evidence);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    }
});

test('missing attempts, status-only evidence, cross identity and artifact tamper fail closed', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const kind of ['summary', 'missing-attempts', 'cross-identity', 'log-tamper'])
    {
        const evidence = await producer(temporary, `invalid-${kind}`);
        const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
        if (kind === 'summary' || kind === 'missing-attempts')
        {
            const changed = kind === 'summary'
                ? { status: 'ok', exitCode: 0, contentDigest: evidence.aggregateReceipt.contentDigest }
                : { ...evidence.aggregateReceipt, attempts: [] };
            fs.chmodSync(aggregateFile, 0o600);
            fs.writeFileSync(aggregateFile, JSON.stringify(changed));
            evidence.aggregateReference.fileDigest = sha256(fs.readFileSync(aggregateFile));
        }
        if (kind === 'log-tamper')
        {
            const attemptFile = path.join(path.dirname(aggregateFile), evidence.aggregateReceipt.attempts[0].path);
            const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
            const log = path.join(path.dirname(attemptFile), attempt.stdoutPath);
            fs.chmodSync(log, 0o600);
            fs.appendFileSync(log, 'changed');
        }
        const cohort = appendCleanAttemptCohortSlot(
            createCleanAttemptCohort(`candidate-invalid-${kind}`, buildIdentity),
            { slot: 1, ...evidence, expectedIdentity: {
                sourceCommit: kind === 'cross-identity' ? 'a'.repeat(40) : sourceCommit,
                worktreeFingerprint
            } }
        );
        assert.equal(cohort.qualificationEligible, false);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.ok(cohort.events[0].reasons[0].code.startsWith('attempt.'));
    }
});

test('cohort slots reject reused run and aggregate roots with specific reasons', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-reused-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'shared-run');
    let cohort = add(createCleanAttemptCohort('candidate-reused', buildIdentity), 1, evidence);
    cohort = add(cohort, 2, evidence);
    assert.equal(cohort.events[1].status, 'rejected');
    assert.deepEqual(cohort.events[1].reasons.map((item) => item.code), [
        'cohort.run-not-independent',
        'cohort.attempt-root-not-independent'
    ]);
});

test('cohort admission reads files and rejects missing, replaced and aliased evidence', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-files-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const kind of [
        'missing-root', 'missing-aggregate', 'missing-attempt', 'missing-log',
        'aggregate-symlink', 'attempt-symlink', 'log-symlink',
        'aggregate-bytes', 'attempt-content', 'missing-file-digest'
    ])
    {
        const evidence = await producer(temporary, `file-${kind}`);
        const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
        const attemptFile = path.join(path.dirname(aggregateFile), evidence.aggregateReceipt.attempts[0].path);
        const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
        const logFile = path.join(path.dirname(attemptFile), attempt.stdoutPath);
        const target = kind.includes('aggregate') ? aggregateFile
            : kind.includes('attempt') ? attemptFile : logFile;
        if (kind === 'missing-root')
        {
            evidence.evidenceRoot = undefined;
        }
        else if (kind === 'missing-file-digest')
        {
            delete evidence.aggregateReference.fileDigest;
        }
        else if (kind.startsWith('missing-'))
        {
            fs.unlinkSync(target);
        }
        else if (kind.endsWith('-symlink'))
        {
            fs.renameSync(target, `${target}.original`);
            fs.symlinkSync(`${target}.original`, target);
        }
        else
        {
            fs.chmodSync(target, 0o600);
            fs.writeFileSync(target, kind === 'aggregate-bytes'
                ? `${fs.readFileSync(target, 'utf8')} `
                : JSON.stringify({ ...attempt, status: 'cancelled' }));
        }
        const cohort = add(createCleanAttemptCohort(`candidate-${kind}`, buildIdentity), 1, {
            ...evidence,
            // In-memory substitutes cannot override the mandatory file reader.
            loadAttempt: () => attempt,
            verifyArtifact: () => true
        });
        assert.equal(cohort.events[0].status, 'rejected', kind);
        assert.ok(cohort.events[0].reasons[0].code.startsWith('attempt.'), kind);
        assert.equal(cohort.qualificationEligible, false, kind);
    }
});

test('different aggregate filenames in one attempt root are not independent runs', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-root-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const first = await producer(temporary, 'root-run-one');
    const second = await producer(temporary, 'root-run-two');
    let cohort = add(createCleanAttemptCohort('candidate-root', buildIdentity), 1, first);
    assert.equal(cohort.events[0].status, 'admitted');
    const firstRoot = path.dirname(path.join(temporary, first.aggregateReference.path));
    const secondRoot = path.dirname(path.join(temporary, second.aggregateReference.path));
    // Simulate a new run replacing the first run's files in the same owned root.
    fs.rmSync(path.join(firstRoot, 'attempt-1'), { recursive: true, force: true });
    fs.cpSync(path.join(secondRoot, 'attempt-1'), path.join(firstRoot, 'attempt-1'), { recursive: true });
    fs.copyFileSync(path.join(secondRoot, 'aggregate.json'), path.join(firstRoot, 'second.json'));
    second.aggregateReference = {
        ...second.aggregateReference,
        path: path.relative(temporary, path.join(firstRoot, 'second.json'))
    };
    cohort = add(cohort, 2, second);
    assert.equal(cohort.events[1].status, 'rejected');
    assert.equal(cohort.events[1].reasons[0].code, 'cohort.attempt-root-not-independent');
    for (const referencePath of [
        'shared/../shared/first.json', './shared/first.json', '/shared/first.json',
        'shared//first.json', 'shared\\first.json', 'C:/shared/first.json'
    ])
    {
        const rejected = add(createCleanAttemptCohort('candidate-path', buildIdentity), 1, {
            ...first,
            aggregateReference: { ...first.aggregateReference, path: referencePath }
        });
        assert.equal(rejected.events[0].status, 'rejected');
        assert.equal(validateCleanAttemptCohort(rejected), rejected);
        assert.throws(() => add(rejected, 1, first), /slot-immutable/u);
    }
});

test('malformed attempt references preserve an immutable rejected slot', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cohort-malformed-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'malformed-reference');
    const aggregateFile = path.join(temporary, evidence.aggregateReference.path);
    const malformed = sealContentDigest({
        ...evidence.aggregateReceipt, attempts: [{ attemptNumber: 1, path: null, digest: null }]
    });
    fs.chmodSync(aggregateFile, 0o600);
    fs.writeFileSync(aggregateFile, JSON.stringify(malformed));
    evidence.aggregateReference.digest = malformed.contentDigest;
    evidence.aggregateReference.fileDigest = sha256(fs.readFileSync(aggregateFile));
    for (const input of [evidence, { ...evidence, aggregateReference: null }])
    {
        const cohort = add(createCleanAttemptCohort('candidate-malformed', buildIdentity), 1, input);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.equal(cohort.events[0].evidence.attemptReceipt, null);
        assert.equal(validateCleanAttemptCohort(cohort), cohort);
        assert.throws(() => add(cohort, 1, evidence), /slot-immutable/u);
    }
});
