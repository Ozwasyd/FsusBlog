import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test'

import { verifyPrivacyZkPerformanceInputs } from '../../tools/test/verify-privacy-zk-performance-inputs.mjs';
import { publishRunBoundMarker } from '../../tools/test-matrix/run-bound-marker.mjs';
import { digestDeclaredOutputs } from '../../tools/test-matrix/local-profile.mjs';

const sourceState = { commit: 'abc123', worktreeFingerprint: 'tree-1' };
const expectedFrontendBuildStages = [{
    id: 'frontend-build',
    command: ['vite', 'build'],
    dependsOn: [],
    ownedOutputs: []
}];

function writeJson(root, relativeFile, value)
{
    const file = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function writeFixture(root, runId) {
  for (const [markerId, producerBundleId, producerStepId, artifact] of [
    [
      'backend-coverage-ready',
      'backend-tests',
      'backend-coverage-summary',
      '.tmp/coverage/backend-merged/Summary.json'
    ],
    [
      'frontend-coverage-ready',
      'frontend-tests',
      'frontend-coverage-summary',
      '.tmp/coverage/frontend/Summary.json'
    ]
  ]) {
    const artifactFile = path.join(root, artifact)
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true })
    fs.writeFileSync(artifactFile, '{}\n')
    publishRunBoundMarker({
      file: path.join(root, `.tmp/test-runs/${runId}/${markerId}.json`), root, markerId, runId,
            sourceState, producerBundleId, producerStepId, artifacts: [artifactFile]
        });
    }
    const stageReceiptPath = `.tmp/build/${runId}/generated/frontend-build-stages.json`;
    const frontendDistPath = `.tmp/build/${runId}/frontend/dist`;
    const backendWebRootPath = `.tmp/build/${runId}/frontend/wwwroot`;
    writeJson(root, `${frontendDistPath}/asset.json`, { current: true });
    writeJson(root, `${backendWebRootPath}/asset.json`, { current: true });
    const treeDigests = digestDeclaredOutputs(root, [frontendDistPath, backendWebRootPath]);
    const stageReceipt = {
        schema: 'fsusblog.frontend-build-stage-receipt.v1',
        status: 'success',
        schedulerRunId: runId,
        sourceState,
        stages: [{
            ...expectedFrontendBuildStages[0],
            status: 'success',
            outputs: {}
        }]
    };
    writeJson(root, stageReceiptPath, stageReceipt);
    const stageReceiptBytes = fs.readFileSync(path.join(root, stageReceiptPath));
    writeJson(root, `.tmp/test-runs/${runId}/frontend-build-ready.json`, {
        schema: 'fsusblog.local-production.frontend-build-ready.v1', status: 'success', schedulerRunId: runId,
        buildLayout: { sourceCommit: sourceState.commit, sourceFingerprint: sourceState.worktreeFingerprint },
        frontendDist: { path: frontendDistPath, digest: treeDigests[frontendDistPath] },
        backendWebRoot: { path: backendWebRootPath, digest: treeDigests[backendWebRootPath] },
        stageReceipt: {
            path: stageReceiptPath,
            contentDigest: `sha256:${createHash('sha256').update(stageReceiptBytes).digest('hex')}`,
            identity: {
                schema: stageReceipt.schema,
                status: stageReceipt.status,
                schedulerRunId: runId,
                sourceCommit: sourceState.commit,
                sourceFingerprint: sourceState.worktreeFingerprint
            }
        }
    });
    for (const stage of ['contract', 'functional'])
{
        writeJson(root, `.tmp/security/privacy-zk-comment-matrix-stages/${stage}.json`, {
      schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
      status: 'ok',
      stage,
      runId
    })
  }
}

test('privacy-ZK performance inputs bind all prerequisite bundles and receipts to one run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixture(root, 'production-fresh')

    const evidence = verifyPrivacyZkPerformanceInputs({
        runId: 'production-fresh',
        sourceState,
        repositoryRoot: root,
        expectedFrontendBuildStages
    });
    assert.equal(evidence.markers.length, 2);
    assert.equal(evidence.stages.length, 2);
  assert.ok([...evidence.markers, evidence.frontendBuild, ...evidence.stages]
        .every((entry) => entry.digest.startsWith('sha256:')));
});

test('privacy-ZK performance inputs reject a mutated frontend stage receipt', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-stage-receipt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeFixture(root, 'production-fresh');
    fs.appendFileSync(path.join(root, '.tmp/build/production-fresh/generated/frontend-build-stages.json'), ' ');

    assert.throws(
        () => verifyPrivacyZkPerformanceInputs({
            runId: 'production-fresh', sourceState, repositoryRoot: root, expectedFrontendBuildStages
        }),
        (error) =>
{
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /stage receipt content digest mismatch/u);
            return true;
        }
    );
});

test('privacy-ZK performance inputs reject a mutated final frontend tree', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-frontend-tree-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeFixture(root, 'production-fresh');
    fs.appendFileSync(path.join(root, '.tmp/build/production-fresh/frontend/dist/asset.json'), ' ');

    assert.throws(
        () => verifyPrivacyZkPerformanceInputs({
            runId: 'production-fresh', sourceState, repositoryRoot: root, expectedFrontendBuildStages
        }),
        (error) =>
{
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /frontend tree digest mismatch/u);
            return true;
        }
    );
});

test('privacy-ZK performance inputs reject a re-signed marker for the wrong semantic artifact', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-foreign-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root, 'production-fresh')
  const foreignArtifact = path.join(root, '.tmp/coverage/backend-merged/foreign.json')
  fs.writeFileSync(foreignArtifact, '{}\n')
  publishRunBoundMarker({
    file: path.join(root, '.tmp/test-runs/production-fresh/backend-coverage-ready.json'),
    root,
    markerId: 'backend-coverage-ready',
    runId: 'production-fresh',
    sourceState,
    producerBundleId: 'backend-tests',
    producerStepId: 'backend-coverage-summary',
    artifacts: [foreignArtifact]
  })

  assert.throws(
        () => verifyPrivacyZkPerformanceInputs({
            runId: 'production-fresh',
            sourceState,
            repositoryRoot: root,
            expectedFrontendBuildStages
        }),
        (error) =>
{
            assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1)
      assert.match(error.message, /artifact declaration mismatch/u)
      return true
    }
  )
})

test('privacy-ZK performance inputs report every missing or stale prerequisite together', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-privacy-performance-failures-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixture(root, 'stale-run')
    fs.rmSync(path.join(root, '.tmp/test-runs/stale-run/frontend-build-ready.json'));

    assert.throws(
        () => verifyPrivacyZkPerformanceInputs({
            runId: 'production-fresh', sourceState, repositoryRoot: root, expectedFrontendBuildStages
        }),
        (error) =>
{
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 5);
      assert.match(error.message, /5 independent files/u)
      assert.match(error.message, /backend-coverage-ready\.json/u)
      assert.match(error.message, /contract\.json/u)
      assert.match(error.message, /functional\.json/u)
      return true
    }
  )
})
