/**
 * Classify one issue-orchestration stage attempt into its portable manifest
 * and the receipt which determines whether the next stage may proceed.
 */
export function evaluateStageArtifact({
  issue,
  stage,
  attempt,
  command,
  exitStatus,
  output,
  previousManifest,
} = {}) {
  const outputPresent = typeof output === 'string' && output.length > 0;
  const outcome = !outputPresent
    ? 'output-missing'
    : exitStatus === 0
      ? 'passed'
      : 'failed';

  const manifest = {
    issue,
    stage,
    attempt,
    command,
    exitStatus,
    outputPresent,
    outcome,
  };

  if (outcome === 'passed') {
    return {
      manifest,
      receipt: {
        status: 'qualified',
        retry: false,
        breaker: false,
      },
    };
  }

  const unchangedFailure = outcome === 'failed'
    && attempt > 1
    && previousManifest?.exitStatus === exitStatus
    && previousManifest?.output === output;

  if (unchangedFailure) {
    return {
      manifest,
      receipt: {
        status: 'unqualified',
        retry: false,
        breaker: true,
        breakerReason: 'unchanged-failure',
      },
    };
  }

  return {
    manifest,
    receipt: {
      status: 'unqualified',
      retry: true,
      breaker: false,
    },
  };
}
