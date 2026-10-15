using System.Data.Common;
using System.Globalization;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Articles;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The single canonical article create transaction. Blank and explicit-template creates share
/// this writer, which atomically persists the full article graph — article (draft only),
/// body, taxonomy, initial revision + content block, draft row, rights policy and snapshot,
/// asset references, outbox event, signed audit link, idempotency record, and receipt. Any
/// failure or cancellation rolls the whole graph back: zero partial writes.
/// </summary>
public sealed class PostgresArticleCreatePersistence(
    ISqlSugarClient db,
    IConfiguration configuration) : IArticleCreatePersistence
{
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    public async Task<ArticleCreateReceipt?> ResolveRequestAsync(
        long ownerAdminPrincipalId,
        Guid requestId,
        string requestDigest,
        CancellationToken cancellationToken = default)
        => await TryReplayAsync(ownerAdminPrincipalId, requestId, requestDigest, cancellationToken)
            .ConfigureAwait(false);

    public async Task<ArticleCreateReceipt> ExecuteAsync(
        ArticleCreateCommand command,
        ArticleCreatePayload payload,
        string requestDigest,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(payload);
        ArticleCreateReceipt? replayed = await TryReplayAsync(
            command.Actor.AdminPrincipalId, command.RequestId, requestDigest, cancellationToken)
            .ConfigureAwait(false);
        if (replayed is not null)
        {
            return replayed;
        }

        ArticleCreateReceipt? receipt = null;
        var pendingChainIds = new List<string>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            DateTime now = CanonicalTimestamp();

            int articleId = (int)await db.Insertable(new Article
            {
                Title = payload.Title,
                Summary = payload.Summary,
                CoverImageUrl = null,
                CategoryId = payload.CategoryId,
                CreateTime = now,
                MetadataUpdatedAt = now,
                Status = ArticleStatus.Draft,
                ScheduledPublishAt = null,
                PublishedAt = null,
                LastPublishedAt = null,
                PublicUpdatedAt = null,
                CurrentRevisionId = null,
                CurrentPublicationId = null,
                PendingPublicationAt = null,
                ArchivedAt = null,
                IsDeleted = false
            })
                .ExecuteReturnIdentityAsync()
                .ConfigureAwait(false);
            if (articleId <= 0)
            {
                throw new ArticleCreateException("article_create_article_insert_failed");
            }

            await db.Insertable(new ArticleBody
            {
                ArticleId = articleId,
                MarkdownContent = payload.MarkdownContent,
                UpdatedAt = now
            })
                .ExecuteCommandAsync()
                .ConfigureAwait(false);
            if (payload.TagIds.Count > 0)
            {
                ArticleTag[] tagRows = [.. payload.TagIds.Select(tagId => new ArticleTag
                {
                    ArticleId = articleId,
                    TagId = tagId
                })];
                await db.Insertable(tagRows)
                    .ExecuteCommandAsync()
                    .ConfigureAwait(false);
            }

            long contentBlockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
                db, payload.MarkdownContent, now, cancellationToken).ConfigureAwait(false);
            long revisionId = await db.Insertable(new ArticleRevision
            {
                ArticleId = articleId,
                RevisionNo = 1,
                Title = payload.Title,
                Summary = payload.Summary,
                CoverImageUrl = null,
                CategoryId = payload.CategoryId,
                TagIds = string.Join(',', payload.TagIds.Order()),
                ContentBlockId = contentBlockId,
                DiffSummary = "canonical create",
                CreatedByAdminPrincipalId = command.Actor.AdminPrincipalId,
                RollbackSourceRevisionId = null,
                RollbackReason = null,
                CreatedAt = now
            })
                .IgnoreColumns(static revision => revision.MarkdownContent)
                .ExecuteReturnBigIdentityAsync()
                .ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "UPDATE article SET current_revision_id = @RevisionId WHERE id = @ArticleId;",
                new SugarParameter("@RevisionId", revisionId),
                new SugarParameter("@ArticleId", articleId))
                .ConfigureAwait(false);

            // Draft-level rights carrier: per-article policy defaults. The revision-scoped
            // rights snapshot is created by the publication transition, not by create.
            _ = await db.Insertable(new ArticleRightsPolicy
            {
                ArticleId = articleId,
                CreatedAt = now,
                UpdatedAt = now
            })
                .ExecuteReturnBigIdentityAsync()
                .ConfigureAwait(false);

            string draftKey = $"canonical-create:{command.RequestId:N}";
            long draftId;
            using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                INSERT INTO article_draft (
                    owner_admin_principal_id, article_id, base_revision_id, draft_key,
                    title, summary, cover_image_url, categoryid, tag_ids,
                    markdown_content, client_revision, status, scheduled_publish_at,
                    rights_json, server_revision, created_at, updated_at)
                VALUES (
                    @Owner, @ArticleId, @BaseRevisionId, @DraftKey,
                    @Title, @Summary, NULL, @CategoryId, @TagIds,
                    @MarkdownContent, NULL, 0, NULL,
                    NULL, 1, @Now, @Now)
                RETURNING id;
                """,
                new SugarParameter("@Owner", command.Actor.AdminPrincipalId),
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@BaseRevisionId", revisionId),
                new SugarParameter("@DraftKey", draftKey),
                new SugarParameter("@Title", payload.Title),
                new SugarParameter("@Summary", (object?)payload.Summary ?? DBNull.Value),
                new SugarParameter("@CategoryId", payload.CategoryId),
                new SugarParameter("@TagIds", string.Join(',', payload.TagIds.Order())),
                new SugarParameter("@MarkdownContent", payload.MarkdownContent),
                new SugarParameter("@Now", now))
                .ConfigureAwait(false))
            {
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    throw new ArticleCreateException("article_create_draft_insert_failed");
                }
                draftId = reader.GetInt64(0);
            }

            var assetBoundary = new ArticleAssetReferenceWriteBoundary(db);
            ArticleAssetReferenceWrite[] resolved = await assetBoundary
                .ResolveAsync(payload.MarkdownContent, null, cancellationToken)
                .ConfigureAwait(false);
            ArticleAssetReferenceWrite[] writes = MergeExplicitAssets(resolved, payload.ExplicitAssetIds);
            var assetReferences = new ArticleAssetReferenceStore(db);
            await assetReferences.ReplaceCurrentArticleAsync(articleId, writes, cancellationToken)
                .ConfigureAwait(false);
            await assetReferences.ReplaceRevisionAsync(revisionId, articleId, writes, cancellationToken)
                .ConfigureAwait(false);
            await assetReferences.ReplaceDraftAsync(
                    command.Actor.AdminPrincipalId, draftKey, articleId, writes, cancellationToken)
                .ConfigureAwait(false);

            // Draft-only outbox event: no rights/responsibility/publication snapshot
            // coordinates exist until the first publication transition.
            var outbox = new ArticleMutationOutboxEvent
            {
                EventId = Guid.NewGuid().ToString("N"),
                AggregateType = "article",
                AggregateId = articleId,
                SchemaVersion = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
                ArticleRevisionId = revisionId,
                RevisionNo = 1,
                RightsSnapshotId = null,
                ResponsibilitySnapshotId = null,
                ResponsibilityVersion = null,
                ArticlePublicationId = null,
                PublicationNo = null,
                EventType = ArticleMutationEventTypes.Created,
                PayloadJson = BuildDraftCreateOutboxPayload(articleId, revisionId, payload, now),
                Status = "pending",
                RetryCount = 0,
                NextRetryAt = now,
                CreatedAt = now
            };
            await db.Insertable(outbox).ExecuteCommandAsync().ConfigureAwait(false);

            var receiptId = Guid.CreateVersion7();
            var auditReference = Guid.CreateVersion7();
            string auditDigest = ComputeReceiptAuditDigest(command, requestDigest, articleId, draftId, revisionId, outbox.EventId, payload);
            AuthoringSignedAuditWriter.ChainWrite auditWrite = await AuthoringSignedAuditWriter
                .InsertAsync(
                    db,
                    _tamperKey,
                    new AuditRecord(
                        Source: AuditSourceCatalog.Article,
                        Type: AuditTypeCatalog.Business,
                        OccurredAtUtc: now,
                        EventInfo: auditDigest,
                        ContextPayload: null,
                        Action: AdminPermissions.ArticleWrite,
                        Outcome: AuditOutcomeCatalog.Success,
                        Severity: AuditSeverityCatalog.Info,
                        ActorType: AuditActorTypeCatalog.Admin,
                        ActorId: command.Actor.AdminPrincipalId.ToString(CultureInfo.InvariantCulture),
                        TargetType: "article-create-receipt",
                        TargetId: auditReference.ToString("N"),
                        IsHighValue: true,
                        ReasonCode: command.Mode == ArticleCreateMode.Template ? "template" : "blank"),
                    cancellationToken)
                .ConfigureAwait(false);
            pendingChainIds.Add(auditWrite.ChainId);

            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_create_request(
                    request_id, owner_admin_principal_id, request_digest, receipt_id, created_at_utc)
                VALUES (@RequestId, @Owner, @RequestDigest, @ReceiptId, @OccurredAtUtc);
                """,
                new SugarParameter("@RequestId", command.RequestId),
                new SugarParameter("@Owner", command.Actor.AdminPrincipalId),
                new SugarParameter("@RequestDigest", requestDigest),
                new SugarParameter("@ReceiptId", receiptId),
                new SugarParameter("@OccurredAtUtc", now))
                .ConfigureAwait(false);

            receipt = new ArticleCreateReceipt(
                receiptId,
                command.RequestId,
                command.Actor.AdminPrincipalId,
                command.Mode == ArticleCreateMode.Template ? "template" : "blank",
                command.TemplateId,
                command.TemplateVersionId,
                command.Plan?.VersionNumber,
                command.PlanDigest,
                articleId,
                draftId,
                DraftServerRevision: 1,
                revisionId,
                RevisionNo: 1,
                outbox.EventId,
                auditReference,
                auditDigest,
                payload.SourceDigest,
                payload.DefaultsDigest,
                payload.ReferenceDigest,
                ContentDigest: ComputeReceiptContentDigest(command, payload, articleId, draftId, revisionId, outbox.EventId),
                now);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_create_receipt(
                    receipt_id, request_id, owner_admin_principal_id, create_mode,
                    template_id, template_version_id, template_version_number, plan_digest,
                    article_id, draft_id, draft_server_revision, revision_id, revision_no,
                    outbox_event_id, audit_reference, audit_digest,
                    source_digest, defaults_digest, reference_digest, status,
                    content_digest, occurred_at_utc)
                VALUES (
                    CAST(@ReceiptId AS uuid), CAST(@RequestId AS uuid), @Owner, @CreateMode,
                    CAST(@TemplateId AS uuid), CAST(@TemplateVersionId AS uuid),
                    CAST(@TemplateVersionNumber AS integer), @PlanDigest,
                    @ArticleId, @DraftId, @DraftServerRevision, @RevisionId, @RevisionNo,
                    @OutboxEventId, CAST(@AuditReference AS uuid), @AuditDigest,
                    @SourceDigest, @DefaultsDigest, @ReferenceDigest, 'draft',
                    @ContentDigest, @OccurredAtUtc);
                """,
                new SugarParameter("@ReceiptId", receipt.ReceiptId),
                new SugarParameter("@RequestId", command.RequestId),
                new SugarParameter("@Owner", receipt.OwnerAdminPrincipalId),
                new SugarParameter("@CreateMode", receipt.CreateMode),
                new SugarParameter("@TemplateId", (object?)receipt.TemplateId ?? DBNull.Value),
                new SugarParameter("@TemplateVersionId", (object?)receipt.TemplateVersionId ?? DBNull.Value),
                new SugarParameter("@TemplateVersionNumber", (object?)receipt.TemplateVersionNumber ?? DBNull.Value),
                new SugarParameter("@PlanDigest", (object?)receipt.PlanDigest ?? DBNull.Value),
                new SugarParameter("@ArticleId", receipt.ArticleId),
                new SugarParameter("@DraftId", receipt.DraftId),
                new SugarParameter("@DraftServerRevision", receipt.DraftServerRevision),
                new SugarParameter("@RevisionId", receipt.RevisionId),
                new SugarParameter("@RevisionNo", receipt.RevisionNo),
                new SugarParameter("@OutboxEventId", receipt.OutboxEventId),
                new SugarParameter("@AuditReference", receipt.AuditReference),
                new SugarParameter("@AuditDigest", receipt.AuditDigest),
                new SugarParameter("@SourceDigest", receipt.SourceDigest),
                new SugarParameter("@DefaultsDigest", (object?)receipt.DefaultsDigest ?? DBNull.Value),
                new SugarParameter("@ReferenceDigest", (object?)receipt.ReferenceDigest ?? DBNull.Value),
                new SugarParameter("@ContentDigest", receipt.ContentDigest),
                new SugarParameter("@OccurredAtUtc", receipt.OccurredAtUtc))
                .ConfigureAwait(false);
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is PostgresException postgres
                && postgres.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                ArticleCreateReceipt? replay = await TryReplayAsync(
                    command.Actor.AdminPrincipalId, command.RequestId, requestDigest, cancellationToken)
                    .ConfigureAwait(false);
                if (replay is not null)
                {
                    return replay;
                }
            }
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("article_create_transaction_failed");
        }
        foreach (string chainId in pendingChainIds)
        {
            AuditLogStore.InvalidateChainTail(chainId);
        }
        return receipt ?? throw new InvalidOperationException("article_create_transaction_failed");
    }

    private async Task<ArticleCreateReceipt?> TryReplayAsync(
        long ownerAdminPrincipalId,
        Guid requestId,
        string requestDigest,
        CancellationToken cancellationToken)
    {
        ArticleCreateReceipt? existing = await ReadReceiptAsync(
            ownerAdminPrincipalId, requestId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        string? storedDigest = await db.Ado.GetStringAsync(
            """
            SELECT request_digest FROM article_create_request
            WHERE owner_admin_principal_id = @Owner AND request_id = @RequestId;
            """,
            new SugarParameter("@Owner", ownerAdminPrincipalId),
            new SugarParameter("@RequestId", requestId))
            .ConfigureAwait(false);
        if (!string.Equals(storedDigest, requestDigest, StringComparison.Ordinal))
        {
            throw new ArticleCreateConflictException("article_create_idempotency_conflict");
        }
        return existing with
        {
            IsIdempotentReplay = true
        };
    }

    private async Task<ArticleCreateReceipt?> ReadReceiptAsync(
        long ownerAdminPrincipalId,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, request_id, owner_admin_principal_id, create_mode,
                   template_id, template_version_id, template_version_number, plan_digest,
                   article_id, draft_id, draft_server_revision, revision_id, revision_no,
                   outbox_event_id, audit_reference, audit_digest,
                   source_digest, defaults_digest, reference_digest, status,
                   content_digest, occurred_at_utc
            FROM article_create_receipt
            WHERE owner_admin_principal_id = @Owner AND request_id = @RequestId;
            """,
            new SugarParameter("@Owner", ownerAdminPrincipalId),
            new SugarParameter("@RequestId", requestId))
            .ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new ArticleCreateReceipt(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetInt64(2),
            reader.GetString(3),
            reader.IsDBNull(4) ? null : reader.GetGuid(4),
            reader.IsDBNull(5) ? null : reader.GetGuid(5),
            reader.IsDBNull(6) ? null : reader.GetInt32(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.GetInt32(8),
            reader.GetInt64(9),
            reader.GetInt64(10),
            reader.GetInt64(11),
            reader.GetInt32(12),
            reader.GetString(13),
            reader.GetGuid(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.IsDBNull(17) ? null : reader.GetString(17),
            reader.IsDBNull(18) ? null : reader.GetString(18),
            reader.GetString(20),
            DateTime.SpecifyKind(reader.GetDateTime(21), DateTimeKind.Utc));
    }

    public async Task<ArticleCreateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid receiptId,
        CancellationToken cancellationToken = default)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, request_id, owner_admin_principal_id, create_mode,
                   template_id, template_version_id, template_version_number, plan_digest,
                   article_id, draft_id, draft_server_revision, revision_id, revision_no,
                   outbox_event_id, audit_reference, audit_digest,
                   source_digest, defaults_digest, reference_digest, status,
                   content_digest, occurred_at_utc
            FROM article_create_receipt
            WHERE receipt_id = @ReceiptId;
            """,
            new SugarParameter("@ReceiptId", receiptId))
            .ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var receipt = new ArticleCreateReceipt(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetInt64(2),
            reader.GetString(3),
            reader.IsDBNull(4) ? null : reader.GetGuid(4),
            reader.IsDBNull(5) ? null : reader.GetGuid(5),
            reader.IsDBNull(6) ? null : reader.GetInt32(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.GetInt32(8),
            reader.GetInt64(9),
            reader.GetInt64(10),
            reader.GetInt64(11),
            reader.GetInt32(12),
            reader.GetString(13),
            reader.GetGuid(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.IsDBNull(17) ? null : reader.GetString(17),
            reader.IsDBNull(18) ? null : reader.GetString(18),
            reader.GetString(20),
            DateTime.SpecifyKind(reader.GetDateTime(21), DateTimeKind.Utc));
        await reader.DisposeAsync().ConfigureAwait(false);

        using DbDataReader articleReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT status, current_revision_id, published_at
            FROM article WHERE id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", receipt.ArticleId))
            .ConfigureAwait(false);
        int? articleStatus = null;
        long? currentRevisionId = null;
        DateTime? publishedAt = null;
        bool articlePresent = false;
        if (await articleReader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            articlePresent = true;
            articleStatus = articleReader.GetInt32(0);
            currentRevisionId = articleReader.IsDBNull(1) ? null : articleReader.GetInt64(1);
            publishedAt = articleReader.IsDBNull(2) ? null
                : DateTime.SpecifyKind(articleReader.GetDateTime(2), DateTimeKind.Utc);
        }
        await articleReader.DisposeAsync().ConfigureAwait(false);

        using DbDataReader draftReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT server_revision, title FROM article_draft WHERE id = @DraftId;
            """,
            new SugarParameter("@DraftId", receipt.DraftId))
            .ConfigureAwait(false);
        long? draftRevision = null;
        string? draftTitle = null;
        bool draftPresent = false;
        if (await draftReader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            draftPresent = true;
            draftRevision = draftReader.GetInt64(0);
            draftTitle = draftReader.GetString(1);
        }
        await draftReader.DisposeAsync().ConfigureAwait(false);

        using DbDataReader revisionReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision_no FROM article_revision WHERE id = @RevisionId;
            """,
            new SugarParameter("@RevisionId", receipt.RevisionId))
            .ConfigureAwait(false);
        int? revisionNo = null;
        bool revisionPresent = false;
        if (await revisionReader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            revisionPresent = true;
            revisionNo = revisionReader.GetInt32(0);
        }
        await revisionReader.DisposeAsync().ConfigureAwait(false);

        long assetReferenceCount = await db.Ado.GetIntAsync(
            """
            SELECT COUNT(1) FROM content_asset_reference
            WHERE article_id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", receipt.ArticleId))
            .ConfigureAwait(false);
        long outboxCount = await db.Ado.GetIntAsync(
            """
            SELECT COUNT(1) FROM article_mutation_outbox
            WHERE event_id = @EventId;
            """,
            new SugarParameter("@EventId", receipt.OutboxEventId))
            .ConfigureAwait(false);
        ArticleTemplateAuditLink? auditLink = await ReadAuditLinkAsync(receipt.AuditReference, cancellationToken)
            .ConfigureAwait(false);

        return new ArticleCreateVerificationSnapshot(
            receipt,
            articlePresent ? receipt.ArticleId : null,
            articleStatus,
            currentRevisionId,
            publishedAt,
            draftPresent ? receipt.DraftId : null,
            draftRevision,
            draftTitle,
            revisionPresent ? receipt.RevisionId : null,
            revisionNo,
            assetReferenceCount,
            outboxCount == 1,
            auditLink);
    }

    private async Task<ArticleTemplateAuditLink?> ReadAuditLinkAsync(
        Guid auditReference,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT source, type, action, target_type, target_id, event_info,
                   reason_code, outcome, is_high_value
            FROM sys_audit_log
            WHERE target_type = 'article-create-receipt'
              AND replace(target_id, '-', '') = @AuditRef;
            """,
            new SugarParameter("@AuditRef", auditReference.ToString("N")))
            .ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new ArticleTemplateAuditLink(
            auditReference,
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetString(7),
            reader.GetBoolean(8));
    }

    private static ArticleAssetReferenceWrite[] MergeExplicitAssets(
        ArticleAssetReferenceWrite[] resolved,
        IReadOnlyList<Guid> explicitAssetIds)
    {
        if (explicitAssetIds.Count == 0)
        {
            return resolved;
        }
        var merged = resolved.ToDictionary(write => write.AssetId.Value);
        foreach (Guid assetId in explicitAssetIds)
        {
            if (!merged.ContainsKey(assetId))
            {
                merged[assetId] = new ArticleAssetReferenceWrite(
                    FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(assetId), 1, null);
            }
        }
        return [.. merged.Values.OrderBy(static write => write.AssetId.ToString(), StringComparer.Ordinal)];
    }

    private static string ComputeReceiptAuditDigest(
        ArticleCreateCommand command,
        string requestDigest,
        int articleId,
        long draftId,
        long revisionId,
        string outboxEventId,
        ArticleCreatePayload payload)
        => ArticleTemplateContract.ComputeCommandDigest(
            "article-create-audit",
            requestDigest,
            (int)command.Mode,
            command.TemplateId,
            command.TemplateVersionId,
            command.PlanDigest,
            articleId,
            draftId,
            revisionId,
            outboxEventId,
            payload.SourceDigest,
            payload.DefaultsDigest,
            payload.ReferenceDigest);

    private static string ComputeReceiptContentDigest(
        ArticleCreateCommand command,
        ArticleCreatePayload payload,
        int articleId,
        long draftId,
        long revisionId,
        string outboxEventId)
        => ArticleTemplateContract.ComputeCommandDigest(
            "article-create",
            (int)command.Mode,
            command.Actor.AdminPrincipalId,
            command.RequestId,
            command.TemplateId,
            command.TemplateVersionId,
            command.Plan?.VersionNumber,
            command.PlanDigest,
            articleId,
            draftId,
            revisionId,
            outboxEventId,
            payload.Title,
            payload.Summary,
            payload.CategoryId,
            payload.TagIds.Count,
            Encoding.UTF8.GetBytes(payload.MarkdownContent),
            payload.SourceDigest,
            payload.DefaultsDigest,
            payload.ReferenceDigest);

    private static string BuildDraftCreateOutboxPayload(
        int articleId,
        long revisionId,
        ArticleCreatePayload payload,
        DateTime occurredAt)
        => System.Text.Json.JsonSerializer.Serialize(new
        {
            schemaVersion = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            articleId,
            eventType = ArticleMutationEventTypes.Created,
            articleRevisionId = revisionId,
            revisionNo = 1,
            rightsSnapshotId = (long?)null,
            responsibilitySnapshotId = (long?)null,
            responsibilityVersion = (int?)null,
            releaseId = (long?)null,
            releaseNo = (int?)null,
            publicUpdatedAt = (DateTime?)null,
            occurredAt,
            before = (object?)null,
            after = new
            {
                categoryId = payload.CategoryId,
                tagIds = payload.TagIds,
                visibility = ArticleMutationVisibility.From(ArticleStatus.Draft)
            }
        }, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));

    private static DateTime CanonicalTimestamp()
    {
        DateTime now = DateTime.UtcNow;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
    }
}
