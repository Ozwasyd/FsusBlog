#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FASTPATH_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"
FASTPATH_SERVING_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs"
FASTPATH_ROUTING_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Routing.cs"
export FSUSBLOG_FASTPATH_PART_FILES="$FASTPATH_ROUTING_FILE:$FASTPATH_SERVING_FILE"
SANITY_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSanity.cs"
RESIDENCY_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadResidency.cs"
METRICS_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs"
PROJECTOR_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs"
REVOCATION_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicArtifactRevocation.cs"
MUTATION_FENCE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicMutationFenceLease.cs"
MUTATION_SIDE_EFFECTS_FILE="$ROOT_DIR/src/backend/Services/ArticleMutationSideEffects.cs"
EARLY_DATA_PLANE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs"
ROUTE_SECURITY_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadRouteSecurityCatalog.cs"
SECURITY_GATE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs"
COMPOSITION_FILE="$ROOT_DIR/src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs"
GATEWAY_FILE="$ROOT_DIR/deploy/production-openresty.conf"
NONCE_TEMPLATE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs"
AOT_FILE_CACHE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs"
AOT_MEMORY_CACHE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicAot/PublicAotBoundedMemoryCache.cs"
OBSERVABILITY_REGISTRATION_FILE="$ROOT_DIR/src/backend/Infrastructure/Observability/FsusObservabilityServiceCollectionExtensions.cs"
ARTICLE_ENDPOINTS_FILE="$ROOT_DIR/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs"
ARTICLE_API_FILE="$ROOT_DIR/src/frontend/src/api/article.ts"
BINARY_TRANSPORT_FILE="$ROOT_DIR/src/frontend/src/services/binaryTransport.ts"

echo "[public-hot-read] checking cross-cutting control catalog"
node "$ROOT_DIR/tools/check-public-hot-read-cross-cutting-controls.mjs" --self-test

echo "[public-hot-read] checking middleware order"
node - "$COMPOSITION_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const methodStart = source.indexOf('private static readonly PipelineStage[] ApplicationPipelineStages');
const methodEnd = source.indexOf('private static readonly PipelineStage[] EndpointPipelineStages', methodStart);
if (methodStart < 0 || methodEnd < 0 || methodEnd <= methodStart) {
  console.error('[public-hot-read] unable to isolate ApplicationPipelineStages');
  process.exit(1);
}
const block = source.slice(methodStart, methodEnd);
const correlation = block.indexOf('ObservabilityCorrelationMiddleware');
const classifier = block.indexOf('UseFsusPublicHotReadClassifier');
const audit = block.indexOf('UseFsusPublicHotReadRequestAuditContext');
const limiter = block.indexOf('UseFsusPublicHotReadRateLimiter');
const gate = block.indexOf('UseFsusPublicHotReadSecurityGate');
const revocation = block.indexOf('UseFsusPublicArtifactRevocation');
const core = block.indexOf('UseFsusCoreMiddlewares');
const fast = block.indexOf('UseFsusPublicHotReadFastPath');
const restore = block.indexOf('UseFsusPublicHotReadFallbackRestore');
const endpoint = block.indexOf('UseFsusEndpointPipeline');
if ([core, correlation, classifier, audit, limiter, gate, revocation, fast, restore, endpoint].some(index => index < 0)
    || !(core < correlation && correlation < classifier && classifier < audit && audit < limiter && limiter < gate && gate < revocation && revocation < fast && fast < restore && restore < endpoint)) {
  console.error('[public-hot-read] trace/classifier/rate/security/revocation/writer must run before the generic endpoint pipeline');
  process.exit(1);
}

const endpointBlock = source.slice(methodEnd, source.indexOf('internal static IReadOnlyList<string> ApplicationPipelineStageIds', methodEnd));
for (const token of [
  'UseResponseCompression',
  'UseOutputCache',
  'UseCors',
  'UseAntiforgery',
  'UseAuthentication',
  'BannedUserMiddleware',
  'UseFsusEndpointRequestAuditContext'
]) {
  if (!endpointBlock.includes(token)) {
    console.error(`[public-hot-read] missing generic downstream sentinel: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking declarative route security and publication evidence"
node - "$FASTPATH_FILE" "$EARLY_DATA_PLANE_FILE" "$ROUTE_SECURITY_FILE" "$PROJECTOR_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, earlyDataPlaneFile, routeSecurityFile, projectorFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const earlyDataPlane = fs.readFileSync(earlyDataPlaneFile, 'utf8');
const routeSecurity = fs.readFileSync(routeSecurityFile, 'utf8');
const projector = fs.readFileSync(projectorFile, 'utf8');
for (const token of [
  'PublicFastPathRouteMetadata',
  'PublicHotReadRouteSecurityCatalog',
  'ValidateOrThrow',
  'RequiresVisibilityEvidence',
  'RequiresSecurityGate',
  'RequiresRateLimit',
  'RequiresTraceCorrelation',
  'RequiresReleaseHeaders'
]) {
  if (!routeSecurity.includes(token)) {
    console.error(`[public-hot-read] missing route security catalog token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'policy.ToEndpointMetadata()',
  'PublicHotReadEarlyEndpointCatalog',
  'PublicHotReadRouteSecurityCatalog.ValidateOrThrow()',
  'PublicHotReadEarlyEndpointCatalog.ValidateOrThrow()'
]) {
  if (!earlyDataPlane.includes(token)) {
    console.error(`[public-hot-read] route catalog is not bound to startup/endpoint metadata: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'PublicHotReadPublicationEvidence',
  'PublicationEvidence.IsVerifiedFor(next.Version)',
  'PublicHotReadPublicationEvidenceInvalid'
]) {
  if (!fastPath.includes(token)) {
    console.error(`[public-hot-read] snapshot publication evidence is incomplete: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'CreateVerified',
  'IsPubliclyVisible(detail, visibilityCutoff)'
]) {
  if (!projector.includes(token)) {
    console.error(`[public-hot-read] projector visibility gate is incomplete: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking post-publish sanity and fallback boundary"
node - "$FASTPATH_FILE" "$FASTPATH_SERVING_FILE" "$SANITY_FILE" "$PROJECTOR_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, fastPathServingFile, sanityFile, projectorFile] = process.argv.slice(2);
const fastPath = `${fs.readFileSync(fastPathFile, 'utf8')}\n${fs.readFileSync(fastPathServingFile, 'utf8')}`;
const sanity = fs.readFileSync(sanityFile, 'utf8');
const projector = fs.readFileSync(projectorFile, 'utf8');
for (const token of [
  'MaxSnapshotAge',
  'TryGetRequestSnapshot',
  'PublicHotReadArtifactIntegrity.IsSnapshotValid(next)',
  'PublicHotReadArtifactIntegrity.IsValid(variant, artifact, integrityContext)',
  'PublicArtifactIntegrityContext.ForHtml(routeKey)',
  'counters.SanityFallback()',
  'return next(ctx)'
]) {
  if (!fastPath.includes(token)) {
    console.error(`[public-hot-read] missing sanity fallback token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'hmac-sha256-128-process-memory-v2',
  'RandomNumberGenerator.GetBytes(32)',
  'IncrementalHash.CreateHMAC',
  'IsSnapshotValid',
  'LooksLikeExpectedAedsFrame',
  'BrotliDecoder.TryDecompress',
  'GZipStream',
  'TemplateIntegrityTag',
  'CspNonceTemplate?.IntegrityBytes',
  'PublicArtifactIntegrityContext'
]) {
  if (!sanity.includes(token)) {
    console.error(`[public-hot-read] missing integrity token: ${token}`);
    process.exit(1);
  }
}
const budgetIndex = fastPath.indexOf('PublicHotReadResidentAccounting.ValidateCandidate');
const integrityIndex = fastPath.indexOf('PublicHotReadArtifactIntegrity.IsSnapshotValid(next)');
if (budgetIndex < 0 || integrityIndex < 0 || budgetIndex >= integrityIndex) {
  console.error('[public-hot-read] cheap resident budget must reject before full snapshot integrity/schema validation');
  process.exit(1);
}
for (const token of [
  'store.SnapshotRefreshInterval',
  'store.ShouldRefreshSnapshot()',
  'sanity-age-refresh',
  'CreateAsyncScope()'
]) {
  if (!projector.includes(token)) {
    console.error(`[public-hot-read] missing bounded refresh token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking pre-commit mutation fence and owner recovery"
node - "$REVOCATION_FILE" "$MUTATION_FENCE_FILE" "$MUTATION_SIDE_EFFECTS_FILE" <<'NODE'
const fs = require('node:fs');
const [revocationFile, fenceFile, sideEffectsFile] = process.argv.slice(2);
const revocation = fs.readFileSync(revocationFile, 'utf8');
const fence = fs.readFileSync(fenceFile, 'utf8');
const sideEffects = fs.readFileSync(sideEffectsFile, 'utf8');
for (const token of [
  'TransitionPending=true',
  'MarkTransitionCommittedAsync',
  'RecoverPendingMutationFenceAsync',
  'tombstone.TransitionPending',
  'tombstone.Generation > maximumGeneration'
]) {
  if (!revocation.includes(token)) {
    console.error(`[public-hot-read] missing revocation transition token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'IRuntimeKeyScope',
  'PrefixKey(LockScopeKey)',
  'pg_try_advisory_lock(hashtext(@lock_scope), @article_id)',
  'pg_advisory_unlock(hashtext(@lock_scope), @article_id)',
  'NpgsqlConnection.ClearPool',
  'PublicMutationFenceRecoveryWorker',
  'RecoverPendingMutationFenceAsync'
]) {
  if (!fence.includes(token)) {
    console.error(`[public-hot-read] missing mutation owner recovery token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'BeginPublicMutationFenceAsync',
  'CommitPublicMutationFenceAsync',
  'RecoverAbortedPublicMutationFenceAsync',
  'mutationFenceLease.AcquireAsync',
  'mutationFenceLease.ReleaseAsync'
]) {
  if (!sideEffects.includes(token)) {
    console.error(`[public-hot-read] missing mutation side-effect fence token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking CSP nonce template publication boundary"
node - "$FASTPATH_FILE" "$COMPOSITION_FILE" "$NONCE_TEMPLATE_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, compositionFile, templateFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const composition = fs.readFileSync(compositionFile, 'utf8');
const template = fs.readFileSync(templateFile, 'utf8');
for (const [label, source, token] of [
  ['template', template, 'FindSlotOffsets'],
  ['template', template, 'StaticInlineSha256Sources'],
  ['template', template, 'ArtifactIdentity'],
  ['template', template, 'ResidentBytes'],
  ['template', template, 'response.BodyWriter.FlushAsync(cancellationToken)'],
  ['fast path', fastPath, 'Cache-Control"] = "private,no-store"'],
  ['fast path', fastPath, 'AcceptsIdentity'],
  ['fast path', fastPath, 'CspNonceTemplate'],
  ['composition', composition, 'WritePublicAotHtmlNonceTemplateAsync']
]) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] ${label} missing CSP nonce contract token: ${token}`);
    process.exit(1);
  }
}
for (const [label, source, token] of [
  ['composition', composition, 'ConditionalWeakTable'],
  ['fast path', fastPath, 'ApplyCspNonceToHtml'],
  ['fast path', fastPath, 'Encoding.UTF8.GetString(html.Bytes.Span)']
]) {
  if (source.includes(token)) {
    console.error(`[public-hot-read] ${label} retains forbidden nonce implementation: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking resident-byte admission and lifecycle contracts"
node - "$FASTPATH_FILE" "$RESIDENCY_FILE" "$METRICS_FILE" "$PROJECTOR_FILE" "$AOT_FILE_CACHE_FILE" "$AOT_MEMORY_CACHE_FILE" "$OBSERVABILITY_REGISTRATION_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, residencyFile, metricsFile, projectorFile, aotFileCacheFile, aotMemoryCacheFile, observabilityRegistrationFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const residency = fs.readFileSync(residencyFile, 'utf8');
const metrics = fs.readFileSync(metricsFile, 'utf8');
const projector = fs.readFileSync(projectorFile, 'utf8');
const aotFileCache = fs.readFileSync(aotFileCacheFile, 'utf8');
const aotMemoryCache = fs.readFileSync(aotMemoryCacheFile, 'utf8');
const observabilityRegistration = fs.readFileSync(observabilityRegistrationFile, 'utf8');
for (const token of [
  'MaxResidentBytes',
  'MaxRawBytes',
  'MaxCompressedBytes',
  'MaxHtmlBytes',
  'MaxSnapshotOverlapBytes',
  'MaxArtifactObjects',
  'MaxRetiringSnapshots',
  'MaxRetiringBytes',
  'RetiringSnapshotDeadline',
  'fsus.public_hot.retiring.evictions',
  'LifecycleHistory',
  'PublicHotReadResidentBreakdown',
  'ValidateCandidate'
]) {
  if (!fastPath.includes(token)) {
    console.error(`[public-hot-read] missing resident lifecycle token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'IdentityVariant',
  'BrotliVariant',
  'GzipVariant',
  'fsus.hotread.encoding.br'
]) {
  if (!metrics.includes(token)) {
    console.error(`[public-hot-read] missing encoding metric token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'GC.GetGCMemoryInfo().TotalAvailableMemoryBytes',
  'LohEligibleArrayBytes',
  'SnapshotOverlapBytes',
  'MaxArticleResidentBytes',
  'BinaryIntegrityMetadataBytes',
  'HtmlIntegrityMetadataBytes'
]) {
  if (!residency.includes(token)) {
    console.error(`[public-hot-read] missing resident accounting token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'MergeAdmissionSegments',
  'ApplyArticleAdmission',
  'MaxArticleResidentBytes'
]) {
  if (!projector.includes(token)) {
    console.error(`[public-hot-read] missing bounded admission token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'PublicAotBoundedMemoryCache',
  'PublicAotFileShellCacheOptions'
]) {
  if (!aotFileCache.includes(token)) {
    console.error(`[public-hot-read] AOT file cache is not bound to bounded memory storage: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'MaxMemoryCacheBytes',
  'MaxMemoryCacheEntries',
  'MemoryCacheEntryDeadline',
  'LinkedList<string>',
  'fsus.public_aot.memory_cache.evictions',
  'fsus.public_aot.memory_cache.resident_bytes'
]) {
  if (!aotMemoryCache.includes(token)) {
    console.error(`[public-hot-read] missing bounded AOT memory cache token: ${token}`);
    process.exit(1);
  }
}
for (const meterName of [
  'FsusBlog.PublicHotRead',
  'FsusBlog.PublicHotRead.Retiring',
  'FsusBlog.PublicAot.MemoryCache'
]) {
  if (!observabilityRegistration.includes(meterName)) {
    console.error(`[public-hot-read] OpenTelemetry collector does not subscribe to meter: ${meterName}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking single-classification feature sharing"
node - "$FASTPATH_FILE" "$EARLY_DATA_PLANE_FILE" "$SECURITY_GATE_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, earlyDataPlaneFile, securityGateFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const earlyDataPlane = fs.readFileSync(earlyDataPlaneFile, 'utf8');
const securityGate = fs.readFileSync(securityGateFile, 'utf8');
for (const token of [
  'PublicHotReadRequestFeature',
  'PublicHotReadClassifierCounters',
  'ClassificationCount',
  'RouteKind',
  'ArticleId',
  'ListKey',
  'HtmlRouteKey',
  'MediaKind',
  'RequiresSecurityGate'
]) {
  if (!earlyDataPlane.includes(token)) {
    console.error(`[public-hot-read] missing immutable request feature token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  '/api/binary/auth',
  '/api/binary/admin',
  '/api/binary/author',
  '/api/binary/manage',
  '/api/binary/internal',
  '/api/binary/billing',
  '/api/binary/audit',
  '/api/auth',
  '/api/admin',
  '/api/author',
  '/api/manage',
  '/api/internal',
  '/api/billing',
  '/api/audit',
  'sensitivePrefixBypass'
]) {
  if (!fastPath.includes(token)) {
    console.error(`[public-hot-read] explicit sensitive-prefix denylist is incomplete: ${token}`);
    process.exit(1);
  }
}
if (!fastPath.includes('ctx.Features.Get<PublicHotReadRequestFeature>()')) {
  console.error('[public-hot-read] writer does not consume the classified request feature');
  process.exit(1);
}
for (const token of ['TryClassifyRoute', 'RequiresSecurityGateForRequest']) {
  if (securityGate.includes(token)) {
    console.error(`[public-hot-read] security gate reclassifies request path: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking sensitive-prefix bypass observability"
node - "$FASTPATH_FILE" "$METRICS_FILE" "$EARLY_DATA_PLANE_FILE" "$GATEWAY_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, metricsFile, earlyDataPlaneFile, gatewayFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const metrics = fs.readFileSync(metricsFile, 'utf8');
const earlyDataPlane = fs.readFileSync(earlyDataPlaneFile, 'utf8');
const gateway = fs.readFileSync(gatewayFile, 'utf8');
const sensitiveBypassEvidence = `${fastPath}\n${metrics}\n${earlyDataPlane}`;
for (const token of [
  'fsus.hotread.classifier.sensitive_bypass',
  'public-hot-read-sensitive-prefix-bypass',
  'logger.LogWarning',
  'CollectSensitivePrefixBypassAndReset'
]) {
  if (!sensitiveBypassEvidence.includes(token)) {
    console.error(`[public-hot-read] missing sensitive-prefix bypass metric/alert token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'PublicHotReadClassifierCounters',
  'SensitivePrefixBypass',
  'sensitivePrefixBypass'
]) {
  if (!earlyDataPlane.includes(token)) {
    console.error(`[public-hot-read] classifier does not record dedicated bypass state: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'location ~ ^/api/auth(/|$)',
  'location ~ ^/api/(admin|author|manage|internal|billing|audit)(/|$)',
  'location ~ ^/api/binary/(manage|internal|billing|audit)(/|$)',
  'limit_req zone=fsus_auth_limit',
  'limit_req zone=fsus_admin_limit'
]) {
  if (!gateway.includes(token)) {
    console.error(`[public-hot-read] gateway sensitive-prefix normal lane is incomplete: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking credential-bearing bypass observability"
node - "$FASTPATH_FILE" "$METRICS_FILE" "$EARLY_DATA_PLANE_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, metricsFile, earlyDataPlaneFile] = process.argv.slice(2);
const fastPath = [fastPathFile, ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const metrics = fs.readFileSync(metricsFile, 'utf8');
const earlyDataPlane = fs.readFileSync(earlyDataPlaneFile, 'utf8');
const credentialBypassEvidence = `${fastPath}\n${metrics}\n${earlyDataPlane}`;
for (const token of [
  'HasCredentialBearingInput',
  'Authorization',
  'Cookie',
  'RequestVerificationToken',
  'X-CSRF-TOKEN',
  'X-XSRF-TOKEN',
  'fsus.hotread.classifier.credential_bypass',
  'CollectCredentialBypassAndReset'
]) {
  if (!credentialBypassEvidence.includes(token)) {
    console.error(`[public-hot-read] missing credential bypass token: ${token}`);
    process.exit(1);
  }
}
for (const token of ['CredentialBypass', 'credentialBypass']) {
  if (!earlyDataPlane.includes(token)) {
    console.error(`[public-hot-read] classifier does not record credential bypass: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking L0 hot path dependency budget"
node - "$FASTPATH_FILE" <<'NODE'
const fs = require('node:fs');
const block = process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')
  .map((path) => fs.readFileSync(path, 'utf8')).join('\n');
if (!block.includes('public static partial class PublicHotReadFastPath')) {
  console.error('[public-hot-read] unable to isolate PublicHotReadFastPath source block');
  process.exit(1);
}
const banned = [
  'RequestServices',
  'File.',
  'Directory.',
  'IConnectionMultiplexer',
  'IMemoryCache',
  'OutputCache',
  'Activity',
  'TagList',
  'ILogger',
  'IAedsEncoder',
  'BinaryResults'
];
for (const token of banned) {
  if (block.includes(token)) {
    console.error(`[public-hot-read] forbidden L0 dependency token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking protocol/readiness boundary tokens"
node - "$FASTPATH_FILE" "$METRICS_FILE" "$SANITY_FILE" <<'NODE'
const fs = require('node:fs');
const source = [process.argv[2], process.argv[3], process.argv[4], ...process.env.FSUSBLOG_FASTPATH_PART_FILES.split(':')]
  .map((path) => fs.readFileSync(path, 'utf8')).join('\n');
const required = [
  'private const string CategoryPath = "/api/binary/category.aeds"',
  'private const string CategoryPathWithoutSuffix = "/api/binary/category"',
  'private const string TagPath = "/api/binary/tag.aeds"',
  'private const string TagPathWithoutSuffix = "/api/binary/tag"',
  'path.StartsWith(ArticlePrefix + "/"',
  'StatusCodes.Status503ServiceUnavailable',
  'Retry-After',
  'StatusCodes.Status406NotAcceptable',
  'StatusCodes.Status405MethodNotAllowed',
  'StatusCodes.Status416RangeNotSatisfiable',
  'ContentRange',
  'Cache-Control"] = "no-store"',
  'Accept-Ranges',
  'Content-Encoding',
  'response.Headers["ETag"]',
  'PublicHotReadBinaryArtifactFactory',
  'LooksLikeExpectedAedsFrame',
  'CspNonceUtf8Template',
  'CspNonceHtmlResponseWriter.WriteBodyAsync',
  'response.Headers["Cache-Control"] = "private,no-store"',
  'HtmlPathKey',
  'X-Fsus-Required-Route',
  'EnableDiagnosticHeaders',
  'html.CspNonceTemplate'
];
for (const token of required) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] missing protocol/readiness token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'Encoding.UTF8.GetString(html.Bytes.Span)',
  'ApplyCspNonceToHtml(ctx',
  'byte[] bytes = Encoding.UTF8.GetBytes(rendered)'
]) {
  if (source.includes(token)) {
    console.error(`[public-hot-read] nonce path must not render a full document: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking frontend artifact failure taxonomy"
node - "$BINARY_TRANSPORT_FILE" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const required = [
  'not_found',
  'public_artifact_not_ready',
  'client_route_contract',
  'accept_contract',
  'binaryFailureKindFromStatus'
];
for (const token of required) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] missing frontend failure token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking public/admin route split"
node - "$ARTICLE_ENDPOINTS_FILE" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const required = [
  'MapGet("/admin/article"',
  'MapGet("/admin/article/{id:int}"',
  'MapPost("/admin/article"',
  'MapPut("/admin/article/{id:int}"',
  'MapDelete("/admin/article/{id:int}"'
];
for (const token of required) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] missing admin route token: ${token}`);
    process.exit(1);
  }
}
const forbidden = [
  'MapGet("/article"',
  'MapGet("/article/{id:int}"',
  'MapPost("/article"',
  'MapPut("/article/{id:int}"',
  'MapDelete("/article/{id:int}"'
];
for (const token of forbidden) {
  if (source.includes(token)) {
    console.error(`[public-hot-read] stale mixed public/admin route token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking frontend public adapter contract"
node - "$ARTICLE_API_FILE" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const required = [
  "'binary_get_article_list_home_page_size_aeds'",
  "'binary_get_article_list_category_categoryId_page_size_aeds'",
  "'binary_get_article_list_tag_tagId_page_size_aeds'",
  "'binary_get_article_hot_size_aeds'",
  "'binary_get_article_featured_size_aeds'",
  "credentials: 'omit'",
  "'binary_get_admin_article'"
];
for (const token of required) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] missing frontend token: ${token}`);
    process.exit(1);
  }
}
const forbidden = [
  '/api/binary/article?',
  '/api/binary/article/hot?size=',
  '/api/binary/article/featured?size='
];
for (const token of forbidden) {
  if (source.includes(token)) {
    console.error(`[public-hot-read] stale query public route token: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] ok"
