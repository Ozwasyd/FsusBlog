import assert from 'node:assert/strict';
import test from 'node:test';

const implementationUrl = new URL(
  '../../tools/issue-orchestration-stage-artifact-manifest.mjs',
  import.meta.url,
);

async function loadContract() {
  return import(implementationUrl.href);
}

test('stage artifact implementation is present before receipt contracts can pass', async () => {
  const contract = await loadContract();

  assert.equal(typeof contract.evaluateStageArtifact, 'function');
});

test('successful output produces a manifest and qualified receipt', async () => {
  const { evaluateStageArtifact } = await loadContract();
  const result = evaluateStageArtifact({
    issue: 1852,
    stage: 'test-contract',
    attempt: 1,
    command: 'node --test tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
    exitStatus: 0,
    output: 'TAP version 13\\n# pass 1',
  });

  assert.deepEqual(result.manifest, {
    issue: 1852,
    stage: 'test-contract',
    attempt: 1,
    command: 'node --test tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
    exitStatus: 0,
    outputPresent: true,
    outcome: 'passed',
  });
  assert.deepEqual(result.receipt, {
    status: 'qualified',
    retry: false,
    breaker: false,
  });
});

test('a non-zero stage failure is recorded, retryable, and not qualified', async () => {
  const { evaluateStageArtifact } = await loadContract();
  const result = evaluateStageArtifact({
    issue: 1852,
    stage: 'test-contract',
    attempt: 1,
    command: 'node --test tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
    exitStatus: 1,
    output: 'not ok 1 - expected contract failure',
  });

  assert.equal(result.manifest.outcome, 'failed');
  assert.equal(result.receipt.status, 'unqualified');
  assert.equal(result.receipt.retry, true);
  assert.equal(result.receipt.breaker, false);
});

test('missing output is an explicit unqualified failure instead of a pass', async () => {
  const { evaluateStageArtifact } = await loadContract();
  const result = evaluateStageArtifact({
    issue: 1852,
    stage: 'test-contract',
    attempt: 1,
    command: 'node --test tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
    exitStatus: 0,
    output: '',
  });

  assert.equal(result.manifest.outputPresent, false);
  assert.equal(result.manifest.outcome, 'output-missing');
  assert.equal(result.receipt.status, 'unqualified');
  assert.equal(result.receipt.retry, true);
  assert.equal(result.receipt.breaker, false);
});

test('a repeated unchanged failure opens the breaker and blocks another retry', async () => {
  const { evaluateStageArtifact } = await loadContract();
  const result = evaluateStageArtifact({
    issue: 1852,
    stage: 'test-contract',
    attempt: 2,
    command: 'node --test tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
    exitStatus: 1,
    output: 'not ok 1 - expected contract failure',
    previousManifest: {
      exitStatus: 1,
      output: 'not ok 1 - expected contract failure',
    },
  });

  assert.equal(result.manifest.outcome, 'failed');
  assert.equal(result.receipt.retry, false);
  assert.equal(result.receipt.breaker, true);
  assert.equal(result.receipt.breakerReason, 'unchanged-failure');
});
