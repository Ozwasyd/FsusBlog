import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { adaptBrowserContractSemanticOutcome, browserContractOutcomeProducerId } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-adapter.mjs', import.meta.url));
const { validateProducerSemanticOutcomeCandidate } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const fileDigest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-outcome-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = { producerId: browserContractOutcomeProducerId, sourceCommit: '1'.repeat(40),
        worktreeFingerprint: digest('2'), buildIdentity: digest('3'), executionEnvelopeDigest: digest('4'),
        replayPlanDigest: digest('5'), temporalContextDigest: digest('6'), toolchainDigest: digest('7'), schedulerRunId: 'browser-run' };
    const attemptEligibility = { aggregateDigest: digest('8'), attemptDigest: digest('9'), attemptNumber: 1,
        cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
    const binding = { identity, attemptEligibility, policyDigest: digest('a'), runtimeIdentities: [
        { projectId: 'public', browserId: 'chromium', runtimeDigest: digest('b') },
        { projectId: 'admin', browserId: 'firefox', runtimeDigest: digest('c') }
    ] };
    const kinds = ['dom', 'geometry', 'network', 'screenshot'];
    const members = kinds.map((kind, index) => ({ id: `member-${kind}`,
        projectId: index < 2 ? 'public' : 'admin', browserId: index < 2 ? 'chromium' : 'firefox',
        testId: `test-${kind}`, assertionId: `assertion-${kind}`, required: true,
        artifacts: [{ id: `artifact-${kind}`, kind }] }));
    const catalog = { schema: 'fsusblog.browser-contract-outcome-catalog.v1', ...structuredClone(binding), members: structuredClone(members) };
    const plan = { schema: 'fsusblog.browser-contract-outcome-plan.v1', ...structuredClone(binding), members: structuredClone(members) };
    const report = { schema: 'fsusblog.browser-contract-outcome-report.v1', ...structuredClone(binding),
        groupStatus: 'success', interruption: null, diagnostics: { generatedAt: '2026-10-08T00:00:00Z', errorMessage: '' },
        members: members.map((member) => ({
            ...Object.fromEntries(['id', 'projectId', 'browserId', 'testId', 'assertionId'].map((field) => [field, member[field]])),
            executed: true, status: 'passed', artifactIds: member.artifacts.map((artifact) => artifact.id), failures: [] })),
        artifacts: kinds.map((kind) =>
        {
            const bytes = Buffer.from(`${kind} correctness content`);
            fs.writeFileSync(path.join(root, `${kind}.bin`), bytes);
            return { id: `artifact-${kind}`, memberId: `member-${kind}`, kind, role: 'correctness',
                path: `${kind}.bin`, digest: fileDigest(bytes) };
        }) };
    const authority = { ...structuredClone(binding), inputAuthorityRefs: [] };
    const write = () =>
    {
        const catalogSeal = sealContentDigest(catalog);
        const planSeal = sealContentDigest({ ...plan, catalogDigest: catalogSeal.contentDigest });
        const reportSeal = sealContentDigest({ ...report, catalogDigest: catalogSeal.contentDigest, planDigest: planSeal.contentDigest });
        authority.inputAuthorityRefs = [catalogSeal, planSeal, reportSeal].map((document, index) =>
        {
            const kind = ['catalog', 'plan', 'report'][index];
            const bytes = Buffer.from(JSON.stringify(document));
            fs.writeFileSync(path.join(root, `${kind}.json`), bytes);
            return { kind: `browser-contract-${kind}`, path: `${kind}.json`, digest: fileDigest(bytes) };
        });
    };
    const adapt = () =>
    {
        write();
        return adaptBrowserContractSemanticOutcome({ repositoryRoot: root, authority });
    };
    const fail = (index, kind) =>
    {
        const member = report.members[index];
        member.status = 'failed';
        const scope = Object.fromEntries(['projectId', 'browserId', 'testId', 'assertionId'].map((field) => [field, member[field]]));
        const extra = kind === 'infra.browser-crash' ? { attemptNumber: 1 } : {};
        member.failures = [{ kind, identity: { producerId: browserContractOutcomeProducerId, ...scope, ...extra } }];
        report.groupStatus = 'failed';
        for (const document of [authority, catalog, plan, report])
        {
            Object.assign(document.attemptEligibility, { cleanFirstAttempt: false, firstFailure: true, qualificationEligible: false });
        }
    };
    return { root, authority, catalog, plan, report, adapt, write, fail };
}

function blockMember(f, index, status = 'blocked')
{
    f.report.members[index].status = status;
    f.report.members[index].executed = false;
    f.report.members[index].artifactIds = [];
    f.report.artifacts = f.report.artifacts.filter((artifact) => artifact.memberId !== f.report.members[index].id);
    f.report.groupStatus = 'failed';
}

function interrupt(f, kind = 'infra.browser-crash')
{
    const fields = kind === 'infra.browser-crash' ? { attemptNumber: 1 }
        : kind === 'infra.toolchain-mismatch' ? { toolchainDigest: f.authority.identity.toolchainDigest }
            : { executionEnvelopeDigest: f.authority.identity.executionEnvelopeDigest };
    f.report.interruption = { kind, identity: { producerId: browserContractOutcomeProducerId, ...fields } };
    f.report.groupStatus = 'failed';
}

test('sealed plan/catalog and byte-verified report produce exact browser member candidate', (t) =>
{
    const f = fixture(t);
    const result = f.adapt();
    assert.equal(validateProducerSemanticOutcomeCandidate(result), result);
    assert.equal(result.outcome.status, 'success');
    assert.deepEqual(result.outcome.membership.plannedProjectIds, ['admin', 'public']);
    assert.deepEqual(result.outcome.membership.plannedBrowserIds, ['chromium', 'firefox']);
    assert.deepEqual(result.outcome.membership.plannedMemberIds, result.outcome.membership.executedMemberIds);
    assert.deepEqual(result.outcome.membership.passedMemberIds, result.outcome.membership.plannedMemberIds);
    assert.equal(result.inputAuthorityRefs.length, 3);
    assert.equal(result.producerAuthorityId, 'tools/test-matrix/outcomes/browser-contract-adapter.mjs');
});

test('missing terminal without interruption is refused', (t) =>
{
    const f = fixture(t);
    f.report.members.pop();
    assert.throws(f.adapt, /missing terminal members/u);
});

test('duplicate terminal is refused before group status can mask it', (t) =>
{
    const f = fixture(t);
    f.report.members.push(f.report.members[0]);
    assert.throws(f.adapt, /duplicate IDs/u);
});

test('extra terminal is refused', (t) =>
{
    const f = fixture(t);
    f.report.members.push({ ...f.report.members[0], id: 'orphan' });
    assert.throws(f.adapt, /extra members/u);
});

test('required skipped member remains skipped and fails candidate', (t) =>
{
    const f = fixture(t);
    blockMember(f, 0, 'skipped');
    const result = f.adapt();
    assert.equal(result.outcome.status, 'failed');
    assert.deepEqual(result.outcome.membership.skippedMemberIds, ['member-dom']);
    assert.equal(result.outcome.reasons[0].kind, 'contract.missing-evidence');
});

test('only optional plan-declared skip allows success', (t) =>
{
    const f = fixture(t);
    f.plan.members[0].required = false;
    f.catalog.members[0].required = false;
    blockMember(f, 0, 'skipped');
    f.report.groupStatus = 'success';
    assert.equal(f.adapt().outcome.status, 'success');
});

test('infra interruption preserves executed members and marks missing required members blocked', (t) =>
{
    const f = fixture(t);
    f.fail(1, 'infra.browser-crash');
    interrupt(f);
    f.report.members.splice(2);
    f.report.artifacts.splice(2);
    const result = f.adapt();
    assert.equal(result.outcome.status, 'failed');
    assert.deepEqual(result.outcome.membership.passedMemberIds, ['member-dom']);
    assert.deepEqual(result.outcome.membership.failedMemberIds, ['member-geometry']);
    assert.deepEqual(result.outcome.membership.blockedMemberIds, ['member-network', 'member-screenshot']);
    assert.deepEqual(result.outcome.membership.executedMemberIds, ['member-dom', 'member-geometry']);
    assert.equal(result.outcome.membership.interruptionKind, 'infra.browser-crash');
});

test('explicit blocked member requires canonical infrastructure interruption', (t) =>
{
    const f = fixture(t);
    blockMember(f, 0);
    assert.throws(f.adapt, /lacks an infrastructure interruption/u);
    interrupt(f, 'infra.service-readiness');
    assert.deepEqual(f.adapt().outcome.membership.blockedMemberIds, ['member-dom']);
});

test('illegal executed-terminal overlap and extra status sets are refused', (t) =>
{
    const f = fixture(t);
    f.report.members[0].executed = false;
    assert.throws(f.adapt, /overlap is illegal/u);
    f.report.members[0].executed = true;
    f.report.members[0].skipped = true;
    assert.throws(f.adapt, /fields do not exactly/u);
});

test('group success cannot cover a product assertion failure', (t) =>
{
    const f = fixture(t);
    f.fail(0, 'product.assertion');
    f.report.groupStatus = 'success';
    assert.throws(f.adapt, /group status contradicts/u);
});

test('product assertions and browser crashes retain distinct canonical failure topology', (t) =>
{
    const f = fixture(t);
    f.fail(0, 'product.assertion');
    const product = f.adapt();
    f.fail(0, 'infra.browser-crash');
    const infra = f.adapt();
    assert.equal(product.outcome.reasons[0].kind, 'product.assertion');
    assert.equal(infra.outcome.reasons[0].kind, 'infra.browser-crash');
    assert.notEqual(product.outcome.semanticPayloadDigest, infra.outcome.semanticPayloadDigest);
});

test('error message perturbation does not classify or change semantic outcome', (t) =>
{
    const f = fixture(t);
    f.fail(0, 'product.assertion');
    const first = f.adapt();
    f.report.diagnostics.errorMessage = 'browser crashed: completely different text';
    const second = f.adapt();
    assert.deepEqual(first.outcome, second.outcome);
    assert.notEqual(first.contentDigest, second.contentDigest);
});

test('DOM geometry network and declared screenshot byte changes affect semantic outcome', (t) =>
{
    const f = fixture(t);
    const first = f.adapt();
    for (const artifact of f.report.artifacts)
    {
        const originalBytes = fs.readFileSync(path.join(f.root, artifact.path));
        const originalDigest = artifact.digest;
        const bytes = Buffer.from(`${artifact.kind} changed correctness content`);
        fs.writeFileSync(path.join(f.root, artifact.path), bytes);
        artifact.digest = fileDigest(bytes);
        const changed = f.adapt();
        assert.notEqual(first.outcome.semanticPayloadDigest, changed.outcome.semanticPayloadDigest);
        assert.equal(changed.outcome.membership.artifactSemanticDigests[artifact.id], artifact.digest);
        fs.writeFileSync(path.join(f.root, artifact.path), originalBytes);
        artifact.digest = originalDigest;
    }
});

test('trace video log locations and timestamps stay diagnostic', (t) =>
{
    const f = fixture(t);
    const first = f.adapt();
    f.report.artifacts.push(...['trace', 'video', 'log'].map((kind) => ({
        id: `diagnostic-${kind}`, memberId: 'member-dom', kind, role: 'diagnostic', path: `${kind}.bin`, digest: digest('d')
    })));
    f.report.diagnostics.generatedAt = '2030-01-01T00:00:00Z';
    const second = f.adapt();
    assert.deepEqual(first.outcome, second.outcome);
    for (const artifact of f.report.artifacts.filter((entry) => entry.role === 'diagnostic'))
    {
        artifact.path = `relocated/${artifact.path}`;
        artifact.digest = digest('e');
    }
    assert.deepEqual(second.outcome, f.adapt().outcome);
});

test('cross browser and project evidence is refused even when resealed', (t) =>
{
    const f = fixture(t);
    const original = structuredClone(f.report.members[0]);
    f.report.members[0].browserId = 'firefox';
    assert.throws(f.adapt, /member browserId mismatch/u);
    f.report.members[0] = { ...original, projectId: 'admin' };
    assert.throws(f.adapt, /member projectId mismatch/u);
});

test('cross run source build replay temporal envelope policy and runtime bindings are refused', (t) =>
{
    const f = fixture(t);
    for (const field of Object.keys(f.authority.identity))
    {
        const original = f.report.identity[field];
        f.report.identity[field] = field === 'sourceCommit' ? 'f'.repeat(40) : digest('f');
        assert.throws(f.adapt, /held identity mismatch/u);
        f.report.identity[field] = original;
    }
    f.report.policyDigest = digest('f');
    assert.throws(f.adapt, /held policyDigest mismatch/u);
    f.report.policyDigest = f.authority.policyDigest;
    f.report.runtimeIdentities[0].runtimeDigest = digest('f');
    assert.throws(f.adapt, /held runtimeIdentities mismatch/u);
});

test('cross attempt evidence is refused and unqualified authority preserves a failed candidate', (t) =>
{
    const f = fixture(t);
    f.report.attemptEligibility.attemptDigest = digest('f');
    assert.throws(f.adapt, /held attemptEligibility mismatch/u);
    f.report.attemptEligibility.attemptDigest = f.authority.attemptEligibility.attemptDigest;
    for (const mutation of [ { attemptNumber: 2 }, { qualificationEligible: false }, { cleanFirstAttempt: false }, { firstFailure: true } ])
    {
        const original = structuredClone(f.authority.attemptEligibility);
        for (const document of [f.authority, f.catalog, f.plan, f.report])
        {
            Object.assign(document.attemptEligibility, mutation);
        }
        const result = f.adapt();
        assert.equal(result.outcome.status, 'failed');
        assert.equal(result.outcome.reasons[0].identity.evidenceId, 'clean-first-attempt');
        assert.equal(result.outcome.membership.executedMemberIds.length, 4);
        for (const document of [f.authority, f.catalog, f.plan, f.report])
        {
            document.attemptEligibility = structuredClone(original);
        }
    }
});

test('unknown kind wrong assertion and wrong attempt failure identities are refused', (t) =>
{
    const f = fixture(t);
    f.fail(0, 'unknown.failure');
    assert.throws(f.adapt, /unknown canonical failure/u);
    f.fail(0, 'product.assertion');
    f.report.members[0].failures[0].identity.assertionId = 'other-assertion';
    assert.throws(f.adapt, /canonical failure identity mismatch/u);
    f.fail(0, 'infra.browser-crash');
    f.report.members[0].failures[0].identity.attemptNumber = 2;
    assert.throws(f.adapt, /canonical failure identity mismatch/u);
});

test('service environment and toolchain kinds consume explicit structured identities', (t) =>
{
    const f = fixture(t);
    for (const kind of ['infra.service-readiness', 'infra.environment-mismatch', 'infra.toolchain-mismatch'])
    {
        interrupt(f, kind);
        const result = f.adapt();
        assert.equal(result.outcome.reasons[0].kind, kind);
        assert.equal(result.outcome.status, 'failed');
    }
});

test('semantic artifact byte tamper and path escape are refused', (t) =>
{
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'dom.bin'), 'tampered bytes');
    assert.throws(f.adapt, /artifact content digest mismatch/u);
    f.report.artifacts[0].path = '../outside.bin';
    assert.throws(f.adapt, /contained and canonical/u);
});

test('report byte tamper and resealed byte reference with stale receipt seal are refused', (t) =>
{
    const f = fixture(t);
    f.write();
    const file = path.join(f.root, 'report.json');
    const report = JSON.parse(fs.readFileSync(file));
    report.groupStatus = 'failed';
    const bytes = Buffer.from(JSON.stringify(report));
    fs.writeFileSync(file, bytes);
    assert.throws(() => adaptBrowserContractSemanticOutcome({ repositoryRoot: f.root, authority: f.authority }), /artifact content digest mismatch/u);
    f.authority.inputAuthorityRefs.find((ref) => ref.kind === 'browser-contract-report').digest = fileDigest(bytes);
    assert.throws(() => adaptBrowserContractSemanticOutcome({ repositoryRoot: f.root, authority: f.authority }), /receipt seal mismatch/u);
});

test('plan/catalog drift and duplicate planned assertion tuples are refused', (t) =>
{
    const f = fixture(t);
    f.plan.members[0].assertionId = 'other';
    assert.throws(f.adapt, /plan\/catalog membership mismatch/u);
    f.plan.members[0] = structuredClone(f.plan.members[1]);
    f.plan.members[0].id = 'other-member';
    f.plan.members[0].artifacts = [];
    f.catalog.members = structuredClone(f.plan.members);
    assert.throws(f.adapt, /duplicate IDs/u);
});

test('diagnostic promotion orphan digest and duplicate artifacts are refused', (t) =>
{
    const f = fixture(t);
    f.report.artifacts.push({ id: 'trace', memberId: 'member-dom', kind: 'trace', role: 'correctness', path: 'trace.zip', digest: digest('d') });
    assert.throws(f.adapt, /orphan semantic artifact/u);
    f.report.artifacts.pop();
    f.report.artifacts.push(f.report.artifacts[0]);
    assert.throws(f.adapt, /duplicate IDs/u);
});

test('artifact symlink and missing independent references are refused', (t) =>
{
    const f = fixture(t);
    fs.renameSync(path.join(f.root, 'dom.bin'), path.join(f.root, 'original.bin'));
    fs.symlinkSync('original.bin', path.join(f.root, 'dom.bin'));
    assert.throws(f.adapt, /symlink/u);
    assert.throws(() => adaptBrowserContractSemanticOutcome({ repositoryRoot: f.root, authority: { ...f.authority, inputAuthorityRefs: [] } }), /held input kinds mismatch/u);
});

test('passed missing correctness artifact and failed missing canonical failure are refused', (t) =>
{
    const f = fixture(t);
    f.report.members[0].artifactIds = [];
    assert.throws(f.adapt, /passed correctness artifact membership mismatch/u);
    f.report.members[0].artifactIds = ['artifact-dom'];
    f.report.members[0].status = 'failed';
    f.report.groupStatus = 'failed';
    assert.throws(f.adapt, /failure topology is inconsistent/u);
});

test('correctness file relocation keeps semantic outcome and new unregistered report fields fail closed', (t) =>
{
    const f = fixture(t);
    const first = f.adapt();
    fs.renameSync(path.join(f.root, 'dom.bin'), path.join(f.root, 'relocated.bin'));
    f.report.artifacts[0].path = 'relocated.bin';
    assert.deepEqual(first.outcome, f.adapt().outcome);
    f.report.futureStatus = 'success';
    assert.throws(f.adapt, /fields do not exactly/u);
});

test('declared correctness cannot be relabeled diagnostic after an assertion failure', (t) =>
{
    const f = fixture(t);
    f.fail(0, 'product.assertion');
    f.report.members[0].artifactIds = [];
    f.report.artifacts[0].role = 'diagnostic';
    assert.throws(f.adapt, /diagnostic promotion/u);
});

test('member and digest sets retain canonical order across mixed-case Unicode identifiers and input permutation', (t) =>
{
    const f = fixture(t);
    for (const [index, id] of ['ä', 'Z', 'a', 'é'].entries())
    {
        const original = f.plan.members[index].id;
        f.plan.members[index].id = id;
        f.catalog.members[index].id = id;
        f.report.members[index].id = id;
        f.report.artifacts.find((artifact) => artifact.memberId === original).memberId = id;
    }
    const first = f.adapt();
    const membership = first.outcome.membership;
    assert.deepEqual(membership.members.map((member) => member.id), membership.plannedMemberIds);
    assert.deepEqual(membership.executedMemberIds, membership.plannedMemberIds);
    assert.deepEqual(membership.passedMemberIds, membership.plannedMemberIds);
    f.plan.members.reverse();
    f.catalog.members.reverse();
    f.report.members.reverse();
    f.report.artifacts.reverse();
    assert.deepEqual(first.outcome, f.adapt().outcome);
});
