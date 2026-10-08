import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { aggregateOptions, bindFixture, digest, producerFixture } from './support/semantic-outcome-analysis-fixture.mjs';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { prepareAggregateOutcomeAnalysis } = await import(new URL('../../tools/test-matrix/outcomes/aggregate-outcome-analysis.mjs', import.meta.url));
const { diffSemanticOutcomeData, runSemanticOutcomeDiffCli } = await import(new URL('../../tools/test-matrix/outcomes/semantic-outcome-diff.mjs', import.meta.url));

const moduleRoot = new URL('../../tools/test-matrix/outcomes/', import.meta.url);
const side = (member, metadata = {}) => ({ ...member, metadata, members: [] });

function changed(member, edit)
{
    const outcome = structuredClone(member.outcome);
    edit(outcome);
    return bindFixture(outcome, member.options);
}

function cliFixture(left, right)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'semantic-outcome-diff-'));
    const rawLeft = JSON.stringify(left);
    const rawRight = JSON.stringify(right);
    writeFileSync(path.join(root, 'left.json'), rawLeft);
    writeFileSync(path.join(root, 'right.json'), rawRight);
    const fileDigest = (raw) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const limits = left.options.hostExpectedLimits;
    const args = ['--root', root, '--left', 'left.json', '--left-digest', fileDigest(rawLeft),
        '--right', 'right.json', '--right-digest', fileDigest(rawRight), '--max-bytes', '8000000',
        '--max-depth', String(limits.maxDepth), '--max-nodes', String(limits.maxNodes),
        '--max-string-bytes', String(limits.maxStringBytes), '--max-array-items', String(limits.maxArrayItems),
        '--max-object-keys', String(limits.maxObjectKeys)];
    return { root, args };
}

test('equal strong outcomes emit all eleven empty categories with exact source identity', () =>
{
    const input = side(producerFixture());
    const result = diffSemanticOutcomeData(input, input);
    assert.equal(result.semanticDrift, false);
    assert.equal(result.inputsValidated, true);
    assert.equal(result.sourceRefs.left.contentDigest, input.outcome.contentDigest);
    for (const category of ['identityMismatch', 'planMismatch', 'missingTests', 'extraTests', 'statusChanges',
        'failureTopologyChanges', 'coverageChanges', 'stateDigestChanges', 'artifactDigestChanges', 'policyChanges', 'volatileOnlyChanges'])
    {
        assert.deepEqual(result[category], []);
    }
});

test('volatile fields are strictly registry-declared and diagnostics or locations are never called volatile', () =>
{
    const member = producerFixture();
    const result = diffSemanticOutcomeData(side(member, { durationMs: 1, pid: 1, port: 1, path: '/tmp/a', errorText: 'timeout' }),
        side(member, { durationMs: 2, pid: 2, port: 2, path: '/tmp/b', errorText: 'assertion' }));
    assert.equal(result.semanticDrift, false);
    assert.deepEqual(result.volatileOnlyChanges.map((item) => item.path), ['$metadata.durationMs', '$metadata.pid', '$metadata.port']);
    assert.ok(result.volatileOnlyChanges.every((item) => item.disposition === 'volatile-metadata'));
    assert.deepEqual(result.nonSemanticChanges.map((item) => item.path), ['$metadata.errorText', '$metadata.path']);
});

test('planned missing or extra test and same success status coverage changes are localized', () =>
{
    const member = producerFixture();
    const fewer = changed(member, (value) =>
    {
        value.plannedTestIds = value.plannedTestIds.slice(0, 1);
        value.executedTestIds = value.plannedTestIds;
        value.passedTestIds = value.plannedTestIds;
        value.assertions = value.assertions.slice(0, 1);
        value.coverageIds = [];
    });
    const result = diffSemanticOutcomeData(side(member), side(fewer));
    assert.equal(result.semanticDrift, true);
    assert.deepEqual(result.missingTests.map((item) => item.testId), ['test:0:b']);
    assert.ok(result.planMismatch.length > 0);
    assert.ok(result.coverageChanges.length > 0);
    assert.deepEqual(diffSemanticOutcomeData(side(fewer), side(member)).extraTests.map((item) => item.testId), ['test:0:b']);
});

test('same failed IDs with different canonical failure kind change topology independently of error text', () =>
{
    const member = producerFixture(0, 'failed');
    const next = changed(member, (value) =>
    {
        value.assertions[1].failureClass = 'infra';
        value.assertions[1].failureKind = 'infra.browser-crash';
        value.failures[0].failureClass = 'infra';
        value.failures[0].failureKind = 'infra.browser-crash';
        value.assertions[1].failureIdentity.attemptNumber = 1;
        value.failures[0].identity.attemptNumber = 1;
    });
    const result = diffSemanticOutcomeData(side(member, { errorText: 'same' }), side(next, { errorText: 'same' }));
    assert.equal(result.semanticDrift, true);
    assert.ok(result.failureTopologyChanges.some((item) => item.testId === 'test:0:b' && item.assertionId === 'assertion:0:1'));
    assert.deepEqual(member.outcome.failedTestIds, next.outcome.failedTestIds);
});

test('state artifact policy identity and execution plan changes remain distinct with both statuses successful', () =>
{
    const member = producerFixture();
    for (const [field, category] of [['stateSemanticDigests', 'stateDigestChanges'], ['artifactSemanticDigests', 'artifactDigestChanges'],
        ['policyDigests', 'policyChanges']])
    {
        const next = changed(member, (value) =>
        {
            value[field][0].digest = digest('different');
        });
        const result = diffSemanticOutcomeData(side(member), side(next));
        assert.equal(result.semanticDrift, true);
        assert.ok(result[category].some((item) => item.left.value !== item.right.value));
    }
    const identity = changed(member, (value) =>
    {
        value.sourceCommit = '2'.repeat(40);
    });
    assert.ok(diffSemanticOutcomeData(side(member), side(identity)).identityMismatch.length > 0);
    const plan = changed(member, (value) =>
    {
        value.replayPlanDigest = digest('different-plan');
    });
    assert.ok(diffSemanticOutcomeData(side(member), side(plan)).planMismatch.length > 0);
});

test('skip blocked partial and cancelled test transitions are retained without total-status shortcuts', () =>
{
    const member = producerFixture();
    const blocked = producerFixture(0, 'cancelled');
    const skipped = changed(blocked, (value) =>
    {
        value.skippedTestIds = value.blockedTestIds;
        value.blockedTestIds = [];
        value.assertions[1].status = 'skipped';
        value.producerStatus = 'partial';
    });
    const result = diffSemanticOutcomeData(side(blocked), side(skipped));
    assert.equal(result.semanticDrift, true);
    assert.ok(result.statusChanges.some((item) => item.path === '$.testStatus["test:0:b"]'
        && item.left.value === 'blocked' && item.right.value === 'skipped'));
    assert.ok(diffSemanticOutcomeData(side(member), side(blocked)).failureTopologyChanges.length > 0);
});

test('reordered arrays do not drift but duplicates invalid sets unknown fields and claimed fingerprints reject', () =>
{
    const member = producerFixture();
    const reordered = structuredClone(member.outcome);
    reordered.assertions.reverse();
    reordered.plannedTestIds.reverse();
    reordered.executedTestIds.reverse();
    reordered.passedTestIds.reverse();
    assert.equal(diffSemanticOutcomeData(side(member), side({ outcome: sealContentDigest(reordered), options: member.options })).semanticDrift, false);
    for (const edit of [
        (value) =>
        {
            value.plannedTestIds.push(value.plannedTestIds[0]);
        },
        (value) =>
        {
            value.executedTestIds = [];
        },
        (value) =>
        {
            value.newField = true;
        },
        (value) =>
        {
            value.outcomeFingerprint = digest('wrong');
        }
    ])
    {
        const value = structuredClone(member.outcome);
        edit(value);
        const options = structuredClone(member.options);
        options.expected.outcomeFingerprint = value.outcomeFingerprint;
        assert.throws(() => diffSemanticOutcomeData(side(member), side({ outcome: sealContentDigest(value), options })));
    }
    assert.throws(() => diffSemanticOutcomeData(side(member), side(member, { unknownBusinessClock: 1 })), /unknown/u);
});

test('incompatible schema algorithm and registry versions produce mismatch without direct equality', () =>
{
    const input = side(producerFixture());
    for (const field of ['schema', 'schemaVersion', 'fingerprintAlgorithmVersion'])
    {
        const next = structuredClone(input);
        next.outcome[field] = 'unsupported';
        const result = diffSemanticOutcomeData(input, next);
        assert.ok(result.versionMismatch);
        assert.equal(result.semanticDrift, null);
        assert.equal(result.comparisonPerformed, false);
        assert.equal(result.inputsValidated, false);
    }
    const next = structuredClone(input);
    next.options.fieldDispositions.schemaVersion = 'unsupported';
    assert.ok(diffSemanticOutcomeData(input, next).versionMismatch);
    assert.throws(() => diffSemanticOutcomeData(next, next), /invalid|version/u);
});

test('aggregate diff binds actual member refs status vector unions and failure topology', () =>
{
    const make = (members) =>
    {
        const options = aggregateOptions(members);
        const result = prepareAggregateOutcomeAnalysis(options, members);
        return { outcome: result.canonicalOutcome, options: { ...options, expected: { ...options.expected,
            aggregateOutcomeFingerprint: result.outcomeFingerprint } }, metadata: {}, members };
    };
    const first = make([producerFixture(0), producerFixture(1)]);
    const second = make([producerFixture(0), producerFixture(1, 'cancelled')]);
    const result = diffSemanticOutcomeData(first, second);
    assert.equal(result.semanticDrift, true);
    assert.ok(result.statusChanges.some((item) => item.schemaPath === '$.producerStatusVector[].status'));
    assert.ok(result.failureTopologyChanges.some((item) => item.producerId === second.members[1].outcome.producerId));
    assert.ok(result.artifactDigestChanges.some((item) => item.schemaPath === '$.producerOutcomeRefs[].outcomeFingerprint'));
});

test('CLI consumes only explicit content-addressed refs and rejects tamper aliases selectors and host-budget overrides', () =>
{
    const input = side(producerFixture());
    const fixture = cliFixture(input, input);
    try
    {
        assert.equal(runSemanticOutcomeDiffCli(fixture.args).exitCode, 0);
        assert.throws(() => runSemanticOutcomeDiffCli([...fixture.args, '--latest', 'true']), /explicit CLI/u);
        assert.throws(() => runSemanticOutcomeDiffCli([...fixture.args, '--mtime', 'true']), /explicit CLI/u);
        const badDigest = [...fixture.args];
        badDigest[badDigest.indexOf('--left-digest') + 1] = digest('wrong');
        assert.throws(() => runSemanticOutcomeDiffCli(badDigest), /reference content digest/u);
        const shortBudget = [...fixture.args];
        shortBudget[shortBudget.indexOf('--max-bytes') + 1] = '1';
        assert.throws(() => runSemanticOutcomeDiffCli(shortBudget), /byte budget/u);
        symlinkSync(path.join(fixture.root, 'left.json'), path.join(fixture.root, 'alias.json'));
        const alias = [...fixture.args];
        alias[alias.indexOf('--left') + 1] = 'alias.json';
        assert.throws(() => runSemanticOutcomeDiffCli(alias), /alias/u);
        const budgetOverride = [...fixture.args];
        budgetOverride[budgetOverride.indexOf('--max-nodes') + 1] = '99999';
        assert.throws(() => runSemanticOutcomeDiffCli(budgetOverride), /host budgets/u);
        const command = spawnSync(process.execPath, [new URL('semantic-outcome-diff.mjs', moduleRoot).pathname, ...fixture.args], { encoding: 'utf8' });
        assert.equal(command.status, 0, command.stderr);
        assert.equal(JSON.parse(command.stdout).dataOnly, true);
    }
    finally
    {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('CLI reports semantic drift as exit one and version or invalid-input rejection as exit two', () =>
{
    const member = producerFixture();
    const next = changed(member, (value) =>
    {
        value.stateSemanticDigests[0].digest = digest('other');
    });
    const fixture = cliFixture(side(member), side(next));
    try
    {
        assert.equal(runSemanticOutcomeDiffCli(fixture.args).exitCode, 1);
        const mismatch = structuredClone(side(next));
        mismatch.outcome.schemaVersion = 'unknown';
        const other = cliFixture(side(member), mismatch);
        try
        {
            assert.equal(runSemanticOutcomeDiffCli(other.args).exitCode, 2);
        }
        finally
        {
            rmSync(other.root, { recursive: true, force: true });
        }
        const command = spawnSync(process.execPath, [new URL('semantic-outcome-diff.mjs', moduleRoot).pathname, '--latest', 'true'], { encoding: 'utf8' });
        assert.equal(command.status, 2);
        assert.match(command.stderr, /explicit CLI/u);
    }
    finally
    {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('five source mutants are deterministically killed by semantic metadata unknown and failure-domain controls', async () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'semantic-outcome-mutants-'));
    const member = producerFixture();
    const other = changed(member, (value) =>
    {
        value.stateSemanticDigests[0].digest = digest('other');
    });
    const mutations = [
        { name: 'status-only', module: 'strong-outcome-analysis.mjs',
            before: 'outcomeFingerprint: digestCanonical({ version, semanticPayload })',
            after: 'outcomeFingerprint: digestCanonical({ version, status: canonical.producerStatus })',
            control: (api) => assert.notEqual(api.analyzeStrongSemanticOutcome(member.outcome, member.options).outcomeFingerprint,
                api.analyzeStrongSemanticOutcome(other.outcome, other.options).outcomeFingerprint) },
        { name: 'raw-json', module: 'strong-outcome-analysis.mjs',
            before: 'outcomeFingerprint: digestCanonical({ version, semanticPayload })',
            after: 'outcomeFingerprint: digestCanonical({ version, value, metadata })',
            control: (api) => assert.equal(api.analyzeStrongSemanticOutcome(member.outcome, member.options, { pid: 1 }).outcomeFingerprint,
                api.analyzeStrongSemanticOutcome(member.outcome, member.options, { pid: 2 }).outcomeFingerprint) },
        { name: 'unknown-ignore', module: 'strong-outcome-analysis.mjs',
            before: 'const entry = declarations.get(schemaPath);',
            after: "const entry = declarations.get(schemaPath); if (schemaPath !== '$' && !entry) return omitted;",
            control: (api) => assert.throws(() => api.analyzeStrongSemanticOutcome(
                sealContentDigest({ ...member.outcome, unknownSemanticField: true }), member.options)) },
        { name: 'failed-ids-only', module: 'semantic-outcome-diff.mjs',
            before: 'output.semanticDrift = l.outcomeFingerprint !== r.outcomeFingerprint;',
            after: 'output.semanticDrift = canonicalJson(l.canonicalOutcome.failedTestIds) !== canonicalJson(r.canonicalOutcome.failedTestIds);',
            control: (api) => assert.equal(api.diffSemanticOutcomeData(side(member), side(other)).semanticDrift, true) },
        { name: 'message-classification', module: 'semantic-outcome-diff.mjs',
            before: 'output.semanticDrift = l.outcomeFingerprint !== r.outcomeFingerprint;',
            after: 'output.semanticDrift = l.metadata.errorText !== r.metadata.errorText;',
            control: (api) => assert.equal(api.diffSemanticOutcomeData(side(member, { errorText: 'timeout' }),
                side(member, { errorText: 'assertion' })).semanticDrift, false) }
    ];
    try
    {
        for (const mutation of mutations)
        {
            let code = readFileSync(new URL(mutation.module, moduleRoot), 'utf8');
            assert.equal(code.split(mutation.before).length, 2, mutation.name);
            code = code.replace(mutation.before, () => mutation.after);
            code = code.replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${new URL(relative, moduleRoot).href}'`)
                .replace(/new URL\('(\.\.\/[^']+)', import.meta.url\)/gu, (_, relative) => `new URL('${new URL(relative, moduleRoot).href}')`);
            const file = path.join(root, `${mutation.name}.mjs`);
            writeFileSync(file, code);
            const api = await import(pathToFileURL(file).href);
            assert.throws(() => mutation.control(api), assert.AssertionError, mutation.name);
        }
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});
