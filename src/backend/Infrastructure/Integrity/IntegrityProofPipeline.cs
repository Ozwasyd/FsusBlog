using System.Globalization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public interface IIntegrityProofScheduler
{
    Task<IntegrityProofScheduleResult> ScheduleFromOutboxAsync(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken = default);

    Task<IntegrityProofScheduleResult> ScheduleArticleRightsProofFromOutboxAsync(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken = default);
}

public sealed record IntegrityProofScheduleResult(
    bool Scheduled,
    PublishProofStatus Status,
    string? FailureCode,
    bool ShouldRetry);

public sealed record IntegrityProofOutboxPlan(
    bool ShouldSchedule,
    PublishProofPublicationState PublicationState,
    PublishProofStatus Status,
    string? FailureCode,
    bool ShouldRetry);

public static class IntegrityProofOutboxPlanner
{
    public const int RetryingAttemptThreshold = 1;
    public const int PoisonAttemptThreshold = 10;

    public static IntegrityProofOutboxPlan BuildPlan(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        IEnumerable<ArtifactDigestState> artifactStates,
        int attemptCount,
        PublishProofPublicationState? publicationStateOverride = null)
    {
        ArgumentNullException.ThrowIfNull(completedEdges);
        ArgumentNullException.ThrowIfNull(artifactStates);

        if (articleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(articleId), articleId, "Article id must be positive.");
        }

        if (!ArticleMutationReplayEdges.Required.All(completedEdges.Contains))
        {
            return new IntegrityProofOutboxPlan(
                ShouldSchedule: false,
                PublicationState: PublishProofPublicationState.Public,
                Status: PublishProofStatus.Pending,
                FailureCode: "required-edges-incomplete",
                ShouldRetry: true);
        }

        PublishProofPublicationState publicationState = publicationStateOverride ?? ResolvePublicationState(eventType);
        if (publicationState != PublishProofPublicationState.Public)
        {
            return new IntegrityProofOutboxPlan(
                ShouldSchedule: true,
                PublicationState: publicationState,
                Status: PublishProofStatus.NotPublic,
                FailureCode: "article-not-public",
                ShouldRetry: false);
        }

        ArtifactDigestState[] states = artifactStates.ToArray();
        if (states.Length == 0 || states.Any(static state => state is ArtifactDigestState.Missing
                or ArtifactDigestState.Pending
                or ArtifactDigestState.Unknown
                or ArtifactDigestState.Unavailable))
        {
            string failureCode = states.Length == 0
                ? "artifact-unknown"
                : NormalizeArtifactReason(states.First(static state => state is ArtifactDigestState.Missing
                    or ArtifactDigestState.Pending
                    or ArtifactDigestState.Unknown
                    or ArtifactDigestState.Unavailable));
            return new IntegrityProofOutboxPlan(
                ShouldSchedule: true,
                PublicationState: publicationState,
                Status: attemptCount >= PoisonAttemptThreshold ? PublishProofStatus.Failed : ToRetryStatus(attemptCount),
                FailureCode: failureCode,
                ShouldRetry: attemptCount < PoisonAttemptThreshold);
        }

        ArtifactDigestState? blocking = states.FirstOrDefault(static state => state is ArtifactDigestState.Stale
            or ArtifactDigestState.HashMismatch
            or ArtifactDigestState.NotPublic);
        if (blocking.HasValue && blocking.Value != default)
        {
            PublishProofStatus status = blocking.Value == ArtifactDigestState.NotPublic
                ? PublishProofStatus.NotPublic
                : PublishProofStatus.Failed;
            return new IntegrityProofOutboxPlan(
                ShouldSchedule: true,
                PublicationState: publicationState,
                Status: status,
                FailureCode: NormalizeArtifactReason(blocking.Value),
                ShouldRetry: false);
        }

        return new IntegrityProofOutboxPlan(
            ShouldSchedule: true,
            PublicationState: publicationState,
            Status: PublishProofStatus.Ready,
            FailureCode: null,
            ShouldRetry: false);
    }

    internal static PublishProofPublicationState ResolvePublicationState(string eventType)
        => NormalizeEventType(eventType) switch
        {
            ArticleMutationEventTypes.Deleted
                or ArticleMutationEventTypes.PermanentlyDeleted
                or ArticleMutationEventTypes.TrashCleared => PublishProofPublicationState.Deleted,
            "archived" => PublishProofPublicationState.Archived,
            "scheduled" => PublishProofPublicationState.Scheduled,
            _ => PublishProofPublicationState.Public
        };

    internal static string NormalizeArtifactReason(ArtifactDigestState state)
        => state switch
        {
            ArtifactDigestState.Missing => "artifact-missing",
            ArtifactDigestState.Pending => "artifact-pending",
            ArtifactDigestState.Stale => "artifact-stale",
            ArtifactDigestState.Unknown => "artifact-unknown",
            ArtifactDigestState.Unavailable => "artifact-unavailable",
            ArtifactDigestState.HashMismatch => "artifact-hash-mismatch",
            ArtifactDigestState.NotPublic => "artifact-not-public",
            _ => "artifact-unready"
        };

    private static PublishProofStatus ToRetryStatus(int attemptCount)
        => attemptCount >= RetryingAttemptThreshold ? PublishProofStatus.Retrying : PublishProofStatus.Pending;

    private static string NormalizeEventType(string eventType)
        => string.IsNullOrWhiteSpace(eventType) ? string.Empty : eventType.Trim().ToLowerInvariant();
}

public sealed class IntegrityProofScheduler(
    ISqlSugarClient db,
    IArticleDetailAedsArtifactStore articleDetailArtifacts,
    PublicHotReadStore publicHotReadStore,
    IPublishProofTransparencyLog transparencyLog,
    IConfiguration configuration,
    ILogger<IntegrityProofScheduler> logger,
    TimeProvider timeProvider) : IIntegrityProofScheduler
{
    private const string EmptyArtifactHash = "0000000000000000000000000000000000000000000000000000000000000000";

    public async Task<IntegrityProofScheduleResult> ScheduleFromOutboxAsync(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken = default)
    {
        var loadedRevision = await LoadLatestRevisionAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (loadedRevision is null)
        {
            return new IntegrityProofScheduleResult(false, PublishProofStatus.Pending, "revision-required", true);
        }
        ArticleRevision revision = loadedRevision.Value.Revision;

        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        PublishProofPublicationState publicationState = ResolvePublicationState(eventType, article);
        ArtifactDigestEntry[] artifacts = await BuildArtifactEntriesAsync(articleId, publicationState, cancellationToken)
            .ConfigureAwait(false);
        int attemptCount = await CountPriorAttemptsAsync(articleId, revision.Id, cancellationToken).ConfigureAwait(false);
        IntegrityProofOutboxPlan plan = IntegrityProofOutboxPlanner.BuildPlan(
            articleId,
            eventType,
            completedEdges,
            artifacts.Select(static item => item.State),
            attemptCount,
            publicationState);
        if (!plan.ShouldSchedule)
        {
            return new IntegrityProofScheduleResult(false, plan.Status, plan.FailureCode, plan.ShouldRetry);
        }

        PublishProofInput proof = BuildProofInput(articleId, revision, loadedRevision.Value.Content, article, plan, artifacts);
        long proofId = await UpsertProofAsync(proof, plan.FailureCode, cancellationToken).ConfigureAwait(false);
        await transparencyLog.AppendPublishProofAsync(proofId, cancellationToken).ConfigureAwait(false);
        await ScheduleArticleRightsProofFromOutboxAsync(articleId, eventType, completedEdges, cancellationToken)
            .ConfigureAwait(false);
        logger.LogInformation(
            "integrity-proof-scheduled {ArticleId} {ArticleRevisionId} {Status} {FailureCode}",
            articleId,
            revision.Id,
            plan.Status,
            plan.FailureCode);
        return new IntegrityProofScheduleResult(true, plan.Status, plan.FailureCode, plan.ShouldRetry);
    }

    public async Task<IntegrityProofScheduleResult> ScheduleArticleRightsProofFromOutboxAsync(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken = default)
    {
        if (!ArticleMutationReplayEdges.Required.All(completedEdges.Contains))
        {
            return new IntegrityProofScheduleResult(false, PublishProofStatus.Pending, "required-edges-incomplete", true);
        }

        var loadedRevision = await LoadLatestRevisionAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (loadedRevision is null)
        {
            return new IntegrityProofScheduleResult(false, PublishProofStatus.Pending, "revision-required", true);
        }
        ArticleRevision revision = loadedRevision.Value.Revision;

        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        PublishProofPublicationState publicationState = ResolvePublicationState(eventType, article);
        ArticleRightsSnapshot? snapshot = await LoadRightsSnapshotAsync(articleId, revision.Id, cancellationToken)
            .ConfigureAwait(false);
        if (snapshot is null)
        {
            return new IntegrityProofScheduleResult(false, PublishProofStatus.Pending, "rights-snapshot-missing", true);
        }

        ArticlePublishProof? publishProof = await LoadPublishProofAsync(articleId, revision.Id, cancellationToken)
            .ConfigureAwait(false);
        var proof = new ArticleRightsProofInput(
            ProofVersion: ArticleRightsProofCanonicalPayloadV1.ProofVersion,
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            ArticleRightsSnapshotId: snapshot.Id,
            PublishProofId: publishProof?.Id,
            RightsPolicyHash: NormalizeHashForStorage(snapshot.PolicyHash),
            ContentCanonicalHash: NormalizeHashForStorage(snapshot.ContentCanonicalHash),
            IssuedAtUtc: new DateTimeOffset(article?.PublishedAt ?? revision.CreatedAt, TimeSpan.Zero),
            ProofStatus: PublishProofStatus.Pending,
            PublicationState: publicationState);

        ArticleRightsProofReadiness readiness = ArticleRightsProofReadiness.Evaluate(
            proof,
            rightsSnapshotAvailable: true,
            contentHashReady: IsReadyHash(snapshot.ContentCanonicalHash),
            publishProofReady: IsReadyPublishProof(publishProof));
        PublishProofStatus status = readiness.Status;
        string? failureCode = readiness.Reason;
        SiteIntegritySignature? signature = null;
        if (!snapshot.ProofBindingEnabled && status == PublishProofStatus.Ready)
        {
            status = PublishProofStatus.NotPublic;
            failureCode = "rights-proof-binding-disabled";
        }

        ArticleRightsProofInput finalized = proof with
        {
            ProofStatus = status
        };
        if (status == PublishProofStatus.Ready)
        {
            try
            {
                signature = BuildSigningService().Sign(ArticleRightsProofCanonicalPayloadV1.BuildSigningPayload(finalized));
            }
            catch (SiteIntegritySigningUnavailableException ex)
            {
                status = PublishProofStatus.Failed;
                failureCode = $"signing-{ex.Reason}";
                finalized = finalized with
                {
                    ProofStatus = status
                };
            }
        }

        long rightsProofId = 0;
        var proofTransaction = await db.Ado.UseTranAsync(async () =>
        {
            rightsProofId = await UpsertArticleRightsProofAsync(finalized, signature, failureCode, cancellationToken)
                .ConfigureAwait(false);
            ArticleMutationOutboxEvent outboxEvent = await BuildRightsProofProjectionOutboxEventAsync(
                    articleId,
                    cancellationToken)
                .ConfigureAwait(false);
            int outboxRows = await db.Insertable(outboxEvent)
                .ExecuteCommandAsync(cancellationToken)
                .ConfigureAwait(false);
            if (outboxRows != 1)
            {
                throw new InvalidOperationException("Article rights proof projection outbox insert did not persist exactly one row.");
            }
        }).ConfigureAwait(false);
        if (!proofTransaction.IsSuccess)
        {
            throw new InvalidOperationException(
                $"Article rights proof transaction failed: {proofTransaction.ErrorMessage}",
                proofTransaction.ErrorException);
        }
        if (status == PublishProofStatus.Ready)
        {
            await transparencyLog.AppendArticleRightsProofAsync(rightsProofId, cancellationToken).ConfigureAwait(false);
        }

        logger.LogInformation(
            "article-rights-proof-scheduled {ArticleId} {ArticleRevisionId} {Status} {FailureCode}",
            articleId,
            revision.Id,
            status,
            failureCode);
        return new IntegrityProofScheduleResult(true, status, failureCode, status is PublishProofStatus.Pending or PublishProofStatus.Retrying);
    }

    private Task<ArticleMutationOutboxEvent> BuildRightsProofProjectionOutboxEventAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return ArticleMutationOutboxProducer.CreateCurrentAsync(
            db,
            articleId,
            ArticleMutationEventTypes.RightsProofUpdated,
            now,
            cancellationToken);
    }

    private async Task<(ArticleRevision Revision, string Content)?> LoadLatestRevisionAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == articleId)
            .OrderByDescending(revision => revision.RevisionNo)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (revision is null)
        {
            return null;
        }

        string content = await ArticleRevisionContentBlockStore.LoadAsync(
            db,
            revision.ContentBlockId,
            cancellationToken).ConfigureAwait(false);
        return (revision, content);
    }

    private async Task<ArtifactDigestEntry[]> BuildArtifactEntriesAsync(
        int articleId,
        PublishProofPublicationState publicationState,
        CancellationToken cancellationToken)
    {
        if (publicationState != PublishProofPublicationState.Public)
        {
            return
            [
                ArtifactDigestV1.NotPublic(ArtifactDigestKind.ArticleDetailAeds, $"article-detail-aeds:{articleId}", "article-not-public")
            ];
        }

        ArticleDetailAedsArtifact detail = await articleDetailArtifacts.TryReadAsync(articleId, cancellationToken).ConfigureAwait(false);
        ArtifactDigestEntry detailEntry = detail.Found
            ? ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.ArticleDetailAeds, $"article-detail-aeds:{articleId}", detail.Frame.Span)
            : ArtifactDigestV1.Missing(ArtifactDigestKind.ArticleDetailAeds, $"article-detail-aeds:{articleId}", "file-missing");

        PublicHotReadSnapshot snapshot = publicHotReadStore.Current;
        ArtifactDigestEntry publicHotEntry = FindPublicHotReadArticle(snapshot, articleId) is { } hotRead
            ? ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicHotRead, $"public-hot-read:article:{articleId}", hotRead.Frame.Span)
            : ArtifactDigestV1.Pending(ArtifactDigestKind.PublicHotRead, $"public-hot-read:article:{articleId}", "snapshot-pending");

        return
        [
            detailEntry,
            publicHotEntry,
            ArtifactDigestV1.Unknown(ArtifactDigestKind.PublicAotShell, "public-aot:home", "reader-not-wired"),
            ArtifactDigestV1.Unknown(ArtifactDigestKind.PublicAssetManifest, $"asset-manifest:{articleId}", "reader-not-wired"),
            ArtifactDigestV1.Unknown(ArtifactDigestKind.RssFeed, "feed:rss", "reader-not-wired")
        ];
    }

    private async Task<int> CountPriorAttemptsAsync(int articleId, long articleRevisionId, CancellationToken cancellationToken)
    {
        return await db.Queryable<ArticlePublishProof>()
            .Where(proof => proof.ArticleId == articleId && proof.ArticleRevisionId == articleRevisionId)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<ArticleRightsSnapshot?> LoadRightsSnapshotAsync(
        int articleId,
        long articleRevisionId,
        CancellationToken cancellationToken)
        => await db.Queryable<ArticleRightsSnapshot>()
            .Where(snapshot => snapshot.ArticleId == articleId && snapshot.ArticleRevisionId == articleRevisionId)
            .OrderByDescending(snapshot => snapshot.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

    private async Task<ArticlePublishProof?> LoadPublishProofAsync(
        int articleId,
        long articleRevisionId,
        CancellationToken cancellationToken)
        => await db.Queryable<ArticlePublishProof>()
            .Where(proof => proof.ArticleId == articleId && proof.ArticleRevisionId == articleRevisionId)
            .OrderByDescending(proof => proof.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

    private static PublishProofInput BuildProofInput(
        int articleId,
        ArticleRevision revision,
        string content,
        Article? article,
        IntegrityProofOutboxPlan plan,
        IReadOnlyList<ArtifactDigestEntry> artifacts)
    {
        string canonicalHash = ArticleCanonicalHashV1.ComputeHashHex(new ArticleCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            PublicRouteKey: $"article:{articleId}",
            Title: revision.Title,
            Summary: revision.Summary,
            CoverImageUrl: revision.CoverImageUrl,
            CategoryId: revision.CategoryId,
            TagIds: ParseTagIds(revision.TagIds),
            Status: article is null ? (int)ArticleStatus.Deleted : (int)article.Status,
            PublishedAt: article?.PublishedAt,
            ScheduledPublishAt: article?.ScheduledPublishAt,
            MarkdownContent: content));
        return new PublishProofInput(
            ProofVersion: PublishProofCanonicalPayloadV1.ProofVersion,
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            CanonicalHash: canonicalHash,
            AotHash: FindHash(artifacts, ArtifactDigestKind.PublicAotShell),
            ArticleDetailAedsHash: FindHash(artifacts, ArtifactDigestKind.ArticleDetailAeds),
            PublicHotReadHash: FindHash(artifacts, ArtifactDigestKind.PublicHotRead),
            AssetManifestHash: FindHash(artifacts, ArtifactDigestKind.PublicAssetManifest),
            FeedHash: FindHash(artifacts, ArtifactDigestKind.RssFeed),
            PublishedAtUtc: new DateTimeOffset(article?.PublishedAt ?? revision.CreatedAt, TimeSpan.Zero),
            ProofStatus: plan.Status,
            PublicationState: plan.PublicationState);
    }

    private async Task<long> UpsertProofAsync(PublishProofInput proof, string? failureCode, CancellationToken cancellationToken)
    {
        string idempotencyKey = PublishProofIdempotency.BuildKey(proof.ArticleId, proof.ArticleRevisionId, proof.ProofVersion);
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        System.Data.DataTable rows = await db.Ado.GetDataTableAsync(
            """
            INSERT INTO article_publish_proof (
                proof_version,
                signature_payload_version,
                article_id,
                article_revision_id,
                revision_no,
                idempotency_key,
                canonical_hash,
                aot_hash,
                article_detail_aeds_hash,
                public_hot_read_hash,
                asset_manifest_hash,
                feed_hash,
                published_at,
                proof_status,
                failure_code,
                failure_detail,
                created_at,
                updated_at,
                superseded_at
            )
            VALUES (
                @ProofVersion,
                @SignaturePayloadVersion,
                @ArticleId,
                @ArticleRevisionId,
                @RevisionNo,
                @IdempotencyKey,
                @CanonicalHash,
                @AotHash,
                @ArticleDetailAedsHash,
                @PublicHotReadHash,
                @AssetManifestHash,
                @FeedHash,
                @PublishedAt,
                @ProofStatus,
                @FailureCode,
                @FailureDetail,
                @CreatedAt,
                @UpdatedAt,
                CAST(@SupersededAt AS timestamp)
            )
            ON CONFLICT (idempotency_key) DO UPDATE
            SET canonical_hash = EXCLUDED.canonical_hash,
                aot_hash = EXCLUDED.aot_hash,
                article_detail_aeds_hash = EXCLUDED.article_detail_aeds_hash,
                public_hot_read_hash = EXCLUDED.public_hot_read_hash,
                asset_manifest_hash = EXCLUDED.asset_manifest_hash,
                feed_hash = EXCLUDED.feed_hash,
                proof_status = EXCLUDED.proof_status,
                failure_code = EXCLUDED.failure_code,
                failure_detail = EXCLUDED.failure_detail,
                updated_at = EXCLUDED.updated_at,
                superseded_at = EXCLUDED.superseded_at
            RETURNING id;
            """,
            new SugarParameter("@ProofVersion", proof.ProofVersion),
            new SugarParameter("@SignaturePayloadVersion", PublishProofCanonicalPayloadV1.SignaturePayloadVersion),
            new SugarParameter("@ArticleId", proof.ArticleId),
            new SugarParameter("@ArticleRevisionId", proof.ArticleRevisionId),
            new SugarParameter("@RevisionNo", proof.RevisionNo),
            new SugarParameter("@IdempotencyKey", idempotencyKey),
            new SugarParameter("@CanonicalHash", proof.CanonicalHash),
            new SugarParameter("@AotHash", proof.AotHash),
            new SugarParameter("@ArticleDetailAedsHash", proof.ArticleDetailAedsHash),
            new SugarParameter("@PublicHotReadHash", proof.PublicHotReadHash),
            new SugarParameter("@AssetManifestHash", proof.AssetManifestHash),
            new SugarParameter("@FeedHash", proof.FeedHash),
            new SugarParameter("@PublishedAt", proof.PublishedAtUtc.UtcDateTime),
            new SugarParameter("@ProofStatus", ToStatusToken(proof.ProofStatus)),
            new SugarParameter("@FailureCode", failureCode is null ? DBNull.Value : failureCode),
            new SugarParameter("@FailureDetail", DBNull.Value),
            new SugarParameter("@CreatedAt", now),
            new SugarParameter("@UpdatedAt", now),
            new SugarParameter(
                "@SupersededAt",
                proof.ProofStatus == PublishProofStatus.Superseded ? now : DBNull.Value)).ConfigureAwait(false);

        cancellationToken.ThrowIfCancellationRequested();
        if (rows.Rows.Count == 0)
        {
            throw new InvalidOperationException("Publish proof upsert did not return an id.");
        }

        return Convert.ToInt64(rows.Rows[0][0], CultureInfo.InvariantCulture);
    }

    private async Task<long> UpsertArticleRightsProofAsync(
        ArticleRightsProofInput proof,
        SiteIntegritySignature? signature,
        string? failureCode,
        CancellationToken cancellationToken)
    {
        string idempotencyKey = ArticleRightsProofIdempotency.BuildKey(
            proof.ArticleId,
            proof.ArticleRevisionId,
            proof.ProofVersion);
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        System.Data.DataTable rows = await db.Ado.GetDataTableAsync(
            """
            INSERT INTO article_rights_proof (
                proof_version,
                signature_payload_version,
                article_id,
                article_revision_id,
                revision_no,
                article_rights_snapshot_id,
                publish_proof_id,
                idempotency_key,
                rights_policy_hash,
                content_canonical_hash,
                proof_status,
                signing_key_id,
                signing_key_version,
                signing_algorithm,
                signature,
                failure_code,
                failure_detail,
                created_at,
                updated_at
            )
            VALUES (
                @ProofVersion,
                @SignaturePayloadVersion,
                @ArticleId,
                @ArticleRevisionId,
                @RevisionNo,
                @ArticleRightsSnapshotId,
                CAST(@PublishProofId AS bigint),
                @IdempotencyKey,
                @RightsPolicyHash,
                @ContentCanonicalHash,
                @ProofStatus,
                @SigningKeyId,
                CAST(@SigningKeyVersion AS integer),
                @SigningAlgorithm,
                @Signature,
                @FailureCode,
                @FailureDetail,
                @CreatedAt,
                @UpdatedAt
            )
            ON CONFLICT (idempotency_key) DO UPDATE
            SET article_rights_snapshot_id = EXCLUDED.article_rights_snapshot_id,
                publish_proof_id = EXCLUDED.publish_proof_id,
                rights_policy_hash = EXCLUDED.rights_policy_hash,
                content_canonical_hash = EXCLUDED.content_canonical_hash,
                proof_status = EXCLUDED.proof_status,
                signing_key_id = EXCLUDED.signing_key_id,
                signing_key_version = EXCLUDED.signing_key_version,
                signing_algorithm = EXCLUDED.signing_algorithm,
                signature = EXCLUDED.signature,
                failure_code = EXCLUDED.failure_code,
                failure_detail = EXCLUDED.failure_detail,
                updated_at = EXCLUDED.updated_at
            RETURNING id;
            """,
            new SugarParameter("@ProofVersion", proof.ProofVersion),
            new SugarParameter("@SignaturePayloadVersion", ArticleRightsProofCanonicalPayloadV1.SignaturePayloadVersion),
            new SugarParameter("@ArticleId", proof.ArticleId),
            new SugarParameter("@ArticleRevisionId", proof.ArticleRevisionId),
            new SugarParameter("@RevisionNo", proof.RevisionNo),
            new SugarParameter("@ArticleRightsSnapshotId", proof.ArticleRightsSnapshotId),
            new SugarParameter("@PublishProofId", proof.PublishProofId.HasValue ? proof.PublishProofId.Value : DBNull.Value),
            new SugarParameter("@IdempotencyKey", idempotencyKey),
            new SugarParameter("@RightsPolicyHash", proof.RightsPolicyHash),
            new SugarParameter("@ContentCanonicalHash", proof.ContentCanonicalHash),
            new SugarParameter("@ProofStatus", ToStatusToken(proof.ProofStatus)),
            new SugarParameter("@SigningKeyId", signature is null ? DBNull.Value : signature.KeyId),
            new SugarParameter("@SigningKeyVersion", signature is null ? DBNull.Value : signature.KeyVersion),
            new SugarParameter("@SigningAlgorithm", signature is null ? DBNull.Value : signature.Algorithm),
            new SugarParameter("@Signature", signature is null ? DBNull.Value : signature.SignatureBase64Url),
            new SugarParameter("@FailureCode", failureCode is null ? DBNull.Value : failureCode),
            new SugarParameter("@FailureDetail", DBNull.Value),
            new SugarParameter("@CreatedAt", now),
            new SugarParameter("@UpdatedAt", now)).ConfigureAwait(false);

        cancellationToken.ThrowIfCancellationRequested();
        if (rows.Rows.Count == 0)
        {
            throw new InvalidOperationException("Article rights proof upsert did not return an id.");
        }

        return Convert.ToInt64(rows.Rows[0][0], CultureInfo.InvariantCulture);
    }

    private static PublishProofPublicationState ResolvePublicationState(string eventType, Article? article)
    {
        PublishProofPublicationState eventState = IntegrityProofOutboxPlanner.ResolvePublicationState(eventType);
        if (eventState != PublishProofPublicationState.Public)
        {
            return eventState;
        }

        if (article is null || article.IsDeleted || article.Status == ArticleStatus.Deleted)
        {
            return PublishProofPublicationState.Deleted;
        }

        return article.Status switch
        {
            ArticleStatus.Published => PublishProofPublicationState.Public,
            ArticleStatus.Scheduled => PublishProofPublicationState.Scheduled,
            ArticleStatus.Archived => PublishProofPublicationState.Archived,
            ArticleStatus.Deleted => PublishProofPublicationState.Deleted,
            _ => PublishProofPublicationState.Draft
        };
    }

    private static IReadOnlyList<int> ParseTagIds(string? tagIds)
    {
        if (string.IsNullOrWhiteSpace(tagIds))
        {
            return [];
        }

        return tagIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(static value => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed) ? parsed : 0)
            .Where(static value => value > 0)
            .Distinct()
            .Order()
            .ToArray();
    }

    private static PublicBinaryArtifact? FindPublicHotReadArticle(PublicHotReadSnapshot snapshot, int articleId)
    {
        foreach (KeyValuePair<int, PublicBinaryArtifact> item in snapshot.ArticleArtifacts)
        {
            if (item.Key == articleId)
            {
                return item.Value;
            }
        }

        return null;
    }

    private static string FindHash(IReadOnlyList<ArtifactDigestEntry> artifacts, ArtifactDigestKind kind)
    {
        ArtifactDigestEntry? entry = artifacts.FirstOrDefault(item => item.Kind == kind);
        return entry is { State: ArtifactDigestState.Ready, Sha256Hex.Length: 64 }
            ? entry.Sha256Hex
            : EmptyArtifactHash;
    }

    private SiteIntegritySigningService BuildSigningService()
        => new(BuildSigningRegistry(configuration));

    private static SiteSigningKeyRegistry BuildSigningRegistry(IConfiguration configuration)
    {
        IConfigurationSection signing = configuration.GetSection(SiteIntegritySigningStartupPolicy.SectionName);
        string currentKeyId = RequireConfig(signing["CurrentKeyId"], "current-key-missing");
        List<SiteSigningKeyRecord> keys = [];
        foreach (IConfigurationSection keySection in signing.GetSection("Keys").GetChildren())
        {
            string keyId = keySection.Key.Trim();
            if (keyId.Length == 0)
            {
                continue;
            }

            keys.Add(new SiteSigningKeyRecord(
                KeyId: keyId,
                Version: ParsePositiveInt(keySection["Version"], 1),
                Algorithm: NormalizeSigningAlgorithm(RequireConfig(keySection["Algorithm"], "algorithm-missing")),
                NotBeforeUtc: ParseDateTimeOffset(keySection["NotBeforeUtc"]) ?? DateTimeOffset.UnixEpoch,
                NotAfterUtc: ParseDateTimeOffset(keySection["NotAfterUtc"]),
                RevokedAtUtc: ParseDateTimeOffset(keySection["RevokedAtUtc"]),
                CompromisedAtUtc: ParseDateTimeOffset(keySection["CompromisedAtUtc"]),
                PublicKeySubjectPublicKeyInfoBase64Url: RequireConfig(keySection["PublicKey"], "public-key-missing"),
                PrivateKeyPkcs8Base64Url: RequireConfig(keySection["PrivateKey"], "private-key-missing")));
        }

        if (keys.Count == 0)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(currentKeyId, "key-registry-empty");
        }

        return SiteSigningKeyRegistry.Create(keys, currentKeyId);
    }

    private static string RequireConfig(string? value, string reason)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw SiteIntegritySigningUnavailableException.ForKey("configured-site-key", reason);
        }

        return value.Trim();
    }

    private static string NormalizeSigningAlgorithm(string value)
        => string.Equals(value, "ecdsa-p256-sha256", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, SiteSigningKeyRecord.EcdsaP256Sha256, StringComparison.Ordinal)
                ? SiteSigningKeyRecord.EcdsaP256Sha256
                : value;

    private static int ParsePositiveInt(string? value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed) && parsed > 0
            ? parsed
            : fallback;

    private static DateTimeOffset? ParseDateTimeOffset(string? value)
        => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out DateTimeOffset parsed)
            ? parsed.ToUniversalTime()
            : null;

    private static bool IsReadyPublishProof(ArticlePublishProof? proof)
        => proof is not null
            && (string.Equals(proof.ProofStatus, "ready", StringComparison.Ordinal)
                || string.Equals(proof.ProofStatus, "superseded", StringComparison.Ordinal))
            && !string.IsNullOrWhiteSpace(proof.SigningKeyId)
            && !string.IsNullOrWhiteSpace(proof.SignatureBase64Url);

    private static bool IsReadyHash(string value)
    {
        string normalized = NormalizeHashForStorage(value);
        return HexText.IsSha256Hex(normalized);
    }

    private static string NormalizeHashForStorage(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return EmptyArtifactHash;
        }

        string trimmed = value.Trim();
        if (trimmed.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed["sha256:".Length..];
        }

        return HexText.IsSha256Hex(trimmed)
            ? trimmed.ToLowerInvariant()
            : EmptyArtifactHash;
    }

    private static string ToStatusToken(PublishProofStatus status)
        => status switch
        {
            PublishProofStatus.Pending => "pending",
            PublishProofStatus.Ready => "ready",
            PublishProofStatus.Failed => "failed",
            PublishProofStatus.Retrying => "retrying",
            PublishProofStatus.Superseded => "superseded",
            PublishProofStatus.NotPublic => "not-public",
            _ => "pending"
        };
}
