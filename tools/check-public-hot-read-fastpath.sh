#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FASTPATH_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"
RESIDENCY_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadResidency.cs"
PROJECTOR_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs"
EARLY_DATA_PLANE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs"
SECURITY_GATE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs"
COMPOSITION_FILE="$ROOT_DIR/src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs"
NONCE_TEMPLATE_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs"
ARTICLE_ENDPOINTS_FILE="$ROOT_DIR/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs"
ARTICLE_API_FILE="$ROOT_DIR/src/frontend/src/api/article.ts"
BINARY_TRANSPORT_FILE="$ROOT_DIR/src/frontend/src/services/binaryTransport.ts"

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
const classifier = block.indexOf('UseFsusPublicHotReadClassifier');
const limiter = block.indexOf('UseFsusPublicHotReadRateLimiter');
const gate = block.indexOf('UseFsusPublicHotReadSecurityGate');
const core = block.indexOf('UseFsusCoreMiddlewares');
const fast = block.indexOf('UseFsusPublicHotReadFastPath');
const restore = block.indexOf('UseFsusPublicHotReadFallbackRestore');
const endpoint = block.indexOf('UseFsusEndpointPipeline');
if ([core, classifier, limiter, gate, fast, restore, endpoint].some(index => index < 0)
    || !(core < classifier && classifier < limiter && limiter < gate && gate < fast && fast < restore && restore < endpoint)) {
  console.error('[public-hot-read] classifier/rate/security/writer must run before the generic endpoint pipeline');
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
  'RequestAuditContextMiddleware'
]) {
  if (!endpointBlock.includes(token)) {
    console.error(`[public-hot-read] missing generic downstream sentinel: ${token}`);
    process.exit(1);
  }
}
NODE

echo "[public-hot-read] checking CSP nonce template publication boundary"
node - "$FASTPATH_FILE" "$COMPOSITION_FILE" "$NONCE_TEMPLATE_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, compositionFile, templateFile] = process.argv.slice(2);
const fastPath = fs.readFileSync(fastPathFile, 'utf8');
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
node - "$FASTPATH_FILE" "$RESIDENCY_FILE" "$PROJECTOR_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, residencyFile, projectorFile] = process.argv.slice(2);
const fastPath = fs.readFileSync(fastPathFile, 'utf8');
const residency = fs.readFileSync(residencyFile, 'utf8');
const projector = fs.readFileSync(projectorFile, 'utf8');
for (const token of [
  'MaxResidentBytes',
  'MaxRawBytes',
  'MaxCompressedBytes',
  'MaxHtmlBytes',
  'MaxSnapshotOverlapBytes',
  'MaxArtifactObjects',
  'LifecycleHistory',
  'PublicHotReadResidentBreakdown',
  'ValidateCandidate',
  'IdentityVariant',
  'BrotliVariant',
  'GzipVariant',
  'fsus.hotread.encoding.br'
]) {
  if (!fastPath.includes(token)) {
    console.error(`[public-hot-read] missing resident lifecycle token: ${token}`);
    process.exit(1);
  }
}
for (const token of [
  'GC.GetGCMemoryInfo().TotalAvailableMemoryBytes',
  'LohEligibleArrayBytes',
  'SnapshotOverlapBytes',
  'MaxArticleResidentBytes'
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
NODE

echo "[public-hot-read] checking single-classification feature sharing"
node - "$FASTPATH_FILE" "$EARLY_DATA_PLANE_FILE" "$SECURITY_GATE_FILE" <<'NODE'
const fs = require('node:fs');
const [fastPathFile, earlyDataPlaneFile, securityGateFile] = process.argv.slice(2);
const fastPath = fs.readFileSync(fastPathFile, 'utf8');
const earlyDataPlane = fs.readFileSync(earlyDataPlaneFile, 'utf8');
const securityGate = fs.readFileSync(securityGateFile, 'utf8');
for (const token of [
  'PublicHotReadRequestFeature',
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

echo "[public-hot-read] checking L0 hot path dependency budget"
node - "$FASTPATH_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('public static class PublicHotReadFastPath');
const end = source.indexOf('public readonly record struct PublicHotReadCounterSnapshot');
if (start < 0 || end < 0 || end <= start) {
  console.error('[public-hot-read] unable to isolate PublicHotReadFastPath source block');
  process.exit(1);
}
const block = source.slice(start, end);
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
node - "$FASTPATH_FILE" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
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
