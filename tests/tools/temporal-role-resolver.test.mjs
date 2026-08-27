/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext,
    semanticOutcomeDigest
} from '../../tools/test/temporal-context.mjs';
import {
    createTemporalDomainProducerReceipt,
    projectTemporalRolesForBrowser,
    projectTemporalRolesForDotNet,
    projectTemporalRolesForPostgres,
    requireResolvedTemporalRole,
    resolveTemporalRoles,
    resolveTemporalRolesForProducer,
    verifyResolvedTemporalArtifact
} from '../../tools/test/temporal-role-resolver.mjs';
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs';

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
