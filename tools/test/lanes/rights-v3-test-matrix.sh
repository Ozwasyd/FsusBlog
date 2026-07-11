#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
EVIDENCE_PATH="$ROOT_DIR/.tmp/release-evidence/rights-v3-test-matrix.json"

BACKEND_OWNERS=(
  "FullyQualifiedName~SchemaMigrationRegistryTests.GetDescriptors_ArticleRightsV3Schema_CreatesPolicySnapshotProofTablesAndBackfillsDefaults"
  "FullyQualifiedName~SchemaMigrationIntegrationTests.RunAsync_CreatesArticleRightsV3SchemaAndBackfillsLegacyArticles"
  "FullyQualifiedName~ArticleRightsCanonicalHashTests"
  "FullyQualifiedName~ArticleRightsWritePathTests"
  "FullyQualifiedName~PodBinaryCodecTests.ArticleWriteRequest_RoundTrip_PreservesTextAndTags"
  "FullyQualifiedName~PodBinaryCodecTests.ArticleWriteRequest_DecodeRejectsLegacyPayloadWithoutRightsV3Section"
  "FullyQualifiedName~PodBinaryCodecTests.ArticleDetail_RoundTrip_PreservesFields"
  "FullyQualifiedName~PodBinaryCodecTests.ArticleDetail_DecodeRejectsLegacyPayloadWithoutV3Envelope"
  "FullyQualifiedName~PodBinaryCodecTests.LegacyPublicArticleArtifact_IsNotAcceptedAsArticleDetailV3"
  "FullyQualifiedName~PodBinaryCodecTests.ArticleDetail_DecodeRejectsInvalidMagicVersionAndTrailingPayload"
  "FullyQualifiedName~AedsProtocolCrossLanguageTests.BackendEncoder_MatchesSharedArticleDetailFixture"
  "FullyQualifiedName~ArticleProjectionTests.ToDetailResponse_UsesContentWhenPresent"
  "FullyQualifiedName~ArticleDetailAedsArtifactStoreBehaviorTests"
  "FullyQualifiedName~ArticleRightsProofModelTests"
  "FullyQualifiedName~TransparencyLogTests.AppendService_HandlesArticleRightsProofRowsAndBackReference"
  "FullyQualifiedName~IntegrityVerificationManifestServiceTests.GetCurrentArticleRightsProofAsync_PublicReadyProofReturnsSafeRightsManifest"
  "FullyQualifiedName~PublicAotInvalidationTrackerTests.InvalidateArticleMutationAsync_BumpsListingVersionsWithoutPrefixScanning"
  "FullyQualifiedName~PublicHotReadFastPathTests.TryServeAsync_DetailHit_WritesPreencodedFrameWithoutNext"
  "FullyQualifiedName~PublicHotReadFastPathTests.BinaryArtifactFactory_ValidatesExpectedFrameAndRejectsCorruption"
  "FullyQualifiedName~PublicHotReadFastPathTests.PreencodedArticleDetailHotPath_AvoidsPerRequestAllocationsAfterWarmup"
)
BACKEND_FILTER="$(IFS='|'; printf '%s' "${BACKEND_OWNERS[*]}")"

FRONTEND_TESTS=(
  "../../tests/frontend/unit/protocol/aeds-contract.test.ts"
  "../../tests/frontend/unit/api/article.test.ts"
  "../../tests/frontend/unit/api/authoring.test.ts"
  "../../tests/frontend/unit/view-contracts/articleDetailRights.test.ts"
  "../../tests/frontend/unit/composables/useAdminArticleWrite.localDraft.test.ts"
  "../../tests/frontend/unit/composables/useCodeBlockCopy.test.ts"
  "../../tests/frontend/unit/public-renderers/publicEntryRegistry.test.ts"
  "../../tests/frontend/unit/public-renderers/publicPayloadNormalizer.test.ts"
  "../../tests/frontend/unit/bootstrap/publicSeedReaders.test.ts"
  "../../tests/frontend/unit/services/publicReadHydrationGuard.test.ts"
)

cd "$ROOT_DIR"

dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --no-restore \
  --filter "$BACKEND_FILTER" \
  -v minimal

if [[ ! -x "$CLIENT_DIR/node_modules/.bin/vitest" ]]; then
  npm --prefix "$CLIENT_DIR" ci --no-audit --progress=false
fi

npm --prefix "$CLIENT_DIR" run check:public-page-manifest-sync
node "$ROOT_DIR/tests/frontend/checks/static/check-article-editor-workspace-governance.mjs"

(
  cd "$CLIENT_DIR"
  npm exec -- vitest run --config vitest.config.ts "${FRONTEND_TESTS[@]}"
)

mkdir -p "$(dirname "$EVIDENCE_PATH")"
node - "$EVIDENCE_PATH" <<'NODE'
const fs = require('node:fs')
const outFile = process.argv[2]

const evidence = {
  schema: 'fsusblog.rights-v3-test-matrix.v1',
  status: 'ok',
  generatedAt: new Date().toISOString(),
  backend: {
    command: 'dotnet test tests/backend/FsusBlog.Server.Tests.csproj',
    covers: [
      'SchemaMigrationRegistryTests.GetDescriptors_ArticleRightsV3Schema_CreatesPolicySnapshotProofTablesAndBackfillsDefaults',
      'SchemaMigrationIntegrationTests.RunAsync_CreatesArticleRightsV3SchemaAndBackfillsLegacyArticles',
      'ArticleRightsCanonicalHashTests',
      'ArticleRightsWritePathTests',
      'PodBinaryCodecTests.ArticleWriteRequest_RoundTrip_PreservesTextAndTags',
      'PodBinaryCodecTests.ArticleWriteRequest_DecodeRejectsLegacyPayloadWithoutRightsV3Section',
      'PodBinaryCodecTests.ArticleDetail_RoundTrip_PreservesFields',
      'PodBinaryCodecTests.ArticleDetail_DecodeRejectsLegacyPayloadWithoutV3Envelope',
      'PodBinaryCodecTests.LegacyPublicArticleArtifact_IsNotAcceptedAsArticleDetailV3',
      'PodBinaryCodecTests.ArticleDetail_DecodeRejectsInvalidMagicVersionAndTrailingPayload',
      'AedsProtocolCrossLanguageTests.BackendEncoder_MatchesSharedArticleDetailFixture',
      'ArticleProjectionTests.ToDetailResponse_UsesContentWhenPresent',
      'ArticleDetailAedsArtifactStoreBehaviorTests',
      'ArticleRightsProofModelTests',
      'TransparencyLogTests.AppendService_HandlesArticleRightsProofRowsAndBackReference',
      'IntegrityVerificationManifestServiceTests.GetCurrentArticleRightsProofAsync_PublicReadyProofReturnsSafeRightsManifest',
      'PublicAotInvalidationTrackerTests.InvalidateArticleMutationAsync_BumpsListingVersionsWithoutPrefixScanning',
      'PublicHotReadFastPathTests.TryServeAsync_DetailHit_WritesPreencodedFrameWithoutNext',
      'PublicHotReadFastPathTests.BinaryArtifactFactory_ValidatesExpectedFrameAndRejectsCorruption',
      'PublicHotReadFastPathTests.PreencodedArticleDetailHotPath_AvoidsPerRequestAllocationsAfterWarmup'
    ]
  },
  frontend: {
    command: 'vitest run',
    covers: [
      'tests/frontend/unit/protocol/aeds-contract.test.ts',
      'tests/frontend/unit/api/article.test.ts',
      'tests/frontend/unit/api/authoring.test.ts',
      'tests/frontend/unit/view-contracts/articleDetailRights.test.ts',
      'tests/frontend/unit/composables/useAdminArticleWrite.localDraft.test.ts',
      'tests/frontend/checks/static/check-article-editor-workspace-governance.mjs',
      'tests/frontend/unit/composables/useCodeBlockCopy.test.ts',
      'tests/frontend/unit/public-renderers/publicEntryRegistry.test.ts',
      'tests/frontend/unit/public-renderers/publicPayloadNormalizer.test.ts',
      'tests/frontend/unit/bootstrap/publicSeedReaders.test.ts',
      'tests/frontend/unit/services/publicReadHydrationGuard.test.ts'
    ]
  },
  acceptanceCriteria: [
    'backend schema migration, canonical hash, write path, V3 codec, projector, proof pipeline',
    'frontend V3 decode, API/view contracts, admin editor flow, public article rendering, PublicAOT hydration',
    'ArticleDetail does not use a separate public rights endpoint',
    'artifact-hit public read does not query rights tables',
    'legacy ArticleDetail payload is rejected',
    'legacy public article artifact is not accepted as V3',
    'preencoded ArticleDetail artifact hot path performance gate'
  ]
}

fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`)
NODE
