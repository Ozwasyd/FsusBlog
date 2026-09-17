import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    bindReleaseReliabilityEvidence,
    readReleaseReliabilityEvidenceBinding
} from '../../tools/test/release-reliability-evidence-binding.mjs';
import { sealDocument } from '../../tools/test/release-reliability-receipt.mjs';

const invocationId = 'fixture-invocation';
const runId = 'fixture-run';
const scenarioId = 'release-soak-min';

function createFixture(context)
{
    const repositoryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-binding-')
    );
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const identity = sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState: {
            commit: 'a'.repeat(40),
            worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
            dirtyPathCount: 0,
            hashedPathCount: 0
        },
        build: {
            contentDigest: `sha256:${'c'.repeat(64)}`
        }
    });
    const identityRelativePath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const identityPath = path.join(repositoryRoot, identityRelativePath);
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
    const environment = {
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
        FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenarioId,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityRelativePath,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest
    };
    return { repositoryRoot, identity, identityPath, environment };
}

test('producer binding is derived from the sealed current run identity', (context) =>
{
    const fixture = createFixture(context);
    const binding = readReleaseReliabilityEvidenceBinding(fixture);
    assert.deepEqual(binding, {
        invocationId,
        runId,
        scenarioId,
        identityContentDigest: fixture.identity.contentDigest,
        sourceState: fixture.identity.sourceState,
        buildContentDigest: fixture.identity.build.contentDigest
    });
    assert.deepEqual(
        bindReleaseReliabilityEvidence({ status: 'ok' }, fixture),
        { status: 'ok', releaseReliability: binding }
    );
});

test('ordinary producer runs remain unchanged when no binding environment exists', () =>
{
    const evidence = { status: 'ok' };
    assert.equal(
        bindReleaseReliabilityEvidence(evidence, {
            repositoryRoot: process.cwd(),
            environment: {}
        }),
        evidence
    );
});

test('partial environment, noncanonical identity path, and tampered identity fail closed', (context) =>
{
    const fixture = createFixture(context);
    assert.throws(
        () => readReleaseReliabilityEvidenceBinding({
            repositoryRoot: fixture.repositoryRoot,
            environment: {
                FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId
            }
        }),
        /environment is incomplete/u
    );
    assert.throws(
        () => readReleaseReliabilityEvidenceBinding({
            ...fixture,
            environment: {
                ...fixture.environment,
                FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: 'identity.json'
            }
        }),
        /path is not canonical/u
    );
    fs.writeFileSync(
        fixture.identityPath,
        `${JSON.stringify({ ...fixture.identity, runId: 'tampered-run' }, null, 2)}\n`
    );
    assert.throws(
        () => readReleaseReliabilityEvidenceBinding(fixture),
        /identity is incomplete or mismatched/u
    );
});

test('producer cannot overwrite an existing release reliability binding', (context) =>
{
    const fixture = createFixture(context);
    assert.throws(
        () => bindReleaseReliabilityEvidence(
            { status: 'ok', releaseReliability: {} },
            fixture
        ),
        /already contains a binding/u
    );
});
