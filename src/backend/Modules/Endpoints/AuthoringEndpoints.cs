using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class AuthoringEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapAuthoringEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/author")
            .WithTags("Authoring")
            .RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapPost("/drafts", async (
            ServerDraftSaveRequest request,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse saved = await service.SaveDraftAsync(context.User.GetUserId(), request, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse>.Ok(saved));
        });

        group.MapGet("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse? draft = await service.GetDraftAsync(context.User.GetUserId(), draftKey, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse?>.Ok(draft));
        });

        group.MapDelete("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            bool discarded = await service.DiscardDraftAsync(context.User.GetUserId(), draftKey, cancellationToken);
            return Results.Ok(JsonApiResponse<object>.Ok(new { discarded }));
        });

        group.MapPost("/preview", async (ServerDraftSaveRequest request, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<ArticlePreviewResponse>.Ok(await service.PreviewAsync(request))));

        group.MapPost("/prepublish-check", (ServerDraftSaveRequest request, HttpContext context, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<PrepublishCheckResponse>.Ok(
                service.RunPrepublishCheck(
                    request.Title,
                    request.Content,
                    request.Summary,
                    request.CoverImageUrl,
                    context.User.GetUserId(),
                    request.DraftKey,
                    request.ArticleId,
                    request.WarningOverrideReason))));

        group.MapGet("/articles/{articleId:int}/revisions", async (
            int articleId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<ArticleRevisionSummaryResponse> revisions = await service.GetRevisionsAsync(articleId, cancellationToken);
            return Results.Ok(JsonApiResponse<IReadOnlyList<ArticleRevisionSummaryResponse>>.Ok(revisions));
        });

        group.MapGet("/articles/{articleId:int}/revisions/{revisionId:long}", async (
            int articleId,
            long revisionId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ArticleRevisionDetailResponse? revision = await service.GetRevisionAsync(articleId, revisionId, cancellationToken);
            return revision is null
                ? Results.NotFound(JsonApiResponse<ArticleRevisionDetailResponse>.Fail("revision_not_found"))
                : Results.Ok(JsonApiResponse<ArticleRevisionDetailResponse>.Ok(revision));
        });

        group.MapPost("/articles/{articleId:int}/revisions/{revisionId:long}/rollback", async (
            int articleId,
            long revisionId,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            bool rolledBack = await service.RollbackRevisionAsync(context.User.GetUserId(), articleId, revisionId, cancellationToken);
            return rolledBack
                ? Results.Ok(JsonApiResponse<object>.Ok(new { rolledBack }))
                : Results.NotFound(JsonApiResponse<object>.Fail("revision_not_found"));
        });

        group.MapPost("/articles/{articleId:int}/assets/reindex", async (
            int articleId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<AssetLibraryItemResponse> assets = await service.ReindexAssetsAsync(articleId, cancellationToken);
            return Results.Ok(JsonApiResponse<IReadOnlyList<AssetLibraryItemResponse>>.Ok(assets));
        });

        group.MapGet("/assets", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AssetLibraryItemResponse>>.Ok(await service.ListAssetsAsync(cancellationToken))));

        group.MapDelete("/assets/orphans", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<AssetCleanupResponse>.Ok(await service.CleanupOrphanAssetsAsync(cancellationToken))));

        group.MapGet("/taxonomy/categories", async (ISqlSugarClient db, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AdminCategoryItemResponse>>.Ok(await ListAdminCategoriesAsync(db, cancellationToken))));

        group.MapGet("/taxonomy/tags", async (ISqlSugarClient db, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AdminTagItemResponse>>.Ok(await ListAdminTagsAsync(db, cancellationToken))));

        group.MapGet("/analytics", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<AuthorAnalyticsResponse>.Ok(await service.GetAnalyticsAsync(cancellationToken))));

        group.MapGet("/comments/moderation", async (
            int? status,
            int? limit,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveModerationStatus(status, out CommentModerationStatus? resolvedStatus))
            {
                return Results.BadRequest(JsonApiResponse<object>.Fail("comment_status_invalid"));
            }

            CommentModerationQueueResponse queue = await service.ListCommentModerationQueueAsync(resolvedStatus, limit ?? 50, cancellationToken);
            return Results.Ok(JsonApiResponse<CommentModerationQueueResponse>.Ok(queue));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/bulk", async (
            CommentModerationBulkRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CommentModerationBulkResponse response = await service.ModerateCommentsAsync(context.User.GetUserId(), request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.CommentBulkModerated,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员批量审核评论",
                TargetType: "comment",
                TargetId: string.Join(',', request.CommentIds),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = request.Status,
                    ["commentCount"] = request.CommentIds.Count,
                    ["updated"] = response.Updated,
                    ["bannedUsers"] = response.BannedUsers,
                    ["banUsers"] = request.BanUsers
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<CommentModerationBulkResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/{commentId:long}/moderation", async (
            long commentId,
            CommentModerationRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool moderated = await service.ModerateCommentAsync(context.User.GetUserId(), commentId, request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.CommentModerated,
                moderated ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                moderated ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员审核评论",
                TargetType: "comment",
                TargetId: commentId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = request.Status,
                    ["banUser"] = request.BanUser
                }), cancellationToken);
            return moderated
                ? Results.Ok(JsonApiResponse<object>.Ok(new { moderated }))
                : Results.NotFound(JsonApiResponse<object>.Fail("comment_not_found"));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/content/export", async (
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ContentBackupExportResponse response = await service.ExportContentBackupAsync(cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ContentExported,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员导出全量内容备份",
                TargetType: "content_backup",
                TargetId: response.FileName,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["articleCount"] = response.Articles.Count,
                    ["exportedAt"] = response.ExportedAt
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<ContentBackupExportResponse>.Ok(response));
        });

        group.MapGet("/articles/{articleId:int}/export", async (
            int articleId,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ContentExportResponse? exported = await service.ExportArticleAsync(articleId, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ArticleExported,
                exported is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                exported is null ? AuditSeverityCatalog.Error : AuditSeverityCatalog.Warning,
                "管理员导出文章内容",
                TargetType: "article",
                TargetId: articleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: exported is null
                    ? null
                    : new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["fileName"] = exported.FileName,
                        ["revisionCount"] = exported.Metadata.RevisionCount
                    }), cancellationToken);
            return exported is null
                ? Results.NotFound(JsonApiResponse<ContentExportResponse>.Fail("article_not_found"))
                : Results.Ok(JsonApiResponse<ContentExportResponse>.Ok(exported));
        });

        group.MapPost("/articles/import", async (
            ContentImportRequest request,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ContentImportResponse response = await service.ImportArticleAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ArticleImported,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员导入文章内容",
                TargetType: "article",
                TargetId: response.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["publish"] = request.Publish,
                    ["preserveRevisions"] = request.PreserveRevisions,
                    ["restoredRevisionCount"] = response.RestoredRevisionCount
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<ContentImportResponse>.Ok(response));
        });

        group.MapGet("/audit", async (
            int? page,
            int? pageSize,
            string? source,
            string? type,
            string? actor,
            string? action,
            string? targetType,
            string? targetId,
            string? outcome,
            string? severity,
            DateTime? fromUtc,
            DateTime? toUtc,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogQueryRequest query = BuildAuditLogQuery(page, pageSize, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc);
            AuditLogListResponse response = await auditQuery.ListAsync(query, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查询审计日志列表",
                TargetType: "audit_log",
                Context: BuildAuditQueryContext(query)), cancellationToken);
            return Results.Ok(JsonApiResponse<AuditLogListResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/summary", async (
            string? source,
            string? type,
            string? actor,
            string? action,
            string? targetType,
            string? targetId,
            string? outcome,
            string? severity,
            DateTime? fromUtc,
            DateTime? toUtc,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogQueryRequest query = BuildAuditLogQuery(1, 1, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc);
            AuditLogSummaryResponse response = await auditQuery.GetSummaryAsync(query, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查询审计日志汇总",
                TargetType: "audit_log_summary",
                Context: BuildAuditQueryContext(query)), cancellationToken);
            return Results.Ok(JsonApiResponse<AuditLogSummaryResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}", async (
            long id,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogDetailResponse? response = await auditQuery.GetAsync(id, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                response is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                response is null ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员查看审计日志详情",
                TargetType: "audit_log",
                TargetId: id.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return response is null
                ? Results.NotFound(JsonApiResponse<AuditLogDetailResponse>.Fail("audit_log_not_found"))
                : Results.Ok(JsonApiResponse<AuditLogDetailResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}/verify", async (
            long id,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditTamperVerifyResponse? response = await auditQuery.VerifyAsync(id, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                response is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                response?.Valid == true ? AuditSeverityCatalog.Info : AuditSeverityCatalog.Warning,
                "管理员校验审计日志防篡改证据",
                TargetType: "audit_log",
                TargetId: id.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return response is null
                ? Results.NotFound(JsonApiResponse<AuditTamperVerifyResponse>.Fail("audit_log_not_found"))
                : Results.Ok(JsonApiResponse<AuditTamperVerifyResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/health", async (
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            OpsHealthResponse response = await operations.GetOpsHealthAsync(cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.ops.health_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看生产运维健康面板",
                TargetType: "ops_health"), cancellationToken);
            return Results.Ok(JsonApiResponse<OpsHealthResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/backup", (
            AdminOperationsService operations) =>
            Results.Ok(JsonApiResponse<BackupStatusResponse>.Ok(operations.GetBackupStatus())))
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/dangerous-operations/policy", (
            AdminOperationsService operations) =>
            Results.Ok(JsonApiResponse<DangerousOperationPolicyResponse>.Ok(operations.GetDangerousOperationPolicy())))
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/cache/diagnostics", async (
            int? articleId,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            CacheDiagnosticsResponse response = await operations.GetCacheDiagnosticsAsync(articleId, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.cache.diagnostics_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看缓存/AOT/search/sitemap 诊断",
                TargetType: "cache_diagnostics",
                TargetId: articleId?.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return Results.Ok(JsonApiResponse<CacheDiagnosticsResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/cache/actions", async (
            AdminCacheActionRequest request,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AdminCacheActionResponse response = await operations.RunCacheActionAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.cache.action_executed",
                response.Status is "ok" or "queued" ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                response.Status is "ok" or "queued" ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员执行缓存/索引维护动作",
                TargetType: "cache_action",
                TargetId: response.Action,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["articleId"] = request.ArticleId,
                    ["status"] = response.Status,
                    ["detail"] = response.Detail
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<AdminCacheActionResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity", async (
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IntegrityReportResponse response = await operations.InspectIntegrityAsync(cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.integrity.checked",
                AuditOutcomeCatalog.Success,
                response.IssueCount > 0 ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员执行数据一致性巡检",
                TargetType: "integrity_report",
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["issueCount"] = response.IssueCount,
                    ["checkCount"] = response.CheckCount
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<IntegrityReportResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity/fix-preview", async (
            AdminOperationsService operations,
            CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IntegrityFixPreviewResponse>.Ok(await operations.PreviewIntegrityFixAsync(cancellationToken))))
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/integrity/fix", async (
            IntegrityFixRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            IntegrityFixResponse response = await operations.ApplyIntegrityFixAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.integrity.safe_fix_applied",
                response.Status == "applied" ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Denied,
                response.Status == "applied" ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员应用数据巡检安全修复",
                TargetType: "integrity_fix",
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = response.Status,
                    ["appliedCount"] = response.AppliedCount,
                    ["codes"] = request.Codes
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<IntegrityFixResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/ai-assist", (AiAssistRequest request, HttpContext context, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<AiAssistResponse>.Ok(service.GenerateAiAssist(context.User.GetUserId(), request))));

        return app;
    }

    private static AuditLogQueryRequest BuildAuditLogQuery(
        int? page,
        int? pageSize,
        string? source,
        string? type,
        string? actor,
        string? action,
        string? targetType,
        string? targetId,
        string? outcome,
        string? severity,
        DateTime? fromUtc,
        DateTime? toUtc)
        => new(
            page ?? 1,
            pageSize ?? 50,
            source,
            type,
            actor,
            action,
            targetType,
            targetId,
            outcome,
            severity,
            fromUtc,
            toUtc);

    private static IReadOnlyDictionary<string, object?> BuildAuditQueryContext(AuditLogQueryRequest query)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["page"] = query.Page,
            ["pageSize"] = query.PageSize,
            ["source"] = query.Source,
            ["type"] = query.Type,
            ["actor"] = query.Actor,
            ["action"] = query.Action,
            ["targetType"] = query.TargetType,
            ["targetId"] = query.TargetId,
            ["outcome"] = query.Outcome,
            ["severity"] = query.Severity,
            ["fromUtc"] = query.FromUtc,
            ["toUtc"] = query.ToUtc
        };

    private static async Task<IReadOnlyList<AdminCategoryItemResponse>> ListAdminCategoriesAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        List<TaxonomyNameRow> categories = await db.Queryable<Category>()
            .OrderBy(c => c.Id)
            .Select(c => new TaxonomyNameRow
            {
                Id = c.Id,
                Name = c.Name
            })
            .ToListAsync(cancellationToken);

        DateTime now = DateTime.UtcNow;
        List<TaxonomyCountRow> publicCounts = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy(a => a.CategoryId)
            .Select(a => new TaxonomyCountRow
            {
                Id = a.CategoryId,
                Count = SqlFunc.AggregateCount(a.Id)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyStatusCountRow> statusCounts = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted && a.Status != ArticleStatus.Deleted)
            .GroupBy(a => new { a.CategoryId, a.Status })
            .Select(a => new TaxonomyStatusCountRow
            {
                Id = a.CategoryId,
                Status = a.Status,
                Count = SqlFunc.AggregateCount(a.Id)
            })
            .ToListAsync(cancellationToken);

        Dictionary<int, int> publicById = publicCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, Dictionary<ArticleStatus, int>> statusById = BuildStatusCountLookup(statusCounts);

        return categories.Select(category =>
        {
            Dictionary<ArticleStatus, int> counts = GetStatusCounts(statusById, category.Id);
            int totalBlocking =
                CountStatus(counts, ArticleStatus.Draft)
                + CountStatus(counts, ArticleStatus.Scheduled)
                + CountStatus(counts, ArticleStatus.Published)
                + CountStatus(counts, ArticleStatus.Archived);

            return new AdminCategoryItemResponse(
                category.Id,
                category.Name ?? string.Empty,
                publicById.GetValueOrDefault(category.Id),
                CountStatus(counts, ArticleStatus.Draft),
                CountStatus(counts, ArticleStatus.Scheduled),
                CountStatus(counts, ArticleStatus.Archived),
                totalBlocking,
                totalBlocking == 0);
        }).ToList();
    }

    private static async Task<IReadOnlyList<AdminTagItemResponse>> ListAdminTagsAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        List<TaxonomyNameRow> tags = await db.Queryable<Tag>()
            .OrderBy(t => t.Id)
            .Select(t => new TaxonomyNameRow
            {
                Id = t.Id,
                Name = t.Name
            })
            .ToListAsync(cancellationToken);

        DateTime now = DateTime.UtcNow;
        List<TaxonomyCountRow> publicCounts = await db.Queryable<ArticleTag, Article>((at, a) => at.ArticleId == a.Id)
            .Where((at, a) => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy((at, a) => at.TagId)
            .Select((at, a) => new TaxonomyCountRow
            {
                Id = at.TagId,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyStatusCountRow> statusCounts = await db.Queryable<ArticleTag, Article>((at, a) => at.ArticleId == a.Id)
            .Where((at, a) => !a.IsDeleted)
            .GroupBy((at, a) => new { at.TagId, a.Status })
            .Select((at, a) => new TaxonomyStatusCountRow
            {
                Id = at.TagId,
                Status = a.Status,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyCountRow> associationCounts = await db.Queryable<ArticleTag>()
            .GroupBy(at => at.TagId)
            .Select(at => new TaxonomyCountRow
            {
                Id = at.TagId,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        Dictionary<int, int> publicById = publicCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, int> associationById = associationCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, Dictionary<ArticleStatus, int>> statusById = BuildStatusCountLookup(statusCounts);

        return tags.Select(tag =>
        {
            Dictionary<ArticleStatus, int> counts = GetStatusCounts(statusById, tag.Id);
            int totalBlocking = associationById.GetValueOrDefault(tag.Id);

            return new AdminTagItemResponse(
                tag.Id,
                tag.Name ?? string.Empty,
                publicById.GetValueOrDefault(tag.Id),
                CountStatus(counts, ArticleStatus.Draft),
                CountStatus(counts, ArticleStatus.Scheduled),
                CountStatus(counts, ArticleStatus.Archived),
                CountStatus(counts, ArticleStatus.Deleted),
                totalBlocking,
                totalBlocking == 0);
        }).ToList();
    }

    private static Dictionary<int, Dictionary<ArticleStatus, int>> BuildStatusCountLookup(IEnumerable<TaxonomyStatusCountRow> rows)
    {
        var lookup = new Dictionary<int, Dictionary<ArticleStatus, int>>();
        foreach (TaxonomyStatusCountRow row in rows)
        {
            if (!lookup.TryGetValue(row.Id, out Dictionary<ArticleStatus, int>? statusCounts))
            {
                statusCounts = [];
                lookup[row.Id] = statusCounts;
            }

            statusCounts[row.Status] = row.Count;
        }

        return lookup;
    }

    private static Dictionary<ArticleStatus, int> GetStatusCounts(Dictionary<int, Dictionary<ArticleStatus, int>> lookup, int id)
        => lookup.TryGetValue(id, out Dictionary<ArticleStatus, int>? counts) ? counts : [];

    private static int CountStatus(Dictionary<ArticleStatus, int> counts, ArticleStatus status)
        => counts.GetValueOrDefault(status);

    private static bool TryResolveModerationStatus(int? raw, out CommentModerationStatus? status)
    {
        status = null;
        if (raw is null)
        {
            return true;
        }

        CommentModerationStatus resolved = (CommentModerationStatus)raw.Value;
        if (!IsValidModerationStatus(resolved))
        {
            return false;
        }

        status = resolved;
        return true;
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(HttpContext context, IMfaChallengeService mfaChallengeService)
    {
        int userId = context.User.GetUserId();
        if (userId <= 0)
        {
            return Results.Unauthorized();
        }

        if (!context.User.IsMfaVerified())
        {
            return Results.Json(
                JsonApiResponse<object>.Fail("MFA_REQUIRED"),
                statusCode: StatusCodes.Status403Forbidden);
        }

        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, AdminSensitiveAction, proofToken))
        {
            return Results.Json(
                JsonApiResponse<object>.Fail("MFA_PROOF_REQUIRED"),
                statusCode: StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

    private static bool IsValidModerationStatus(CommentModerationStatus status)
        => status is CommentModerationStatus.Pending
            or CommentModerationStatus.Approved
            or CommentModerationStatus.Rejected
            or CommentModerationStatus.Hidden;

    private sealed record TaxonomyNameRow
    {
        public int Id { get; init; }
        public string? Name { get; init; }
    }

    private sealed record TaxonomyCountRow
    {
        public int Id { get; init; }
        public int Count { get; init; }
    }

    private sealed record TaxonomyStatusCountRow
    {
        public int Id { get; init; }
        public ArticleStatus Status { get; init; }
        public int Count { get; init; }
    }
}
