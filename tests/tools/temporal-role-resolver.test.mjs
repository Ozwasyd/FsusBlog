import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const {validateJsonSchema} = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));
const {defaultTimeoutPolicyDigest, qualificationTemporalContext, semanticOutcomeDigest} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {createTemporalDomainProducerReceipt, projectTemporalRolesForBrowser, projectTemporalRolesForDotNet, projectTemporalRolesForPostgres, requireResolvedTemporalRole, requireResolvedTemporalEntityRole, resolveTemporalEntityRoles, resolveTemporalRoles, resolveTemporalRolesForProducer, verifyResolvedTemporalArtifact} = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const sourceCommit = 'a'.repeat(40);
const sourceFingerprint = `sha256:${'b'.repeat(64)}`;

function context(producerId = 'auth-session', overrides = {})
{
    return qualificationTemporalContext({
        sourceCommit,
        sourceFingerprint,
        producerId,
        schedulerRunId: 'temporal-role-test',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest(),
        ...overrides
    });
}

function identity(producerId = 'auth-session', overrides = {})
{
    return {
        producerId,
        runId: 'temporal-role-test',
        namespace: 'test_namespace',
        fixtureId: 'auth-basic',
        ...overrides
    };
}

test('resolver emits a schema-valid deterministic artifact and producer receipt', () =>
{
    const temporalContext = context();
    const first = resolveTemporalRolesForProducer({
        temporalContext,
        namespace: 'test_namespace',
        fixtureId: 'auth-basic'
    });
    const second = resolveTemporalRolesForProducer({
        temporalContext,
        namespace: 'test_namespace',
        fixtureId: 'auth-basic'
    });
    assert.deepEqual(first, second);
    assert.deepEqual(verifyResolvedTemporalArtifact(first, { temporalContext }), {
        qualificationEligible: true,
        roleCount: first.roles.length,
        semanticDigest: first.semanticDigest,
        contentDigest: first.contentDigest
    });
    const schema = JSON.parse(readFileSync(
        path.join(repositoryRoot, 'config/testing/resolved-temporal-roles.schema.json'),
        'utf8'
    ));
    assert.deepEqual(validateJsonSchema(first, schema), []);
    const receipt = createTemporalDomainProducerReceipt(first);
    assert.equal(receipt.producerId, 'auth-session');
    assert.equal(receipt.resolvedArtifactDigest, first.contentDigest);
    assert.ok(receipt.roles.every((role) => !('instantUtc' in role)));
    const receiptSchema = JSON.parse(readFileSync(
        path.join(repositoryRoot, 'config/testing/temporal-domain-producer-receipt.schema.json'),
        'utf8'
    ));
    assert.deepEqual(validateJsonSchema(receipt, receiptSchema), []);
});

test('Node PostgreSQL .NET and browser adapters preserve exact cross-runtime identity', () =>
{
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context(),
        namespace: 'default',
        fixtureId: 'auth-basic'
    });
    const postgres = projectTemporalRolesForPostgres(artifact);
    const dotnet = projectTemporalRolesForDotNet(artifact);
    const browser = projectTemporalRolesForBrowser(artifact);
    assert.equal(postgres.semanticDigest, artifact.semanticDigest);
    assert.equal(dotnet.semanticDigest, artifact.semanticDigest);
    assert.equal(browser.semanticDigest, artifact.semanticDigest);
    for (const role of artifact.roles)
    {
        assert.equal(
            postgres.roles.find((candidate) => candidate.roleId === role.roleId).timestamptzLiteral,
            `timestamptz '${role.instantUtc}'`
        );
        assert.equal(
            dotnet.roles.find((candidate) => candidate.roleId === role.roleId).unixTimeMilliseconds,
            role.epochMilliseconds
        );
        assert.deepEqual(
            browser.roles.find((candidate) => candidate.roleId === role.roleId).localRepresentation,
            role.localRepresentation
        );
    }
});

test('auth producer resolves exact standard and remember-me session lifetimes', () =>
{
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context(),
        namespace: 'default',
        fixtureId: 'auth-session-policy'
    });
    const offsets = new Map(artifact.roles.map((role) => [role.roleId, role.sourceOffsetMilliseconds]));
    assert.equal(offsets.get('session.idle-expiry'), 7 * 86_400_000);
    assert.equal(offsets.get('session.absolute-expiry'), 30 * 86_400_000);
    assert.equal(offsets.get('session.persistent-idle-expiry'), 30 * 86_400_000);
    assert.equal(offsets.get('session.persistent-absolute-expiry'), 90 * 86_400_000);
    assert(artifact.relations.some((relation) =>
        relation.id === 'session-persistent-lifetime'));

    const inventory = readFileSync(
        path.join(repositoryRoot, 'config/testing/temporal-domain-producer-inventory.json'),
        'utf8'
    );
    assert.match(inventory, /sys-user-session\.remember-me-absoluteexpiresat/u);
    const producer = readFileSync(
        path.join(repositoryRoot, 'tests/frontend/support/session-fixtures.mjs'),
        'utf8'
    );
    assert.match(producer, /rememberMe \? 'session\.persistent-idle-expiry' : 'session\.idle-expiry'/u);
    assert.match(producer, /rememberMe \? 'session\.persistent-absolute-expiry' : 'session\.absolute-expiry'/u);
    const endpoint = readFileSync(
        path.join(repositoryRoot, 'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs'),
        'utf8'
    );
    assert.match(endpoint, /RequireInstant\("session\.persistent-idle-expiry"\)/u);
});

test('UTC midnight leap day month year and DST projections are exact and explicit', () =>
{
    const temporalContext = context('comment-moderation');
    const resolve = (shapeId) => resolveTemporalRoles({
        temporalContext,
        shapeId,
        fixtureIdentity: identity('comment-moderation', { fixtureId: shapeId })
    });
    const calendar = resolve('calendar-boundaries');
    assert.equal(calendar.roles[0].instantUtc, '2024-02-29T23:59:59.000Z');
    assert.equal(calendar.roles[1].instantUtc, '2024-03-01T00:00:00.000Z');
    const year = resolve('year-boundary');
    assert.equal(year.roles[0].instantUtc, '2024-12-31T23:59:59.000Z');
    assert.equal(year.roles[1].instantUtc, '2025-01-01T00:00:00.000Z');
    const forward = resolve('dst-forward');
    assert.equal(forward.projection.timezone, 'America/Los_Angeles');
    assert.deepEqual(
        forward.roles.map((role) => [role.localRepresentation.hour, role.localRepresentation.timeZoneOffset]),
        [['01', 'GMT-08:00'], ['03', 'GMT-07:00']]
    );
    const backward = resolve('dst-backward');
    assert.deepEqual(
        backward.roles.map((role) => role.localRepresentation.timeZoneOffset),
        ['GMT-07:00', 'GMT-08:00']
    );
});

test('same-timestamp uses the formal product tie-breaker without microsecond offsets', () =>
{
    const artifact = resolveTemporalRoles({
        temporalContext: context('account-messaging'),
        shapeId: 'same-timestamp-tie',
        fixtureIdentity: identity('account-messaging', { fixtureId: 'message-tie' })
    });
    assert.equal(artifact.roles[0].instantUtc, artifact.roles[1].instantUtc);
    assert.equal(artifact.roles[0].sourceOffsetMilliseconds, 0);
    assert.equal(artifact.roles[1].sourceOffsetMilliseconds, 0);
    assert.equal(artifact.relations[0].tieBreakerId, 'message-id-ascending');
});

test('scheduled expiry retention and out-of-order boundaries resolve without sleeps', () =>
{
    const temporalContext = context('account-messaging');
    for (const [shapeId, expected] of [
        ['scheduled-before', [-1, 0]],
        ['scheduled-at', [0, 0]],
        ['scheduled-after', [0, 1]],
        ['expiry-before', [-1, 0]],
        ['expiry-at', [0, 0]],
        ['expiry-after', [0, 1]],
        ['retention-boundaries', [-1, 0, 1]],
        ['out-of-order-arrival', [-1000, 1000, 2000]]
    ])
    {
        const artifact = resolveTemporalRoles({
            temporalContext,
            shapeId,
            fixtureIdentity: identity('account-messaging', { fixtureId: shapeId })
        });
        assert.deepEqual(
            artifact.roles.map((role) => role.sourceOffsetMilliseconds),
            expected,
            shapeId
        );
        assert.ok(artifact.clockAdvancePlan.every((step) =>
            step.clockKind === 'business-wall'
            && step.monotonicClockEffect === 'none'
            && step.advanceByMilliseconds > 0));
    }
});

test('host timezone and metadata clock drift do not change semantic business identity', () =>
{
    const script = `
      import { defaultTimeoutPolicyDigest, qualificationTemporalContext } from './tools/test/temporal-context.mjs';
      import { resolveTemporalRoles } from './tools/test/temporal-role-resolver.mjs';
      const temporalContext = qualificationTemporalContext({
        sourceCommit: '${sourceCommit}',
        sourceFingerprint: '${sourceFingerprint}',
        producerId: 'comment-moderation',
        schedulerRunId: 'temporal-role-test',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US', uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
      });
      const artifact = resolveTemporalRoles({
        temporalContext,
        shapeId: 'dst-forward',
        fixtureIdentity: { producerId: 'comment-moderation', runId: 'temporal-role-test', namespace: 'host', fixtureId: 'dst-forward' }
      });
      process.stdout.write(artifact.semanticDigest);
    `;
    const digests = ['UTC', 'Asia/Shanghai', 'America/New_York'].map((TZ) =>
    {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...process.env, TZ }
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    });
    assert.equal(new Set(digests).size, 1);
    assert.equal(
        semanticOutcomeDigest({ value: 'stable', generatedAt: '2026-01-01T00:00:00.000Z' }),
        semanticOutcomeDigest({ value: 'stable', generatedAt: '2030-01-01T00:00:00.000Z' })
    );
});

test('resolver fails closed on unknown duplicate missing context and precision loss', () =>
{
    const temporalContext = context();
    assert.throws(
        () => resolveTemporalRoles({
            temporalContext,
            shapeId: 'unknown-shape',
            fixtureIdentity: identity()
        }),
        (error) => error.reasonCode === 'temporal.shape-unknown'
    );
    assert.throws(
        () => resolveTemporalRoles({
            temporalContext,
            shapeId: 'same-timestamp-tie',
            fixtureIdentity: identity(),
            roleIds: ['message.created', 'message.created']
        }),
        (error) => error.reasonCode === 'temporal.role-duplicate'
    );
    assert.throws(
        () => resolveTemporalRoles({
            temporalContext,
            shapeId: 'same-timestamp-tie',
            fixtureIdentity: identity('security-state')
        }),
        (error) => error.reasonCode === 'temporal.resolver-context-mismatch'
    );
    const excessivePrecision = {
        ...temporalContext,
        businessEpochUtc: '2024-02-29T23:59:59.0000001Z'
    };
    assert.throws(
        () => resolveTemporalRoles({
            temporalContext: excessivePrecision,
            shapeId: 'same-timestamp-tie',
            fixtureIdentity: identity()
        }),
        (error) => error.reasonCode === 'temporal.precision-loss'
    );
});

test('zero one and excessive role plans stay bounded', () =>
{
    const temporalContext = context('account-messaging');
    const base = {
        temporalContext,
        shapeId: 'same-timestamp-tie',
        fixtureIdentity: identity('account-messaging', { fixtureId: 'bounded' })
    };
    assert.equal(resolveTemporalRoles({ ...base, roleIds: [] }).roles.length, 0);
    assert.equal(resolveTemporalRoles({ ...base, roleIds: ['message.created'] }).roles.length, 1);
    assert.throws(
        () => resolveTemporalRoles({ ...base, roleIds: Array(1001).fill('message.created') }),
        /bounded array/u
    );
});

test('artifact and role tamper fail before qualification', () =>
{
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context(),
        namespace: 'default',
        fixtureId: 'auth-basic'
    });
    const roleTamper = structuredClone(artifact);
    roleTamper.roles[0].instantUtc = '2030-01-01T00:00:00.000Z';
    assert.throws(
        () => verifyResolvedTemporalArtifact(roleTamper),
        (error) => error.reasonCode === 'temporal.resolved-artifact-tamper'
    );
    const receiptTamper = structuredClone(artifact);
    receiptTamper.contentDigest = `sha256:${'0'.repeat(64)}`;
    assert.throws(
        () => verifyResolvedTemporalArtifact(receiptTamper),
        (error) => error.reasonCode === 'temporal.resolved-artifact-tamper'
    );
    assert.throws(
        () => requireResolvedTemporalRole(artifact, 'session.unknown'),
        (error) => error.reasonCode === 'temporal.role-missing'
    );
});

function ordinaryEntityPlan()
{
    const fact = (instantUtc) => ({ applicability: instantUtc === null ? 'null' : 'instant', instantUtc });
    const article = (semanticIdentity, ordinal, revisionNumber, publicationNumber, state, revisionAt, metadataAt) => ({
        coordinate: { entityKind: 'article', semanticIdentity, operationIdentity: `revision-${revisionNumber}`, ordinal,
            revisionNumber, publicationNumber, publicationRevisionNumber: publicationNumber === null ? null : 1, articleIdentity: null },
        state, stateFacts: { hasRevision: true, hasPublication: publicationNumber !== null }, facts: {
            'article.created': fact('2024-02-29T23:59:40.000Z'), 'article.revision': fact(revisionAt),
            'article.metadata-updated': fact(metadataAt),
            'article.publication': (publicationNumber === null ? { applicability: 'not-generated', instantUtc: null } : fact('2024-02-29T23:59:50.000Z')),
            'article.published': fact(publicationNumber === null ? null : '2024-02-29T23:59:50.000Z')
        }
    });
    return {
        schema: 'fsusblog.temporal-entity-plan.v1', sourcePlanDigest: sourceFingerprint,
        distribution: { kind: 'demo', tier: null, ordinalBase: 1, counts: { article: 2, comment: 1, audit: 1 },
            stateCounts: { article: { draft: 1, scheduled: 1, published: 0, archived: 0, deleted: 0 },
                comment: { approved: 1, pending: 0, rejected: 0, deleted: 0 }, audit: { recorded: 1 } },
            rootNested: [{ commentIdentity: 'root-comment', parentIdentity: null, rootIdentity: null }] },
        entities: [
            article('scheduled-article', 1, 1, 1, 'published', '2024-02-29T23:59:45.000Z', '2024-02-29T23:59:45.000Z'),
            article('scheduled-article', 1, 2, 1, 'scheduled', '2024-02-29T23:59:55.000Z', '2024-02-29T23:59:55.000Z'),
            article('draft-article', 2, 1, null, 'draft', '2024-02-29T23:59:45.000Z', '2024-02-29T23:59:45.000Z'),
            { coordinate: { entityKind: 'comment', semanticIdentity: 'root-comment', operationIdentity: 'moderation', ordinal: 1,
                revisionNumber: 1, publicationNumber: null, publicationRevisionNumber: null, articleIdentity: 'scheduled-article' },
            state: 'approved', stateFacts: { hasRevision: true, hasEditTime: false, hasModerationTime: true }, facts: {
                'comment.created': fact('2024-02-29T23:59:46.000Z'), 'comment.edited': fact(null),
                'comment.moderated': fact('2024-02-29T23:59:48.000Z') } },
            { coordinate: { entityKind: 'audit', semanticIdentity: 'fixture-audit', operationIdentity: 'create', ordinal: 1,
                revisionNumber: null, publicationNumber: null, publicationRevisionNumber: null, articleIdentity: null },
            state: 'recorded', stateFacts: {}, facts: { 'audit.occurred': fact('2024-02-29T23:59:40.000Z') } }
        ]
    };
}

function resolveOrdinaryEntityPlan(entityPlan = ordinaryEntityPlan(), producerId = 'development-demo')
{
    return resolveTemporalRolesForProducer({ temporalContext: context(producerId), namespace: 'ordinary',
        fixtureId: 'entity-history', planDigest: sourceFingerprint, entityPlan });
}

test('entity resolver consumes explicit histories and nullable states with complete role closure', () =>
{
    const artifact = resolveOrdinaryEntityPlan();
    assert.equal(artifact.schema, 'fsusblog.resolved-temporal-entities.v1');
    assert.equal(artifact.qualificationEligible, false);
    assert.equal(artifact.entities.length, 5);
    const opaque = ordinaryEntityPlan();
    opaque.entities[0].coordinate.semanticIdentity = 'demo:article:english';
    opaque.entities[1].coordinate.semanticIdentity = 'demo:article:english';
    opaque.entities[3].coordinate.articleIdentity = 'demo:article:english';
    assert.equal(resolveOrdinaryEntityPlan(opaque).entities[0].coordinate.semanticIdentity, 'demo:article:english');
    assert.equal(requireResolvedTemporalEntityRole(artifact, { entityKind: 'comment', semanticIdentity: 'root-comment', operationIdentity: 'moderation' }, 'comment.edited', { temporalContext: context('development-demo') }).instantUtc, null);
    assert.equal(artifact.entities[1].relations[0].status, 'verified');
    assert.deepEqual(artifact.entities[2].relations[0].nullRoleIds, ['article.publication']);
    assert.deepEqual(artifact.entities[3].relations[0].roleIds, ['comment.created', 'comment.edited', 'comment.moderated']);
    assert.deepEqual(artifact.entities[3].relations[0].nullRoleIds, ['comment.edited']);
    assert.equal(requireResolvedTemporalRole(artifact.scalarRoles, 'profile.created').epochMilliseconds, Date.parse(context().businessEpochUtc));
    assert.equal(requireResolvedTemporalRole(artifact.scalarRoles, 'audit.occurred').epochMilliseconds, Date.parse(context().businessEpochUtc) + 120000);
    const schema = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/testing/resolved-temporal-roles.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(artifact, schema), []);
    assert.equal(verifyResolvedTemporalArtifact(artifact, { temporalContext: context('development-demo') }).qualificationEligible, false);
});

test('entity producer registrations refuse absent ordinary inputs and incomplete comment closure', () =>
{
    assert.throws(() => resolveTemporalRolesForProducer({ temporalContext: context('development-demo'), namespace: 'ordinary',
        fixtureId: 'entity-history', planDigest: sourceFingerprint }), /entityPlan requires/u);
    const plan = ordinaryEntityPlan();
    delete plan.entities[3].facts['comment.edited'];
    assert.throws(() => resolveOrdinaryEntityPlan(plan), /complete entity role closure/u);
    const absentState = ordinaryEntityPlan();
    delete absentState.entities[3].stateFacts.hasModerationTime;
    assert.throws(() => resolveOrdinaryEntityPlan(absentState), /stateFacts requires/u);
});

test('entity plans reject ordinary inconsistent lifecycle coordinates and distributions', () =>
{
    const change = (mutate, pattern) =>
    {
        const plan = ordinaryEntityPlan();
        mutate(plan);
        assert.throws(() => resolveOrdinaryEntityPlan(plan), pattern);
    };
    change((plan) =>
    {
        plan.entities[0].facts['article.revision'].instantUtc = '2024-02-29T23:59:51.000Z';
    }, /cross-field invariant/u);
    change((plan) =>
    {
        plan.entities[1].coordinate.publicationRevisionNumber = 3;
    }, /coordinates are inconsistent/u);
    change((plan) =>
    {
        plan.entities[2].facts['article.publication'].instantUtc = '2024-02-29T23:59:50.000Z';
    }, /explicitly declare/u);
    change((plan) =>
    {
        plan.distribution.counts.article = 3;
    }, /count\/ordinal distribution/u);
    change((plan) =>
    {
        plan.distribution.rootNested = [];
    }, /cover every comment/u);
    change((plan) =>
    {
        plan.entities[3].facts['comment.moderated'].instantUtc = '2024-02-29T23:59:44.000Z';
    }, /cross-field invariant/u);
});

test('scale entity API requires the declared tier and actual complete distribution', () =>
{
    const plan = ordinaryEntityPlan();
    plan.distribution.kind = 'scale';
    plan.distribution.tier = 'scale-s';
    plan.entities.pop();
    plan.distribution.counts.audit = 0;
    plan.distribution.stateCounts.audit.recorded = 0;
    const artifact = resolveOrdinaryEntityPlan(plan, 'scale-data');
    assert.equal(artifact.scalarRoles, null);
    assert.equal(artifact.entityPlan.distribution.tier, 'scale-s');
    delete plan.distribution.tier;
    assert.throws(() => resolveOrdinaryEntityPlan(plan, 'scale-data'), /distribution requires/u);
    assert.throws(() => resolveTemporalEntityRoles({ temporalContext: context('scale-data'),
        fixtureIdentity: identity('scale-data', { fixtureId: 'entity-history', planDigest: sourceFingerprint }),
        shapeId: 'article-comment-entity-lifecycle', entityPlan: plan }), /distribution requires/u);
});

test('entity source facts preserve approved and pending nullable comments and distinct audits', () =>
{
    // Exact ordinary facts supplied from #2532 source b1fcfcb70d402e5e970804443d167530962b3b69.
    // Other entities retain the isolated test plan; this is not a demo runtime distribution receipt.
    const plan = ordinaryEntityPlan();
    const comment = plan.entities[3];
    comment.coordinate.operationIdentity = 'created';
    comment.stateFacts.hasModerationTime = false;
    comment.facts['comment.created'].instantUtc = '2026-06-02T11:00:00Z';
    comment.facts['comment.moderated'] = { applicability: 'null', instantUtc: null };
    comment.state = 'pending';
    plan.distribution.stateCounts.comment.approved = 0;
    plan.distribution.stateCounts.comment.pending = 1;
    const temporalContext = context('development-demo', { businessEpochUtc: '2026-06-04T00:00:00.000Z' });
    const resolve = () => resolveTemporalRolesForProducer({ temporalContext, namespace: 'ordinary',
        fixtureId: 'source-facts', planDigest: sourceFingerprint, entityPlan: plan });
    const audit = plan.entities[4];
    audit.coordinate.semanticIdentity = 'audit-security';
    audit.facts['audit.occurred'].instantUtc = '2026-06-01T12:00:00Z';
    const moderationAudit = structuredClone(audit);
    moderationAudit.coordinate.semanticIdentity = 'audit-moderation';
    moderationAudit.coordinate.ordinal = 2;
    moderationAudit.facts['audit.occurred'].instantUtc = '2026-06-02T12:00:00Z';
    plan.entities.push(moderationAudit);
    plan.distribution.counts.audit = 2;
    plan.distribution.stateCounts.audit.recorded = 2;
    const pending = resolve();
    const schema = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/testing/resolved-temporal-roles.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(pending, schema), []);
    assert.equal(pending.entities[3].roles.find((role) => role.roleId === 'comment.moderated').applicability, 'null');
    assert.equal(pending.entities[3].roles.find((role) => role.roleId === 'comment.edited').applicability, 'null');
    assert.equal(pending.entities[3].relations[1].parentIdentity, null);
    assert.equal(pending.scalarRolesPurpose, 'canonical-planned-offsets');
    assert.notEqual(pending.entities[4].roles[0].instantUtc, pending.entities[5].roles[0].instantUtc);
    assert.ok(pending.unsupportedFields.some((field) => field.field === 'profile.created-at'));
    comment.state = 'approved';
    comment.coordinate.revisionNumber = null;
    comment.stateFacts.hasRevision = false;
    plan.distribution.stateCounts.comment.approved = 1;
    plan.distribution.stateCounts.comment.pending = 0;
    assert.equal(resolve().entities[3].coordinate.revisionNumber, null);
});

test('scale entity facts preserve ungenerated histories and reject invented generic rows', () =>
{
    const plan = ordinaryEntityPlan();
    plan.distribution.kind = 'scale';
    plan.distribution.tier = 'scale-s';
    plan.entities.pop();
    plan.distribution.counts.audit = 0;
    plan.distribution.stateCounts.audit.recorded = 0;
    const article = plan.entities[2];
    article.state = 'scheduled';
    article.stateFacts.hasRevision = false;
    article.coordinate.revisionNumber = null;
    article.facts['article.revision'] = { applicability: 'not-generated', instantUtc: null };
    plan.distribution.stateCounts.article.draft = 0;
    plan.distribution.stateCounts.article.scheduled = 2;
    const artifact = resolveOrdinaryEntityPlan(plan, 'scale-data');
    const schema = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/testing/resolved-temporal-roles.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(artifact, schema), []);
    assert.equal(artifact.entities[2].roles.find((role) => role.roleId === 'article.revision').applicability, 'not-generated');
    assert.equal(artifact.entities[2].roles.find((role) => role.roleId === 'article.published').applicability, 'null');
    assert.ok(artifact.unsupportedFields.some((field) => field.field === 'row.created-at'));
    article.coordinate.entityKind = 'row';
    assert.throws(() => resolveOrdinaryEntityPlan(plan, 'scale-data'), /kind\/state is unsupported/u);
});

test('entity original demo and scale chronology conflicts remain refused without corrected facts', () =>
{
    const demo = ordinaryEntityPlan();
    const article = demo.entities[0];
    article.facts['article.created'].instantUtc = '2026-06-01T10:00:00Z';
    article.facts['article.revision'].instantUtc = '2026-06-01T10:05:00Z';
    article.facts['article.metadata-updated'].instantUtc = '2026-06-01T10:00:00Z';
    article.facts['article.publication'].instantUtc = '2026-06-01T10:00:00Z';
    article.facts['article.published'].instantUtc = '2026-06-01T10:00:00Z';
    demo.entities.splice(1, 1);
    demo.distribution.stateCounts.article.scheduled = 0;
    demo.distribution.stateCounts.article.published = 1;
    assert.throws(() => resolveTemporalRolesForProducer({ temporalContext: context('development-demo',
        { businessEpochUtc: '2026-06-04T00:00:00.000Z' }), namespace: 'ordinary', fixtureId: 'source-facts',
    planDigest: sourceFingerprint, entityPlan: demo }), /cross-field invariant/u);
    const scale = ordinaryEntityPlan();
    scale.entities[0].facts['article.created'].instantUtc = '2024-02-29T23:59:58.000Z';
    scale.entities[0].facts['article.revision'].instantUtc = '2024-02-29T23:59:59.000Z';
    scale.entities[0].facts['article.metadata-updated'].instantUtc = '2024-02-29T23:59:59.000Z';
    scale.entities[0].facts['article.publication'].instantUtc = '2024-02-28T23:59:59.000Z';
    scale.entities[0].facts['article.published'].instantUtc = '2024-02-28T23:59:59.000Z';
    scale.entities.splice(1, 1);
    scale.distribution.stateCounts.article.scheduled = 0;
    scale.distribution.stateCounts.article.published = 1;
    assert.throws(() => resolveOrdinaryEntityPlan(scale), /cross-field invariant/u);
    const nested = ordinaryEntityPlan();
    nested.entities[3].coordinate.revisionNumber = null;
    nested.entities[3].stateFacts = { hasRevision: false, hasEditTime: false, hasModerationTime: false };
    nested.entities[3].facts['comment.created'].instantUtc = '2024-02-29T23:59:58.000Z';
    nested.entities[3].facts['comment.moderated'] = { applicability: 'null', instantUtc: null };
    const child = structuredClone(nested.entities[3]);
    child.coordinate.semanticIdentity = 'nested-comment';
    child.coordinate.ordinal = 2;
    child.facts['comment.created'].instantUtc = '2024-02-29T23:59:57.000Z';
    nested.entities.push(child);
    nested.distribution.counts.comment = 2;
    nested.distribution.stateCounts.comment.approved = 2;
    nested.distribution.rootNested.push({ commentIdentity: 'nested-comment', parentIdentity: 'root-comment', rootIdentity: 'root-comment' });
    assert.throws(() => resolveOrdinaryEntityPlan(nested), /cross-field invariant/u);
});
