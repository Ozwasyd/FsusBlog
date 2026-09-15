// fixture-catalog: port canonical-article-publication
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public sealed class CanonicalArticlePublicationValidationException(string code, string? message = null)
    : InvalidOperationException(message ?? code)
{
    public string Code { get; } = code;
}

public sealed record CanonicalArticlePublicationFixtureBinding(
    string RunId,
    string Namespace,
    string ProfileId,
    IReadOnlyList<string> Capabilities,
    long AdminPrincipalId,
    string WriterContractDigest,
    string TemporalContextDigest)
{
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(RunId))
            throw new CanonicalArticlePublicationValidationException("run_id_required");
        if (string.IsNullOrWhiteSpace(Namespace))
            throw new CanonicalArticlePublicationValidationException("namespace_required");
        if (string.IsNullOrWhiteSpace(ProfileId))
            throw new CanonicalArticlePublicationValidationException("profile_id_required");
        if (Capabilities is null || Capabilities.Count == 0)
            throw new CanonicalArticlePublicationValidationException("capabilities_required");
        if (AdminPrincipalId <= 0)
            throw new CanonicalArticlePublicationValidationException("admin_principal_id_invalid", "Admin principal ID must be strictly positive and reference an owned active admin.");
        if (string.IsNullOrWhiteSpace(WriterContractDigest) || !IsDigest(WriterContractDigest))
            throw new CanonicalArticlePublicationValidationException("writer_contract_digest_invalid");
        if (string.IsNullOrWhiteSpace(TemporalContextDigest) || !IsDigest(TemporalContextDigest))
            throw new CanonicalArticlePublicationValidationException("temporal_context_digest_invalid");
    }

    private static bool IsDigest(string value)
        => (value.StartsWith("sha256:", StringComparison.Ordinal) && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdefABCDEF") < 0)
           || (value.Length == 64 && value.AsSpan().IndexOfAnyExcept("0123456789abcdefABCDEF") < 0);
}

public sealed record CanonicalArticlePublicationPlan(
    string SemanticRole,
    string Title,
    string Content,
    string? Summary = null,
    string? CoverImageUrl = null,
    int CategoryId = 0,
    IReadOnlyList<int>? TagIds = null,
    ArticleRightsRequestCoreModel? Rights = null,
    ArticleResponsibilityDraft? Responsibility = null);

public sealed record CanonicalArticlePublicationRequest(
    CanonicalArticlePublicationFixtureBinding Binding,
    CanonicalArticlePublicationPlan Plan,
    Guid? RequestId = null);

public sealed record CanonicalArticlePublicationReceipt(
    string Schema,
    string WriterContractDigest,
    string RunId,
    string Namespace,
    string ProfileId,
    string SemanticRole,
    long AdminPrincipalId,
    int ArticleId,
    long RevisionId,
    int RevisionNo,
    long PublicationId,
    int PublicationNo,
    long RightsSnapshotId,
    string ContentCanonicalHash,
    string PolicyHash,
    long ResponsibilitySnapshotId,
    int ResponsibilityVersion,
    string OutboxEventId,
    string OutboxPayloadDigest,
    string AuditChainId,
    string AuditRecordHash,
    string ContentDigest,
    IReadOnlyList<string> RequiredEdges,
    string ReceiptDigest);

public sealed record CanonicalArticlePublicationResult(
    CanonicalArticlePublicationReceipt Receipt,
    bool IdempotencyReplay);

public interface ICanonicalArticlePublicationFixturePort
{
    Task<CanonicalArticlePublicationResult> PublishAsync(
        CanonicalArticlePublicationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class CanonicalArticlePublicationFixturePort(
    ISqlSugarClient db,
    IConfiguration configuration,
    IArticlePublicationValidator publicationValidator,
    TimeProvider? timeProvider = null) : ICanonicalArticlePublicationFixturePort
{
    public const string Schema = "fsusblog.canonical-article-publication-receipt.v1";
    public const string DefaultWriterContract = "fsusblog.canonical-article-publication-writer.v1";

    public async Task<CanonicalArticlePublicationResult> PublishAsync(
        CanonicalArticlePublicationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Binding);
        ArgumentNullException.ThrowIfNull(request.Plan);

        request.Binding.Validate();

        if (string.IsNullOrWhiteSpace(request.Plan.SemanticRole))
            throw new CanonicalArticlePublicationValidationException("semantic_role_required");
        if (string.IsNullOrWhiteSpace(request.Plan.Title))
            throw new CanonicalArticlePublicationValidationException("title_required");
        if (string.IsNullOrWhiteSpace(request.Plan.Content))
            throw new CanonicalArticlePublicationValidationException("content_required");
        if (request.Plan.CategoryId <= 0)
            throw new CanonicalArticlePublicationValidationException("category_required");

        // Fail-closed against 'recompute' sentinels or placeholders
        RejectRecomputeSentinel(request.Plan.Title, "title");
        RejectRecomputeSentinel(request.Plan.Content, "content");
        RejectRecomputeSentinel(request.Plan.Summary, "summary");
        if (request.Plan.Rights is not null)
        {
            RejectRecomputeSentinel(request.Plan.Rights.Value.LicenseType, "license_type");
            RejectRecomputeSentinel(request.Plan.Rights.Value.RightsStatement, "rights_statement");
            RejectRecomputeSentinel(request.Plan.Rights.Value.AttributionTemplate, "attribution_template");
            RejectRecomputeSentinel(request.Plan.Rights.Value.CopyrightHolder, "copyright_holder");
        }

        // Canonical publication mandates a complete responsibility plan
        if (request.Plan.Responsibility is null)
        {
            throw new CanonicalArticlePublicationValidationException(
                "responsibility_required",
                "Canonical article publication requires an explicit, verified responsibility plan.");
        }

        IReadOnlyList<PrepublishIssue> responsibilityIssues =
            ArticleResponsibilityGovernance.Evaluate(request.Plan.Responsibility);
        if (responsibilityIssues.Any(static i => string.Equals(i.Severity, "error", StringComparison.OrdinalIgnoreCase)))
        {
            var err = responsibilityIssues.First(static i => string.Equals(i.Severity, "error", StringComparison.OrdinalIgnoreCase));
            throw new CanonicalArticlePublicationValidationException(
                $"responsibility_invalid:{err.Code}",
                err.Message);
        }

        // Active admin check
        AdminPrincipal? admin = await db.Queryable<AdminPrincipal>()
            .Where(a => a.Id == request.Binding.AdminPrincipalId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (admin is null || !string.Equals(admin.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            throw new CanonicalArticlePublicationValidationException(
                "active_admin_required",
                $"Admin principal {request.Binding.AdminPrincipalId} is not active or missing.");
        }

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;

        // Content validation via production ArticlePublicationValidator
        var contentValidation = await publicationValidator.ValidateAsync(
            new ArticlePublicationValidationInput(
                request.Plan.Title,
                request.Plan.Content,
                request.Plan.Summary,
                request.Plan.CoverImageUrl,
                request.Plan.CategoryId,
                request.Plan.TagIds ?? [],
                ArticleStatus.Published,
                ScheduledPublishAt: null),
            now,
            cancellationToken)
            .ConfigureAwait(false);
        contentValidation.ThrowIfWriteBlocked();

        // Idempotency check bound to run, semantic role, and plan.
        // Materialize Guid.ToString outside the expression tree so SqlSugar does not emit to_char(uuid, ...).
        string clientMutationId = DeriveClientMutationId(
            request.Binding.RunId,
            request.Binding.Namespace,
            request.Plan.SemanticRole).ToString("D");
        string requestHash = ComputeRequestHash(request.Plan);

        ArticleMutationCommand? existingCommand = await db.Queryable<ArticleMutationCommand>()
            .Where(c => c.AdminPrincipalId == request.Binding.AdminPrincipalId
                     && c.ClientMutationId == clientMutationId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (existingCommand is not null)
        {
            if (!string.Equals(existingCommand.RequestHash, requestHash, StringComparison.Ordinal))
            {
                throw new ArticleMutationContentConflictException();
            }

            CanonicalArticlePublicationReceipt replayedReceipt = await LoadReplayReceiptAsync(
                existingCommand,
                request.Binding,
                request.Plan.SemanticRole,
                cancellationToken)
                .ConfigureAwait(false);
            return new CanonicalArticlePublicationResult(replayedReceipt, IdempotencyReplay: true);
        }

        // Single authority atomic transaction
        CanonicalArticlePublicationReceipt? receipt = null;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            string title = ArticleProductionNormalizers.NormalizeText(
                request.Plan.Title, ArticleProductionNormalizers.MaxTitleLength);
            string content = ArticleProductionNormalizers.NormalizeText(
                request.Plan.Content, ArticleProductionNormalizers.MaxContentLength);
            string summary = ArticleProductionNormalizers.NormalizeText(
                request.Plan.Summary, ArticleProductionNormalizers.MaxSummaryLength);
            string coverImageUrl = ArticleProductionNormalizers.NormalizeText(
                request.Plan.CoverImageUrl, ArticleProductionNormalizers.MaxCoverImageUrlLength);
            List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds(request.Plan.TagIds);
            ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
            string safeSummary = summaryProjection.Text;

            // 1. Insert Article
            var article = new Article
            {
                Title = title,
                Summary = safeSummary,
                CoverImageUrl = coverImageUrl,
                CategoryId = request.Plan.CategoryId,
                CreateTime = now,
                MetadataUpdatedAt = now,
                Status = ArticleStatus.Published,
                ScheduledPublishAt = null,
                PublishedAt = now,
                LastPublishedAt = now,
                PublicUpdatedAt = now,
                CurrentRevisionId = null,
                CurrentPublicationId = null,
                PendingPublicationAt = null,
                ArchivedAt = null,
                IsDeleted = false,
                Content = content
            };
            int articleId = await db.Insertable(article).ExecuteReturnIdentityAsync().ConfigureAwait(false);
            if (articleId <= 0)
            {
                throw new InvalidOperationException("article_insert_failed");
            }

            // 2. Insert ArticleBody
            await db.Insertable(new ArticleBody
            {
                ArticleId = articleId,
                MarkdownContent = content,
                UpdatedAt = now
            }).ExecuteCommandAsync().ConfigureAwait(false);

            // 3. Insert ArticleTags
            if (tagIds.Count > 0)
            {
                List<ArticleTag> tagRows = [.. tagIds.Select(tagId => new ArticleTag
                {
                    ArticleId = articleId,
                    TagId = tagId
                })];
                await db.Insertable(tagRows).ExecuteCommandAsync().ConfigureAwait(false);
            }

            // 4. Content block
            long contentBlockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
                db, content, now, cancellationToken).ConfigureAwait(false);

            // 5. Insert ArticleRevision
            var revision = new ArticleRevision
            {
                ArticleId = articleId,
                RevisionNo = 1,
                Title = title,
                Summary = safeSummary,
                CoverImageUrl = coverImageUrl,
                CategoryId = request.Plan.CategoryId,
                TagIds = string.Join(',', tagIds.OrderBy(static id => id)),
                ContentBlockId = contentBlockId,
                MarkdownContent = string.Empty,
                DiffSummary = "initial publish",
                CreatedByAdminPrincipalId = request.Binding.AdminPrincipalId,
                RollbackSourceRevisionId = null,
                RollbackReason = null,
                CreatedAt = now
            };
            long revisionId = await db.Insertable(revision).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);
            if (revisionId <= 0)
            {
                throw new InvalidOperationException("revision_insert_failed");
            }

            // 6. Asset References
            var assetBoundary = new ArticleAssetReferenceWriteBoundary(db);
            ArticleAssetReferenceWrite[] assetWrites = await assetBoundary
                .ResolveAsync(content, coverImageUrl, cancellationToken)
                .ConfigureAwait(false);
            var assetStore = new ArticleAssetReferenceStore(db);
            await assetStore.ReplaceCurrentArticleAsync(articleId, assetWrites, cancellationToken).ConfigureAwait(false);
            await assetStore.ReplaceRevisionAsync(revisionId, articleId, assetWrites, cancellationToken).ConfigureAwait(false);

            // 7. Rights Policy & Snapshot (production-shared upsert + snapshot builder)
            ArticleRightsNormalizedModel rights = ArticleProductionNormalizers.NormalizeArticleRights(request.Plan.Rights);
            long policyId = await ArticleRightsPolicyPersistence.UpsertAsync(
                db,
                articleId,
                rights,
                now,
                cancellationToken).ConfigureAwait(false);

            var (rightsSnapshot, contentCanonicalHash, policyHash) = ArticleRightsSnapshotBuilder.Build(
                articleId,
                revisionId,
                1,
                policyId,
                title,
                content,
                safeSummary,
                coverImageUrl,
                request.Plan.CategoryId,
                tagIds,
                ArticleStatus.Published,
                publishedAt: now,
                scheduledPublishAt: null,
                rights,
                now);
            long rightsSnapshotId = await db.Insertable(rightsSnapshot).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);

            // 8. Responsibility Snapshot
            var respSnapshot = ArticleResponsibilitySnapshotBuilder.Build(
                articleId,
                revisionId,
                1,
                1,
                previousSnapshotId: null,
                request.Plan.Responsibility,
                now);
            long responsibilitySnapshotId = await db.Insertable(respSnapshot).ExecuteReturnBigIdentityAsync().ConfigureAwait(false);

            // 9. ArticlePublicationTransitionWriter.ApplyAsync
            ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
                db,
                new ArticlePublicationTransitionRequest(
                    articleId,
                    new ArticleVersionCoordinates(
                        revisionId,
                        1,
                        rightsSnapshotId,
                        responsibilitySnapshotId,
                        null,
                        null,
                        1),
                    ArticleStatus.Published,
                    ScheduledPublishAt: null,
                    TransitionedAt: now,
                    TransitionKind: ArticlePublicationTransitionKinds.ImmediatePublish,
                    Operation: ArticleStatusTransitionOperation.Create),
                cancellationToken).ConfigureAwait(false);

            if (!version.PublicationId.HasValue || !version.PublicationNo.HasValue)
            {
                throw new InvalidOperationException("publication_insert_failed");
            }

            // 10. Outbox Event (sealed fixed coordinates)
            var outbox = ArticleMutationOutboxProducer.Create(
                articleId,
                ArticleMutationEventTypes.Created,
                version,
                before: null,
                after: new ArticleMutationScopeSnapshot(
                    request.Plan.CategoryId,
                    tagIds.ToArray(),
                    ArticleMutationVisibility.From(ArticleStatus.Published)),
                occurredAt: now,
                publicUpdatedAt: now);
            await db.Insertable(outbox).ExecuteCommandAsync().ConfigureAwait(false);

            // 11. Signed Audit Log
            byte[]? tamperKey = AuditTamperEvidence.ResolveKey(configuration);
            string auditDigest = ComputeAuditDigest(
                articleId, revisionId, version.PublicationId.Value, rightsSnapshotId, responsibilitySnapshotId, outbox.EventId);
            var auditRecord = new AuditRecord(
                Source: AuditSourceCatalog.Article,
                Type: AuditTypeCatalog.Business,
                OccurredAtUtc: now,
                EventInfo: auditDigest,
                ContextPayload: null,
                Action: AdminPermissions.ArticleWrite,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.Admin,
                ActorId: request.Binding.AdminPrincipalId.ToString(CultureInfo.InvariantCulture),
                TargetType: "article-canonical-publication",
                TargetId: articleId.ToString(CultureInfo.InvariantCulture),
                IsHighValue: true,
                ReasonCode: "canonical-publish");
            AuthoringSignedAuditWriter.ChainWrite auditWrite = await AuthoringSignedAuditWriter.InsertAsync(
                db,
                tamperKey,
                auditRecord,
                cancellationToken).ConfigureAwait(false);

            // 12. Idempotency Record
            var command = new ArticleMutationCommand
            {
                AdminPrincipalId = request.Binding.AdminPrincipalId,
                ClientMutationId = clientMutationId,
                RequestHash = requestHash,
                ArticleId = articleId,
                RevisionId = revisionId,
                RevisionNo = 1,
                ReleaseId = version.PublicationId.Value,
                ReleaseNo = version.PublicationNo.Value,
                Status = (int)ArticleStatus.Published,
                RightsSnapshotId = rightsSnapshotId,
                RightsRevisionNo = 1,
                CreatedAtUtc = now
            };
            await db.Insertable(command).ExecuteCommandAsync().ConfigureAwait(false);

            // 13. Build Result Receipt
            string outboxPayloadDigest = ComputeOutboxPayloadDigest(outbox.PayloadJson);
            string contentDigest = ComputeContentDigest(content);
            var requiredEdges = ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray();
            string receiptDigest = ComputeReceiptDigest(
                request.Binding.WriterContractDigest,
                articleId,
                revisionId,
                version.PublicationId.Value,
                rightsSnapshotId,
                contentCanonicalHash,
                policyHash,
                responsibilitySnapshotId,
                outbox.EventId,
                outboxPayloadDigest,
                auditWrite.ChainId,
                auditWrite.RecordHash,
                contentDigest);

            receipt = new CanonicalArticlePublicationReceipt(
                Schema: Schema,
                WriterContractDigest: request.Binding.WriterContractDigest,
                RunId: request.Binding.RunId,
                Namespace: request.Binding.Namespace,
                ProfileId: request.Binding.ProfileId,
                SemanticRole: request.Plan.SemanticRole,
                AdminPrincipalId: request.Binding.AdminPrincipalId,
                ArticleId: articleId,
                RevisionId: revisionId,
                RevisionNo: 1,
                PublicationId: version.PublicationId.Value,
                PublicationNo: version.PublicationNo.Value,
                RightsSnapshotId: rightsSnapshotId,
                ContentCanonicalHash: contentCanonicalHash,
                PolicyHash: policyHash,
                ResponsibilitySnapshotId: responsibilitySnapshotId,
                ResponsibilityVersion: 1,
                OutboxEventId: outbox.EventId,
                OutboxPayloadDigest: outboxPayloadDigest,
                AuditChainId: auditWrite.ChainId,
                AuditRecordHash: auditWrite.RecordHash,
                ContentDigest: contentDigest,
                RequiredEdges: requiredEdges,
                ReceiptDigest: receiptDigest);
        }).ConfigureAwait(false);

        if (!tran.IsSuccess || receipt is null)
        {
            throw new InvalidOperationException("canonical_article_publication_transaction_failed", tran.ErrorException);
        }

        return new CanonicalArticlePublicationResult(receipt!, IdempotencyReplay: false);
    }

    private static void RejectRecomputeSentinel(string? value, string fieldName)
    {
        if (!string.IsNullOrEmpty(value) && value.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            throw new CanonicalArticlePublicationValidationException(
                "rights_recompute_sentinel_forbidden",
                $"Field '{fieldName}' contains prohibited recompute sentinel.");
        }
    }

    private static Guid DeriveClientMutationId(string runId, string ns, string semanticRole)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes($"canonical-publish:{runId}:{ns}:{semanticRole}"));
        Span<byte> guidBytes = stackalloc byte[16];
        hash.AsSpan(0, 16).CopyTo(guidBytes);
        return new Guid(guidBytes);
    }

    public static string ComputeRequestHash(CanonicalArticlePublicationPlan plan)
    {
        var input = new
        {
            semanticRole = plan.SemanticRole,
            title = plan.Title,
            content = plan.Content,
            summary = plan.Summary,
            coverImageUrl = plan.CoverImageUrl,
            categoryId = plan.CategoryId,
            tagIds = plan.TagIds?.Order().ToArray() ?? [],
            rights = plan.Rights,
            responsibility = plan.Responsibility
        };
        string json = JsonSerializer.Serialize(input);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
    }

    public static string ComputeOutboxPayloadDigest(string payloadJson)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson))).ToLowerInvariant();

    public static string ComputeContentDigest(string content)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    public static string ComputeAuditDigest(
        int articleId,
        long revisionId,
        long publicationId,
        long rightsSnapshotId,
        long responsibilitySnapshotId,
        string outboxEventId)
    {
        string raw = FormattableString.Invariant(
            $"article:{articleId}:rev:{revisionId}:pub:{publicationId}:rights:{rightsSnapshotId}:resp:{responsibilitySnapshotId}:outbox:{outboxEventId}");
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
    }

    public static string ComputeReceiptDigest(
        string writerContractDigest,
        int articleId,
        long revisionId,
        long publicationId,
        long rightsSnapshotId,
        string contentCanonicalHash,
        string policyHash,
        long responsibilitySnapshotId,
        string outboxEventId,
        string outboxPayloadDigest,
        string auditChainId,
        string auditRecordHash,
        string contentDigest)
    {
        string raw = FormattableString.Invariant(
            $"{writerContractDigest}|{articleId}|{revisionId}|{publicationId}|{rightsSnapshotId}|{contentCanonicalHash}|{policyHash}|{responsibilitySnapshotId}|{outboxEventId}|{outboxPayloadDigest}|{auditChainId}|{auditRecordHash}|{contentDigest}");
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
    }

    private async Task<CanonicalArticlePublicationReceipt> LoadReplayReceiptAsync(
        ArticleMutationCommand existingCommand,
        CanonicalArticlePublicationFixtureBinding binding,
        string semanticRole,
        CancellationToken cancellationToken)
    {
        int articleId = existingCommand.ArticleId;
        long revisionId = existingCommand.RevisionId;
        long publicationId = existingCommand.ReleaseId;
        long rightsSnapshotId = existingCommand.RightsSnapshotId;

        ArticleRightsSnapshot rightsSnapshot = await db.Queryable<ArticleRightsSnapshot>()
            .Where(s => s.Id == rightsSnapshotId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Rights snapshot {rightsSnapshotId} missing on replay.");

        ArticleResponsibilitySnapshot respSnapshot = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(r => r.ArticleRevisionId == revisionId)
            .OrderBy(r => r.ResponsibilityVersion, OrderByType.Desc)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Responsibility snapshot for revision {revisionId} missing on replay.");

        ArticleMutationOutboxEvent outbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(o => o.ArticleRevisionId == revisionId && o.ArticlePublicationId == publicationId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Outbox event for revision {revisionId} missing on replay.");

        string auditChainId;
        string auditRecordHash;
        using (System.Data.IDataReader? reader = await db.Ado.GetDataReaderAsync(
            """
            SELECT chain_id, record_hash
            FROM sys_audit_log
            WHERE target_type = 'article-canonical-publication'
              AND target_id = @TargetId
            ORDER BY id DESC
            LIMIT 1;
            """,
            new SugarParameter("@TargetId", articleId.ToString(CultureInfo.InvariantCulture)))
            .ConfigureAwait(false))
        {
            if (reader is null || !reader.Read())
            {
                throw new InvalidOperationException($"Audit log for article {articleId} missing on replay.");
            }
            auditChainId = reader.GetString(0);
            auditRecordHash = reader.GetString(1);
        }

        ArticleBody body = await db.Queryable<ArticleBody>()
            .Where(b => b.ArticleId == articleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Article body {articleId} missing on replay.");

        string outboxPayloadDigest = ComputeOutboxPayloadDigest(outbox.PayloadJson);
        string contentDigest = ComputeContentDigest(body.MarkdownContent);
        var requiredEdges = ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray();
        string receiptDigest = ComputeReceiptDigest(
            binding.WriterContractDigest,
            articleId,
            revisionId,
            publicationId,
            rightsSnapshotId,
            rightsSnapshot.ContentCanonicalHash,
            rightsSnapshot.PolicyHash,
            respSnapshot.Id,
            outbox.EventId,
            outboxPayloadDigest,
            auditChainId,
            auditRecordHash,
            contentDigest);

        return new CanonicalArticlePublicationReceipt(
            Schema: Schema,
            WriterContractDigest: binding.WriterContractDigest,
            RunId: binding.RunId,
            Namespace: binding.Namespace,
            ProfileId: binding.ProfileId,
            SemanticRole: semanticRole,
            AdminPrincipalId: binding.AdminPrincipalId,
            ArticleId: articleId,
            RevisionId: revisionId,
            RevisionNo: existingCommand.RevisionNo,
            PublicationId: publicationId,
            PublicationNo: existingCommand.ReleaseNo,
            RightsSnapshotId: rightsSnapshotId,
            ContentCanonicalHash: rightsSnapshot.ContentCanonicalHash,
            PolicyHash: rightsSnapshot.PolicyHash,
            ResponsibilitySnapshotId: respSnapshot.Id,
            ResponsibilityVersion: respSnapshot.ResponsibilityVersion,
            OutboxEventId: outbox.EventId,
            OutboxPayloadDigest: outboxPayloadDigest,
            AuditChainId: auditChainId,
            AuditRecordHash: auditRecordHash,
            ContentDigest: contentDigest,
            RequiredEdges: requiredEdges,
            ReceiptDigest: receiptDigest);
    }
}
