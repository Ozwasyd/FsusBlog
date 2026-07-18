#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = {
  catalog: read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadCrossCuttingControlCatalog.cs'),
  routeCatalog: read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadRouteSecurityCatalog.cs'),
  early: read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs'),
  fast: [
    read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs'),
    read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Routing.cs'),
    read('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs')
  ].join('\n'),
  composition: read('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs'),
  tests: read('tests/backend/Unit/PublicHotReadCrossCuttingControlTests.cs')
}

const requiredControls = [
  'release-and-security-headers',
  'deployment-request-tracking',
  'shield-exception-binary-boundary',
  'observability-correlation',
  'public-read-rate-limit',
  'request-audit-context',
  'cors',
  'antiforgery',
  'csrf-origin-guard',
  'anonymous-gateway-header-guard',
  'authentication',
  'banned-user',
  'authorization'
].sort()

validate(files)

if (process.argv.includes('--self-test')) {
  expectFailure({
    ...files,
    composition: files.composition.replace(
      /\s*new\("public-hot-read-request-audit-context"[^\n]+\n/,
      '\n')
  }, 'missing early stage')
  expectFailure({
    ...files,
    composition: files.composition.replace(
      /\s*new\("authorization"[^\n]+\n/,
      '\n')
  }, 'missing canonical stage')
  expectFailure({
    ...files,
    catalog: files.catalog.replace(
      /\s*EndpointOnly\("authorization"[^\n]+\n/,
      '\n')
  }, 'missing control registration')
  expectFailure({
    ...files,
    composition: files.composition.replace(
      'private static readonly PipelineStage[] s_endpointPipelineStages =\n    [',
      'private static readonly PipelineStage[] s_endpointPipelineStages =\n    [\n' +
        '        new("future-endpoint-security-control", PublicHotReadPipelineStageClassification.CrossCuttingControl, "future-endpoint-security-control", static app => app.UseRouting()),')
  }, 'unregistered endpoint security stage')
  expectFailure({
    ...files,
    fast: files.fast.replace('ctx.Request.Headers.ContainsKey("Origin")', 'false')
  }, 'unbound CORS evidence')
}

console.log('[public-hot-read-controls] declarative catalog, startup guard, both pipeline legs, executable boundaries and focused evidence are aligned')

function validate(source) {
  const applicationBlock = between(
    source.composition,
    'private static readonly PipelineStage[] s_applicationPipelineStages',
    'private static readonly PipelineStage[] s_endpointPipelineStages')
  const endpointBlock = between(
    source.composition,
    'private static readonly PipelineStage[] s_endpointPipelineStages',
    'internal static IReadOnlyList<PublicHotReadPipelineStageDescriptor> ApplicationPipelineStageDescriptors')
  const applicationDescriptors = stageDescriptors(applicationBlock)
  const endpointDescriptors = stageDescriptors(endpointBlock)
  const applicationStages = applicationDescriptors.map(({ id }) => id)
  const endpointStages = endpointDescriptors.map(({ id }) => id)
  unique(applicationStages, 'application pipeline')
  unique(endpointStages, 'endpoint pipeline')

  const global = [...source.catalog.matchAll(/\bGlobal\("([^"]+)", "([^"]+)"\)/g)]
    .map(([, id, stage]) => ({ id, stage }))
  const replayed = [...source.catalog.matchAll(/\bReplayed\("([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\)/g)]
    .map(([, id, earlyStage, endpointStage, guard]) => ({ id, earlyStage, endpointStage, guard }))
  const endpointOnly = [...source.catalog.matchAll(/\bEndpointOnly\("([^"]+)", "([^"]+)", ([A-Za-z]+Evidence)\)/g)]
    .map(([, id, endpointStage, evidence]) => ({ id, endpointStage, evidence }))
  const actualControls = [...global, ...replayed, ...endpointOnly].map(({ id }) => id).sort()
  assert.deepEqual(actualControls, requiredControls, 'cross-cutting control catalog must match the required set exactly')
  unique(actualControls, 'control catalog')

  validateStageClassifications(applicationDescriptors, endpointDescriptors, global, replayed, endpointOnly)

  const classifier = exactlyOnce(applicationStages, 'public-hot-read-classifier')
  const writer = exactlyOnce(applicationStages, 'public-hot-read-fast-path')
  const endpointPipeline = exactlyOnce(applicationStages, 'endpoint-pipeline')
  assert.ok(classifier < writer && writer < endpointPipeline, 'classifier/writer/endpoint order drifted')

  for (const control of global) {
    assert.ok(exactlyOnce(applicationStages, control.stage) < classifier, `${control.id} must be global-before-branch`)
  }
  for (const control of replayed) {
    const earlyIndex = exactlyOnce(applicationStages, control.earlyStage)
    assert.ok(earlyIndex > classifier && earlyIndex < writer, `${control.id} early replay is outside the branch`)
    exactlyOnce(endpointStages, control.endpointStage)
  }
  unique(replayed.map(({ guard }) => guard), 'double execution guard')
  for (const control of endpointOnly) {
    exactlyOnce(endpointStages, control.endpointStage)
    assert.ok(
      ['CredentialFreeEvidence', 'SafeMethodEvidence', 'SameOriginEvidence'].includes(control.evidence),
      `${control.id} has no recognized non-applicability evidence`)
  }

  const startup = between(
    source.composition,
    'public static void UseFsusApplicationPipeline',
    'public static void MapFsusApplicationRoutes')
  assert.ok(
    startup.indexOf('PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(') >= 0 &&
      startup.indexOf('PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(') < startup.indexOf('foreach (PipelineStage stage'),
    'startup must fail closed before registering any application stage')

  for (const token of [
    'RequiresAnonymousRequest',
    'RequiresSafeMethod',
    'DefersCorsRequestsToEndpointPipeline',
    'ProbePath'
  ]) {
    assert.ok(source.routeCatalog.includes(token), `route policy/metadata is missing ${token}`)
  }
  for (const token of [
    'PublicHotReadRouteSecurityCatalog.ValidateOrThrow(routePolicies)',
    'PublicHotReadEarlyEndpointCatalog.ValidateOrThrow(routePolicies, syntheticEndpoints)',
    'ValidateExecutableRouteConstraints(routePolicies)'
  ]) {
    assert.ok(source.catalog.includes(token), `startup catalog is missing ${token}`)
  }

  const classifierMethod = between(
    source.fast,
    'internal static bool TryCreateRequestFeatureWithBypass',
    'internal static bool TryCreateRequestFeatureForTests')
  const featureConstruction = classifierMethod.indexOf('feature = new PublicHotReadRequestFeature(')
  assert.ok(featureConstruction > 0, 'classifier feature construction is missing')
  for (const token of [
    'HasCredentialBearingInput(ctx)',
    '!HttpMethods.IsGet(ctx.Request.Method)',
    '!HttpMethods.IsHead(ctx.Request.Method)',
    'ctx.Request.Headers.ContainsKey("Origin")'
  ]) {
    const position = classifierMethod.indexOf(token)
    assert.ok(position >= 0 && position < featureConstruction, `classifier executable boundary missing or late: ${token}`)
  }
  for (const [label, sourceText, token] of [
    ['classifier', source.fast, 'AnonymousGatewayHeaderGuardMiddleware.IsAllowedHeader(headerName)'],
    ['startup probe', source.catalog, 'rejectedGatewayHeader.Request.Headers["X-Fsus-User-Id"]'],
    ['request boundary test', source.tests, 'rejectedGatewayHeader.Headers.TryAddWithoutValidation("X-Fsus-User-Id"']
  ]) {
    assert.ok(sourceText.includes(token), `${label} is missing rejected gateway-header fallback evidence`)
  }

  for (const token of [
    'state.MarkRateLimitEvaluated()',
    'state.MarkRequestAuditContextEvaluated()'
  ]) {
    assert.ok(source.early.includes(token), `early replay evidence missing: ${token}`)
  }
  for (const token of [
    'state.MarkEndpointRateLimiterSkipped()',
    'state.MarkEndpointRequestAuditContextSkipped()'
  ]) {
    assert.ok(source.composition.includes(token), `canonical double-execution guard missing: ${token}`)
  }

  for (const token of [
    'RequestPipeline_FastAndCanonicalCategoryResponsesAreByteIdentical',
    'RequestPipeline_OnlyAnonymousSafeSameOriginArtifactReadUsesEarlyBranch',
    'RequestPipeline_ArtifactMissRunsRequestAuditContextExactlyOnce',
    'RequestPipeline_RateLimiterRunsExactlyOnceForArtifactHitAndMiss',
    'ProjectorMaterializer_OnlyPublishedDueSourcesEnterFrames',
    'PublicationEvidence_BindsPublicSourceVisibilityAndVersionFailClosed',
    'StartupCatalog_FailsClosedWhenControlRoutePolicyOrEndpointMetadataDrifts'
  ]) {
    assert.ok(source.tests.includes(token), `focused behavioral evidence missing: ${token}`)
  }
}

function validateStageClassifications(application, endpoint, global, replayed, endpointOnly) {
  const allowedClassifications = new Set([
    'Infrastructure',
    'BranchMechanic',
    'EndpointFunctional',
    'CrossCuttingControl'
  ])
  const expectedApplication = new Map([
    ...global.map(({ id, stage }) => [stage, id]),
    ...replayed.map(({ id, earlyStage }) => [earlyStage, id])
  ])
  const expectedEndpoint = new Map([
    ...replayed.map(({ id, endpointStage }) => [endpointStage, id]),
    ...endpointOnly.map(({ id, endpointStage }) => [endpointStage, id])
  ])

  validatePipelineClassifications(application, expectedApplication, allowedClassifications, 'application')
  validatePipelineClassifications(endpoint, expectedEndpoint, allowedClassifications, 'endpoint')
}

function validatePipelineClassifications(stages, expectedControls, allowedClassifications, pipeline) {
  for (const stage of stages) {
    assert.ok(allowedClassifications.has(stage.classification), `${pipeline}:${stage.id} has an unknown classification`)
    const expectedControlId = expectedControls.get(stage.id)
    if (stage.classification === 'CrossCuttingControl') {
      assert.ok(expectedControlId, `${pipeline}:${stage.id} cross-cutting stage is not registered`)
      assert.equal(stage.controlId, expectedControlId, `${pipeline}:${stage.id} control mapping drifted`)
    } else {
      assert.equal(stage.controlId, null, `${pipeline}:${stage.id} non-control stage declares a control id`)
      assert.equal(expectedControlId, undefined, `${pipeline}:${stage.id} catalog control is not classified cross-cutting`)
    }
  }

  for (const [stageId, controlId] of expectedControls) {
    assert.ok(
      stages.some(stage =>
        stage.id === stageId &&
        stage.classification === 'CrossCuttingControl' &&
        stage.controlId === controlId),
      `${pipeline}:${stageId} catalog control is not explicitly mapped`)
  }
}

function expectFailure(mutated, label) {
  assert.throws(() => validate(mutated), undefined, `checker self-test did not reject ${label}`)
}

function stageDescriptors(block) {
  const constructors = [...block.matchAll(/\bnew\("/g)].length
  const descriptors = [...block.matchAll(
    /\bnew\("([^"]+)", PublicHotReadPipelineStageClassification\.([A-Za-z]+), (null|"([^"]+)"),/g)]
    .map(([, id, classification, rawControlId, controlId]) => ({
      id,
      classification,
      controlId: rawControlId === 'null' ? null : controlId
    }))
  assert.equal(descriptors.length, constructors, 'every pipeline stage must declare classification and control id mapping')
  return descriptors
}

function exactlyOnce(values, expected) {
  const indexes = values.flatMap((value, index) => value === expected ? [index] : [])
  assert.equal(indexes.length, 1, `${expected} must appear exactly once`)
  return indexes[0]
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`)
}

function between(source, startToken, endToken) {
  const start = source.indexOf(startToken)
  const end = source.indexOf(endToken, start + startToken.length)
  assert.ok(start >= 0 && end > start, `unable to isolate ${startToken}`)
  return source.slice(start, end)
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}
