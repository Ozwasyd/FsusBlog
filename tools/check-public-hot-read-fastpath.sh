#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FASTPATH_FILE="$ROOT_DIR/src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"
PROGRAM_FILE="$ROOT_DIR/src/backend/Program.cs"
ARTICLE_ENDPOINTS_FILE="$ROOT_DIR/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs"
ARTICLE_API_FILE="$ROOT_DIR/src/frontend/src/api/article.ts"
BINARY_TRANSPORT_FILE="$ROOT_DIR/src/frontend/src/services/binaryTransport.ts"

echo "[public-hot-read] checking middleware order"
node - "$PROGRAM_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const fast = source.indexOf('UseFsusPublicHotReadFastPath');
const pipeline = source.indexOf('UseFsusApplicationPipeline');
if (fast < 0 || pipeline < 0 || fast > pipeline) {
  console.error('[public-hot-read] UseFsusPublicHotReadFastPath must appear before UseFsusApplicationPipeline');
  process.exit(1);
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
  'private const string TagPath = "/api/binary/tag.aeds"',
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
  'ValidateStaticHtml',
  'HtmlPathKey',
  'X-Fsus-Required-Route',
  'EnableDiagnosticHeaders',
  'must not depend on nonce',
  'Executable inline script is audited'
];
for (const token of required) {
  if (!source.includes(token)) {
    console.error(`[public-hot-read] missing protocol/readiness token: ${token}`);
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
  '/api/binary/article/list/home/',
  '/api/binary/article/list/category/',
  '/api/binary/article/list/tag/',
  '/api/binary/article/hot/',
  '/api/binary/article/featured/',
  "credentials: 'omit'",
  '/api/binary/admin/article'
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
