#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url';

import { readRunBoundMarker } from '../test-matrix/run-bound-marker.mjs';
import { validateFrontendBuildStageReceiptBinding } from '../test-matrix/frontend-build-ready-marker.mjs';
import { digestDeclaredOutputs } from '../test-matrix/local-profile.mjs';
import { resolveProductionBuildLayout } from '../test-matrix/production-build-layout.mjs';
import { createFrontendBuildStages } from '../frontend/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function currentFrontendBuildStages(frontendRoot, env = process.env)
{
    const generatedOnly = env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1';
    return createFrontendBuildStages(generatedOnly ? ['--check'] : [], generatedOnly ? 'check' : 'generate', {
        frontendRoot,
        env
    });
}

function criticalFrontendBuildOutputs(layout, stages)
{
    const owned = new Set(stages.flatMap((stage) => stage.ownedOutputs));
    return [
        path.join(layout.frontendDist, 'index.html'),
        path.join(layout.frontendDist, 'server', 'public-shell-emergency.css'),
        path.join(layout.frontendDist, 'wasm'),
        path.join(layout.frontendDist, 'assets', 'fsus-spa-entry.js'),
        path.join(layout.frontendDist, 'dist'),
        path.join(layout.frontendWasm, 'wasm-manifest.aeds'),
        path.join(layout.frontendWasm, 'aeds-runtime-manifest.json'),
        layout.backendWebRoot
    ].filter((candidate) => owned.has(candidate));
}

function readBoundJson(repositoryRoot, relativeFile, validate)
{
    const file = path.join(repositoryRoot, relativeFile);
    if (!fs.existsSync(file)) {throw new Error(`privacy-ZK performance input is missing: ${relativeFile}`)};
  const source = fs.readFileSync(file)
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`privacy-ZK performance input is invalid JSON: ${relativeFile}`, { cause: error })
  }
  validate(value, relativeFile)
  return {
    path: relativeFile,
    digest: `sha256:${createHash('sha256').update(source).digest('hex')}`
  }
}

export function verifyPrivacyZkPerformanceInputs({
  runId = process.env.FSUSBLOG_TEST_RUN_ID,
  sourceState = {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    },
    repositoryRoot = root,
    expectedFrontendBuildStages,
    criticalFrontendOutputPaths
} = {})
{
    const normalizedRunId = String(runId ?? '').trim();
    if (!normalizedRunId) {throw new Error('privacy-ZK performance input verification requires FSUSBLOG_TEST_RUN_ID')};
    const resolvedRoot = path.resolve(repositoryRoot);
    const resolvedExpectedStages = expectedFrontendBuildStages
    ?? currentFrontendBuildStages(path.join(resolvedRoot, 'src/frontend'));
    const coverageRoot = path.resolve(
      process.env.FSUSBLOG_COVERAGE_ROOT ?? path.join(resolvedRoot, '.tmp/coverage')
    )
    const securityOutputRoot = path.resolve(
      process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(resolvedRoot, '.tmp/security')
    )
    const productionLayout = resolveProductionBuildLayout({ root: resolvedRoot, runId: normalizedRunId });
    const failures = [];
    const collect = (relativeFile, validate) =>
{
        try
{
      return readBoundJson(resolvedRoot, relativeFile, validate)
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  const markers = [
    [
      'backend-coverage-ready',
      'backend-tests',
      'backend-coverage-summary',
      path.join(coverageRoot, 'backend-merged', 'Summary.json')
    ],
    [
      'frontend-coverage-ready',
      'frontend-tests',
      'frontend-coverage-summary',
      path.join(coverageRoot, 'frontend', 'Summary.json')
    ]
  ].map(([markerId, producerBundleId, producerStepId, artifact]) => {
    const relativeFile = `.tmp/test-runs/${normalizedRunId}/${markerId}.json`
    try {
      readRunBoundMarker(path.join(resolvedRoot, relativeFile), {
        root: resolvedRoot,
        markerId,
        runId: normalizedRunId,
        sourceState,
        producerBundleId,
        producerStepId,
        artifacts: [artifact]
      })
      return readBoundJson(resolvedRoot, relativeFile, () => {})
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  })
  const frontendBuild = collect(
    `.tmp/test-runs/${normalizedRunId}/frontend-build-ready.json`,
    (marker, relativeFile) => {
      if (marker?.schema !== 'fsusblog.local-production.frontend-build-ready.v1'
        || marker.status !== 'success'
        || marker.schedulerRunId !== normalizedRunId
        || marker.buildLayout?.sourceCommit !== sourceState.commit
        || marker.buildLayout?.sourceFingerprint !== sourceState.worktreeFingerprint)
{
                throw new Error(`privacy-ZK performance input is not the current frontend build marker: ${relativeFile}`);
            }
            validateFrontendBuildStageReceiptBinding({
                root: resolvedRoot,
                marker,
                runId: normalizedRunId,
                sourceState,
                expectedPath: `.tmp/build/${normalizedRunId}/generated/frontend-build-stages.json`,
                expectedStages: resolvedExpectedStages,
                stageCwd: path.join(resolvedRoot, 'src/frontend'),
                criticalOutputPaths: criticalFrontendOutputPaths
          ?? criticalFrontendBuildOutputs(productionLayout, resolvedExpectedStages)
            });
            const frontendDistPath = path.relative(resolvedRoot, productionLayout.frontendDist).replaceAll(path.sep, '/');
            const backendWebRootPath = path.relative(resolvedRoot, productionLayout.backendWebRoot).replaceAll(path.sep, '/');
            if (marker.frontendDist?.path !== frontendDistPath
        || marker.backendWebRoot?.path !== backendWebRootPath)
{
                throw new Error(`privacy-ZK performance input frontend tree paths are invalid: ${relativeFile}`);
            }
            const treeDigests = digestDeclaredOutputs(resolvedRoot, [frontendDistPath, backendWebRootPath]);
            if (marker.frontendDist.digest !== treeDigests[frontendDistPath]
        || marker.backendWebRoot.digest !== treeDigests[backendWebRootPath])
{
                throw new Error(`privacy-ZK performance input frontend tree digest mismatch: ${relativeFile}`);
            }
        }
    );
    const stages = ['contract', 'functional'].map((stage) => collect(
    path.relative(
      resolvedRoot,
      path.join(securityOutputRoot, 'privacy-zk-comment-matrix-stages', `${stage}.json`)
    ).replaceAll(path.sep, '/'),
    (receipt, relativeFile) => {
      if (receipt?.schema !== 'fsusblog.privacy-zk-comment-matrix-stage.v1'
        || receipt.status !== 'ok'
        || receipt.stage !== stage
        || receipt.runId !== normalizedRunId) {
        throw new Error(`privacy-ZK performance input is not a successful ${normalizedRunId} ${stage} receipt: ${relativeFile}`)
      }
    }
  ))
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `privacy-ZK performance inputs failed in ${failures.length} independent files: ${failures.map((error) => error.message).join('; ')}`
    )
  }
  return { runId: normalizedRunId, markers, frontendBuild, stages }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = verifyPrivacyZkPerformanceInputs()
    process.stdout.write(`${JSON.stringify({
      schema: 'fsusblog.privacy-zk-performance-inputs.v1',
      status: 'ok',
      ...evidence
    })}\n`)
  } catch (error) {
    console.error(`[privacy-zk-performance-inputs] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
