using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";
    private const string BinaryPrefix = "/api/binary/author";
    private const int MaxAuthoringRequestBytes = 1 * 1024 * 1024;
    private static readonly string[] s_mainlandMandatoryDictionaryIds =
    [
        "cn-mainland.political-sensitive",
        "cn-mainland.porn-strict",
        "cn-mainland.public-order",
        "cn-mainland.national-security"
    ];

    public static IEndpointRouteBuilder MapAuthoringEndpoints(this IEndpointRouteBuilder app)
    {
        IEndpointRouteBuilder group = app.MapGroup(BinaryPrefix)
            .WithTags("Authoring");

        MapAuthoringWorkflowRoutes(group);
        MapAuthoringModerationRoutes(group);
        MapAuthoringOperationsRoutes(group);
        AuthoringCanvasEndpoints.MapAuthoringCanvasRoutes(group);
        MapArticleCanvasLinkRoutes(group);
        MapArticlePropertyValueRoutes(group);
        MapWorkspaceSnapshotRoutes(group);
        MapArticleSelectionRoutes(group);
        return app;
    }

    private static Task RecordEffectivePolicyPreviewAuditAsync(
        ModerationEffectivePolicyPreview preview,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
        => auditEvents.RecordAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            "admin.moderation.effective_policy_previewed",
            AuditOutcomeCatalog.Success,
            preview.Warnings.Count > 0 ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
            "管理员预览地区 effective policy",
            TargetType: "moderation_effective_policy",
            TargetId: preview.Region,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["region"] = preview.Region,
                ["inheritance"] = preview.Inheritance.Select(static item => item.SourceId).ToArray(),
                ["ruleCount"] = preview.Rules.Count,
                ["checksum"] = preview.Checksum,
                ["warnings"] = preview.Warnings
            }), cancellationToken);

    private static IResult Ok(HttpContext context, IAedsEncoder aeds, object? value)
    {
        if (!TryResolveRoute(context.Request.Method, ResolveRemainingPath(context), out AuthoringAedsRoute route))
        {
            return AedsJsonResults.NotFound(aeds, "authoring_binary_route_not_found");
        }

        return value is null
            ? AedsJsonResults.OkNull(aeds, route.ResponseFrame)
            : AedsJsonResults.Ok(aeds, route.ResponseFrame, value);
    }

    private static async Task<AedsJsonRequest<T>> ReadRequestAsync<T>(
        HttpContext context,
        IAedsEncoder aeds,
        string invalidMessage,
        CancellationToken cancellationToken)
    {
        if (!TryResolveRoute(context.Request.Method, ResolveRemainingPath(context), out AuthoringAedsRoute route)
            || route.RequestFrame is null)
        {
            return AedsJsonRequest<T>.Failure(ErrorDetail.Create(FsusBlog.Core.Common.ErrorCode.Validation, "authoring_binary_body_not_allowed"));
        }

        if (context.Request.ContentLength > MaxAuthoringRequestBytes)
        {
            return AedsJsonRequest<T>.Failure(ErrorDetail.Create(FsusBlog.Core.Common.ErrorCode.Validation, "authoring_binary_body_too_large"));
        }

        return await AedsJsonResults.ReadAsync<T>(
            context,
            aeds,
            route.RequestFrame.Value,
            MaxAuthoringRequestBytes,
            invalidMessage,
            cancellationToken);
    }

    private static PathString ResolveRemainingPath(HttpContext context)
        => context.Request.Path.StartsWithSegments(BinaryPrefix, StringComparison.OrdinalIgnoreCase, out PathString remaining)
            ? remaining
            : context.Request.Path;

    internal static bool TryResolveRoute(string method, PathString remaining, out AuthoringAedsRoute route)
    {
        string[] segments = (remaining.Value ?? string.Empty).Split('/', StringSplitOptions.RemoveEmptyEntries);
        route = default;

        if (HttpMethods.IsPost(method) && segments is ["drafts"])
            return Found(AedsFrameType.AuthorDraftSaveRequest, AedsFrameType.AuthorDraftResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["drafts", _])
            return Found(null, AedsFrameType.AuthorDraftResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["drafts", _])
            return Found(null, AedsFrameType.AuthorDraftDiscardResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["preview"])
            return Found(AedsFrameType.ArticlePreviewRequest, AedsFrameType.ArticlePreviewResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["prepublish-check"])
            return Found(AedsFrameType.PrepublishCheckRequest, AedsFrameType.PrepublishCheckResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["ai-assist"])
            return Found(AedsFrameType.AiAssistRequest, AedsFrameType.AiAssistResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["assets"])
            return Found(null, AedsFrameType.AssetLibraryList, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", _, "assets", "reindex"])
            return Found(null, AedsFrameType.AssetLibraryList, out route);
        if (HttpMethods.IsDelete(method) && segments is ["assets", "orphans"])
            return Found(null, AedsFrameType.AssetCleanupResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["taxonomy", "categories"])
            return Found(null, AedsFrameType.AuthorTaxonomyCategoryList, out route);
        if (HttpMethods.IsGet(method) && segments is ["taxonomy", "tags"])
            return Found(null, AedsFrameType.AuthorTaxonomyTagList, out route);
        if (HttpMethods.IsGet(method) && segments is ["analytics"])
            return Found(null, AedsFrameType.AuthorAnalytics, out route);

        if (HttpMethods.IsGet(method) && segments is ["articles", _, "revisions"])
            return Found(null, AedsFrameType.ArticleRevisionList, out route);
        if (HttpMethods.IsGet(method) && segments is ["articles", _, "revisions", _])
            return Found(null, AedsFrameType.ArticleRevisionDetail, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", _, "revisions", _, "rollback"])
            return Found(AedsFrameType.ArticleRevisionRollbackRequest, AedsFrameType.MutationId, out route);
        if (HttpMethods.IsPut(method) && segments is ["articles", _, "revisions", _, "responsibility"])
            return Found(AedsFrameType.ArticleResponsibilityRequest, AedsFrameType.ArticleResponsibilityResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["articles", _, "revisions", _, "responsibility"])
            return Found(null, AedsFrameType.ArticleResponsibilityHistory, out route);

        if (HttpMethods.IsGet(method) && segments is ["moderation", "overview"])
            return Found(null, AedsFrameType.ModerationOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "anonymous-comment-policy"])
            return Found(null, AedsFrameType.CommentPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["moderation", "anonymous-comment-policy"])
            return Found(AedsFrameType.CommentPolicyUpdateRequest, AedsFrameType.CommentPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "articles", _, "comment-policy"])
            return Found(null, AedsFrameType.CommentPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["moderation", "articles", _, "comment-policy"])
            return Found(AedsFrameType.CommentPolicyUpdateRequest, AedsFrameType.CommentPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["moderation", "articles", _, "comment-threads", _])
            return Found(AedsFrameType.CommentPolicyUpdateRequest, AedsFrameType.CommentPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "dictionaries"])
            return Found(null, AedsFrameType.ModerationDictionarySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", "reload"])
            return Found(null, AedsFrameType.ModerationDictionaryReloadResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", "rollback"])
            return Found(null, AedsFrameType.ModerationDictionarySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", _, "enable"])
            return Found(AedsFrameType.ModerationDictionaryStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", _, "disable"])
            return Found(AedsFrameType.ModerationDictionaryStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "runtime", "status"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "runtime", "global-state"])
            return Found(AedsFrameType.ModerationRuntimeGlobalStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "runtime", "region-state"])
            return Found(AedsFrameType.ModerationRuntimeRegionStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "regions"])
            return Found(null, AedsFrameType.ModerationRegionList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "region-groups"])
            return Found(null, AedsFrameType.ModerationRegionGroupList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "policy-templates"])
            return Found(null, AedsFrameType.ModerationPolicyTemplateList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "effective-policy", _])
            return Found(null, AedsFrameType.ModerationEffectivePolicy, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "effective-policy", "preview"])
            return Found(AedsFrameType.ModerationEffectivePolicyPreviewRequest, AedsFrameType.ModerationEffectivePolicy, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "policies"])
            return Found(null, AedsFrameType.RegionPolicySummaryList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "model", "status"])
            return Found(null, AedsFrameType.ModerationModelStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "runtime"])
            return Found(AedsFrameType.ModerationModelRuntimeRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "reload"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "rollback"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "replay", "preview"])
            return Found(AedsFrameType.ModerationReplayPreviewRequest, AedsFrameType.ModerationReplayPreview, out route);

        if (HttpMethods.IsGet(method) && segments is ["comments", "moderation"])
            return Found(null, AedsFrameType.CommentModerationQueue, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", "moderation", "bulk"])
            return Found(AedsFrameType.CommentModerationBulkRequest, AedsFrameType.CommentModerationBulkResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", _, "moderation", "claim"])
            return Found(AedsFrameType.CommentModerationClaimRequest, AedsFrameType.CommentModerationClaimResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", _, "moderation", "claim", ("renew" or "release")])
            return Found(AedsFrameType.CommentModerationClaimMutationRequest, AedsFrameType.CommentModerationClaimResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", "moderation", "nullifiers", "block"])
            return Found(AedsFrameType.AnonymousGovernanceActionRequest, AedsFrameType.AnonymousGovernanceActionResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", "moderation", "anonymous-credentials", _, "revoke"])
            return Found(AedsFrameType.AnonymousGovernanceActionRequest, AedsFrameType.AnonymousGovernanceActionResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", _, "moderation"])
            return Found(AedsFrameType.CommentModerationRequest, AedsFrameType.CommentModerationResult, out route);
        if (HttpMethods.IsGet(method) && segments is ["comments", _, "revisions"])
            return Found(null, AedsFrameType.CommentRevisionList, out route);
        if (HttpMethods.IsGet(method) && segments is ["comments", _, "moderation-timeline"])
            return Found(null, AedsFrameType.CommentModerationTimeline, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "appeals", _, "decision"])
            return Found(AedsFrameType.CommentAppealDecisionRequest, AedsFrameType.CommentAppealDecisionResult, out route);

        if (HttpMethods.IsGet(method) && segments is ["content", "export"])
            return Found(null, AedsFrameType.ContentBackupExport, out route);
        if (HttpMethods.IsGet(method) && segments is ["articles", _, "export"])
            return Found(null, AedsFrameType.ContentExport, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", "import"])
            return Found(AedsFrameType.ContentImportRequest, AedsFrameType.ContentImportResponse, out route);

        if (HttpMethods.IsGet(method) && segments is ["audit"])
            return Found(null, AedsFrameType.AuditLogList, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", "summary"])
            return Found(null, AedsFrameType.AuditLogSummary, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", _, "verify"])
            return Found(null, AedsFrameType.AuditTamperVerifyResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", _])
            return Found(null, AedsFrameType.AuditLogDetail, out route);

        if (HttpMethods.IsGet(method) && segments is ["ops", "health"])
            return Found(null, AedsFrameType.OpsHealth, out route);
        if (HttpMethods.IsGet(method) && segments is ["ops", "backup"])
            return Found(null, AedsFrameType.BackupStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["ops", "dangerous-operations", "policy"])
            return Found(null, AedsFrameType.DangerousOperationPolicy, out route);
        if (HttpMethods.IsGet(method) && segments is ["cache", "diagnostics"])
            return Found(null, AedsFrameType.CacheDiagnostics, out route);
        if (HttpMethods.IsPost(method) && segments is ["cache", "actions"])
            return Found(AedsFrameType.AdminCacheActionRequest, AedsFrameType.AdminCacheActionResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["integrity"])
            return Found(null, AedsFrameType.IntegrityReport, out route);
        if (HttpMethods.IsGet(method) && segments is ["integrity", "fix-preview"])
            return Found(null, AedsFrameType.IntegrityFixPreview, out route);
        if (HttpMethods.IsPost(method) && segments is ["integrity", "fix"])
            return Found(AedsFrameType.IntegrityFixRequest, AedsFrameType.IntegrityFixResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["plugins"])
            return Found(null, AedsFrameType.PluginAdminSnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["plugins", _])
            return Found(null, AedsFrameType.PluginAdminSnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["plugins", "install"])
            return Found(AedsFrameType.PluginPackageInstallRequest, AedsFrameType.PluginAdminSnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["plugins", _, "actions"])
            return Found(AedsFrameType.PluginAdminMutationRequest, AedsFrameType.PluginAdminSnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["ops", "cluster", "nodes"])
            return Found(null, AedsFrameType.ClusterRuntimeSnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["ops", "cluster", "nodes", _, "state"])
            return Found(AedsFrameType.ClusterNodeStateRequest, AedsFrameType.ClusterRuntimeSnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["ops", "cluster", "scheduler"])
            return Found(AedsFrameType.ClusterSchedulerStateRequest, AedsFrameType.ClusterRuntimeSnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["ops", "cluster", "leases", _, "release-expired"])
            return Found(AedsFrameType.ClusterLeaseReleaseRequest, AedsFrameType.ClusterRuntimeSnapshot, out route);

        return false;
    }

    private static bool Found(AedsFrameType? requestFrame, AedsFrameType responseFrame, out AuthoringAedsRoute route)
    {
        route = new AuthoringAedsRoute(requestFrame, responseFrame);
        return true;
    }

    internal readonly record struct AuthoringAedsRoute(AedsFrameType? RequestFrame, AedsFrameType ResponseFrame);

    private static async Task<IResult> CompleteModerationRuntimeMutationAsync(
        Result<ModerationRuntimeSnapshot> result,
        IAuditEventService auditEvents,
        ICacheInvalidationDispatcher? cacheInvalidation,
        string action,
        string eventInfo,
        string targetType,
        string targetId,
        string? reasonCode,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        await auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            result.IsSuccess ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
            result.IsSuccess ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
            eventInfo,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: result.IsSuccess ? reasonCode : result.Error.Message,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["targetType"] = targetType,
                ["targetId"] = targetId,
                ["reason"] = reasonCode,
                ["errorCode"] = result.IsSuccess ? null : result.Error.Code.ToString(),
                ["error"] = result.IsSuccess ? null : result.Error.Message,
                ["snapshotId"] = result.IsSuccess ? result.Value!.SnapshotId : null,
                ["globalState"] = result.IsSuccess ? result.Value!.GlobalState : null,
                ["regionStateCount"] = result.IsSuccess ? result.Value!.RegionStates.Count : null,
                ["disabledDictionaryCount"] = result.IsSuccess ? result.Value!.DisabledDictionaryIds.Count : null,
                ["modelProvider"] = result.IsSuccess ? result.Value!.Model.Provider : null,
                ["modelEnabled"] = result.IsSuccess ? result.Value!.Model.Enabled : null
            }), cancellationToken);

        if (result.IsFailure)
        {
            return AedsJsonResults.Error(aeds, ApiErrorSemanticMapper.GetDefaultMappingId(result.Error.Code), result.Error.Message);
        }

        if (cacheInvalidation is not null)
        {
            await cacheInvalidation.InvalidateCommentMutationAsync(null, cancellationToken);
        }

        return AedsJsonResults.Ok(aeds, AedsFrameType.ModerationRuntimeStatus, ToModerationRuntimeStatusResponse(result.Value!));
    }

    private static ModerationRuntimeStatusResponse ToModerationRuntimeStatusResponse(ModerationRuntimeSnapshot snapshot)
        => new(
            snapshot.SnapshotId,
            snapshot.GlobalState,
            new Dictionary<string, string>(snapshot.RegionStates, StringComparer.Ordinal),
            snapshot.DisabledDictionaryIds.OrderBy(static item => item, StringComparer.Ordinal).ToArray(),
            ToModerationModelRuntimeResponse(snapshot.Model),
            snapshot.ChangedAtUtc,
            snapshot.ChangedBy,
            snapshot.Reason,
            snapshot.ExpiresAtUtc,
            snapshot.LastError);

    private static ModerationModelRuntimeResponse ToModerationModelRuntimeResponse(ModerationModelRuntimeSnapshot model)
        => new(
            model.SnapshotId,
            model.Enabled,
            model.Provider,
            model.ModelProfile,
            model.ThresholdProfile,
            model.ContractVersion,
            model.ConfigChecksum,
            model.LoadedAtUtc,
            model.LoadedBy,
            model.Status,
            model.TimeoutMs,
            model.FailOpen,
            model.RuntimePath,
            model.RuntimeChannel,
            model.LastError);

    private static int ToHttpStatusCode(ErrorCode code)
        => code switch
        {
            ErrorCode.Validation => StatusCodes.Status400BadRequest,
            ErrorCode.Unauthorized => StatusCodes.Status401Unauthorized,
            ErrorCode.Forbidden => StatusCodes.Status403Forbidden,
            ErrorCode.NotFound => StatusCodes.Status404NotFound,
            ErrorCode.Conflict => StatusCodes.Status409Conflict,
            ErrorCode.InfraFailure => StatusCodes.Status500InternalServerError,
            _ => StatusCodes.Status500InternalServerError
        };

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
        DateTime? toUtc,
        string? cursor)
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
            toUtc,
            cursor);

    private static IReadOnlyDictionary<string, object?> BuildAuditQueryContext(
        AuditLogQueryRequest query,
        AuditDisclosureMode disclosureMode = AuditDisclosureMode.PiiRedacted,
        string? requestedPiiMode = null,
        HttpContext? context = null,
        string? investigationPurpose = null)
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
            ["toUtc"] = query.ToUtc,
            ["cursor"] = query.Cursor,
            ["piiMode"] = FormatAuditDisclosureMode(disclosureMode),
            ["requestedPiiMode"] = NormalizePiiMode(requestedPiiMode),
            ["sensitiveFieldsRead"] = disclosureMode == AuditDisclosureMode.Investigation,
            ["hasAuditInvestigationPermission"] = context is not null && HasAuditInvestigationPermission(context)
            ,
            ["investigationPurpose"] = disclosureMode == AuditDisclosureMode.Investigation
                ? investigationPurpose?.Trim()
                : null
        };

    private static IReadOnlyDictionary<string, object?> BuildAuditDisclosureContext(
        AuditDisclosureMode disclosureMode,
        string? requestedPiiMode,
        HttpContext context,
        string? investigationPurpose = null)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["piiMode"] = FormatAuditDisclosureMode(disclosureMode),
            ["requestedPiiMode"] = NormalizePiiMode(requestedPiiMode),
            ["sensitiveFieldsRead"] = disclosureMode == AuditDisclosureMode.Investigation,
            ["hasAuditInvestigationPermission"] = HasAuditInvestigationPermission(context),
            ["investigationPurpose"] = disclosureMode == AuditDisclosureMode.Investigation
                ? investigationPurpose?.Trim()
                : null
        };

    internal static AuditDisclosureMode ResolveAuditDisclosureMode(HttpContext context, string? piiMode)
        => string.Equals(NormalizePiiMode(piiMode), "investigation", StringComparison.Ordinal)
           && HasAuditInvestigationPermission(context)
            ? AuditDisclosureMode.Investigation
            : AuditDisclosureMode.PiiRedacted;

    private static bool HasAuditInvestigationPermission(HttpContext context)
        => context.User.HasClaim(AdminPermissions.PermissionClaimType, AdminPermissions.AuditInvestigate);

    private static string NormalizePiiMode(string? piiMode)
        => TextHelpers.LowerTrimmed(piiMode) ?? "pii-redacted";

    private static string FormatAuditDisclosureMode(AuditDisclosureMode disclosureMode)
        => disclosureMode == AuditDisclosureMode.Investigation ? "investigation" : "pii-redacted";

    private static Task RecordAuditQueryAsync(
        IAuditEventService auditEvents,
        AuditEvent auditEvent,
        AuditDisclosureMode disclosureMode,
        CancellationToken cancellationToken)
        => disclosureMode == AuditDisclosureMode.Investigation
            ? auditEvents.RecordHighValueAsync(
                auditEvent with
                {
                    IsHighValue = true,
                    Severity = AuditSeverityCatalog.Warning
                },
                cancellationToken)
            : auditEvents.RecordAsync(auditEvent, cancellationToken);

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

    private static string ResolveMainlandStrictStatus(ModerationDictionaryRuntimeSnapshot snapshot)
    {
        ModerationRegionPolicyRuntimeItem? policy = snapshot.RegionPolicies
            .FirstOrDefault(static item => string.Equals(item.Region, RegionCodes.MainlandChina, StringComparison.Ordinal));
        if (policy is null)
        {
            return "disabled";
        }

        return BuildRegionPolicyChecks(policy).All(static item => item.Status == "ok")
            ? "enabled"
            : "invalid";
    }

    private static string NormalizeModerationProvider(string? provider)
    {
        string value = string.IsNullOrWhiteSpace(provider) ? "none" : provider.Trim();
        return value.ToLowerInvariant() switch
        {
            "disabled" or "off" => "none",
            "builtin" or "built-in" or "fsus-antispammodel" => AntiSpamModerationProviders.BuiltIn,
            _ => value
        };
    }

    private static int ResolveP95Latency(IReadOnlyList<int> latencies)
    {
        if (latencies.Count == 0)
        {
            return 0;
        }

        int[] sorted = [.. latencies.Order()];
        int index = Math.Clamp((int)Math.Ceiling(sorted.Length * 0.95d) - 1, 0, sorted.Length - 1);
        return sorted[index];
    }

    private static IReadOnlyList<RegionPolicyCheckResponse> BuildRegionPolicyChecks(ModerationRegionPolicyRuntimeItem policy)
    {
        if (!string.Equals(policy.Region, RegionCodes.MainlandChina, StringComparison.Ordinal))
        {
            return
            [
                BuildPolicyCheck(
                    "policy-version",
                    "Policy version",
                    !string.IsNullOrWhiteSpace(policy.Version),
                    policy.Version,
                    "policy version missing"),
                BuildPolicyCheck(
                    "dictionary-set",
                    "Dictionaries",
                    policy.DictionaryIds.Count > 0,
                    $"{policy.DictionaryIds.Count} dictionaries loaded",
                    "no dictionaries linked",
                    "warning"),
                BuildPolicyCheck(
                    "rule-set",
                    "Rules",
                    policy.RuleCount > 0,
                    $"{policy.RuleCount} rules loaded",
                    "no rules loaded",
                    "warning")
            ];
        }

        var checks = new List<RegionPolicyCheckResponse>
        {
            BuildPolicyCheck(
                "inherits-global",
                "继承 GLOBAL",
                policy.Inherits.Contains(RegionCodes.Global, StringComparer.Ordinal),
                "CN-MAINLAND policy inherits GLOBAL",
                "CN-MAINLAND policy does not inherit GLOBAL")
        };

        foreach (string dictionaryId in s_mainlandMandatoryDictionaryIds)
        {
            checks.Add(BuildPolicyCheck(
                $"dictionary:{dictionaryId}",
                dictionaryId,
                policy.DictionaryIds.Contains(dictionaryId, StringComparer.Ordinal),
                "mandatory dictionary loaded",
                "mandatory dictionary missing"));
        }

        checks.Add(BuildPolicyCheck(
            "political-sensitive-submit",
            "political_sensitive submit action",
            HasPolicyRule(policy, ModerationRiskCategories.PoliticalSensitive, ModerationDictionaryActions.RejectSubmit, null),
            "reject_submit",
            "political_sensitive submit action must be reject_submit"));
        checks.Add(BuildPolicyCheck(
            "political-sensitive-display",
            "political_sensitive display action",
            HasPolicyRule(policy, ModerationRiskCategories.PoliticalSensitive, null, ModerationDictionaryActions.GeoBlock),
            "geo_block",
            "political_sensitive display action must be geo_block"));
        checks.Add(BuildPolicyCheck(
            "pornographic-submit",
            "pornographic submit action",
            HasPolicyRule(policy, ModerationRiskCategories.Pornographic, ModerationDictionaryActions.RejectSubmit, null),
            "reject_submit",
            "pornographic submit action must be reject_submit"));
        checks.Add(BuildPolicyCheck(
            "pornographic-display",
            "pornographic display action",
            HasPolicyRule(policy, ModerationRiskCategories.Pornographic, null, ModerationDictionaryActions.GeoBlock),
            "geo_block",
            "pornographic display action must be geo_block"));
        checks.Add(BuildPolicyCheck(
            "policy-version",
            "policy version",
            !string.IsNullOrWhiteSpace(policy.Version),
            policy.Version,
            "policy version missing"));

        return checks;
    }

    private static bool HasPolicyRule(
        ModerationRegionPolicyRuntimeItem policy,
        string category,
        string? submitAction,
        string? displayAction)
        => policy.Rules.Any(rule =>
            string.Equals(rule.Category, category, StringComparison.Ordinal)
            && (submitAction is null || string.Equals(rule.SubmitAction, submitAction, StringComparison.Ordinal))
            && (displayAction is null || string.Equals(rule.DisplayAction, displayAction, StringComparison.Ordinal)));

    private static RegionPolicyCheckResponse BuildPolicyCheck(
        string code,
        string label,
        bool ok,
        string okDetail,
        string failedDetail,
        string failedStatus = "error")
        => new(code, label, ok ? "ok" : failedStatus, ok ? okDetail : failedDetail);

    private static async Task<ModerationReplayPreviewResponse> BuildModerationReplayPreviewAsync(
        ModerationReplayPreviewRequest request,
        ISqlSugarClient db,
        IRegionLegalModerationService regionLegalModerationService,
        CancellationToken cancellationToken)
    {
        int limit = Math.Clamp(request.Limit ?? 50, 1, 200);
        string? region = string.IsNullOrWhiteSpace(request.Region)
            ? null
            : regionLegalModerationService.NormalizeRegion(request.Region);
        string? policyVersion = string.IsNullOrWhiteSpace(request.PolicyVersion)
            ? null
            : request.PolicyVersion.Trim();
        string? dictionaryId = string.IsNullOrWhiteSpace(request.DictionaryId)
            ? null
            : request.DictionaryId.Trim();

        var query = db.Queryable<Comment, CommentRegionCompliance>((comment, compliance) => comment.Id == compliance.CommentId)
            .Where((comment, compliance) => !comment.IsDeleted);
        if (region is not null)
        {
            query = query.Where((comment, compliance) => compliance.SubmitRegion == region);
        }

        if (policyVersion is not null)
        {
            query = query.Where((comment, compliance) => compliance.PolicyVersion == policyVersion);
        }

        List<ModerationReplaySourceRow> rows = await query
            .OrderBy((comment, compliance) => compliance.UpdatedAtUtc, OrderByType.Desc)
            .Take(limit)
            .Select((comment, compliance) => new ModerationReplaySourceRow
            {
                CommentId = comment.Id,
                ArticleId = comment.ArticleId,
                UserId = comment.UserId,
                Content = comment.Content,
                SubmitRegion = compliance.SubmitRegion,
                SubmitRegionConfidence = compliance.SubmitRegionConfidence,
                RegionProvider = compliance.RegionProvider,
                SubmitIpHash = compliance.SubmitIpHash,
                PolicyVersion = compliance.PolicyVersion,
                CanPublish = compliance.CanPublish,
                RequiresManualReview = compliance.RequiresManualReview,
                HideUntilReviewed = compliance.HideUntilReviewed,
                BlockedRegions = compliance.BlockedRegions,
                RiskLabels = compliance.RiskLabels,
                DecisionReason = compliance.DecisionReason,
                RuleHitsJson = compliance.RuleHitsJson,
                CreatedAtUtc = compliance.CreatedAtUtc,
                UpdatedAtUtc = compliance.UpdatedAtUtc
            })
            .ToListAsync(cancellationToken);

        var items = new List<ModerationReplayPreviewItemResponse>(rows.Count);
        foreach (ModerationReplaySourceRow row in rows)
        {
            var current = new CommentRegionCompliance
            {
                CommentId = row.CommentId,
                SubmitRegion = row.SubmitRegion,
                SubmitRegionConfidence = row.SubmitRegionConfidence,
                RegionProvider = row.RegionProvider,
                SubmitIpHash = row.SubmitIpHash,
                PolicyVersion = row.PolicyVersion,
                CanPublish = row.CanPublish,
                RequiresManualReview = row.RequiresManualReview,
                HideUntilReviewed = row.HideUntilReviewed,
                BlockedRegions = row.BlockedRegions,
                RiskLabels = row.RiskLabels,
                DecisionReason = row.DecisionReason,
                RuleHitsJson = row.RuleHitsJson,
                CreatedAtUtc = row.CreatedAtUtc,
                UpdatedAtUtc = row.UpdatedAtUtc
            };
            RegionModerationDecision nextDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
                row.Content,
                row.ArticleId,
                row.UserId ?? 0,
                row.SubmitRegion,
                row.SubmitRegionConfidence,
                row.RegionProvider,
                row.SubmitIpHash,
                null,
                row.CreatedAtUtc == default ? DateTime.UtcNow : row.CreatedAtUtc));
            RegionPolicyReplayDiff diff = regionLegalModerationService.PreviewReplay(current, nextDecision);
            if (!HasReplayChange(diff))
            {
                continue;
            }

            items.Add(new ModerationReplayPreviewItemResponse(
                diff.CommentId,
                diff.PreviousPolicyVersion,
                diff.NextPolicyVersion,
                diff.AddedBlockedRegions,
                diff.RemovedBlockedRegions,
                diff.AddedRiskLabels,
                diff.RemovedRiskLabels,
                diff.PublishabilityChanged,
                diff.ManualReviewChanged,
                diff.PublicVisibilityChanged));
        }

        return new ModerationReplayPreviewResponse(
            region,
            policyVersion,
            dictionaryId,
            rows.Count,
            items.Count,
            items.Sum(static item => item.AddedBlockedRegions.Count),
            items.Sum(static item => item.RemovedBlockedRegions.Count),
            items.Sum(static item => item.AddedRiskLabels.Count),
            items.Sum(static item => item.RemovedRiskLabels.Count),
            items.Count(static item => item.PublishabilityChanged),
            items.Count(static item => item.ManualReviewChanged),
            items.Count(static item => item.PublicVisibilityChanged),
            items.Count(IsHighRiskReplayChange),
            items);
    }

    private static bool HasReplayChange(RegionPolicyReplayDiff diff)
        => diff.AddedBlockedRegions.Count > 0
            || diff.RemovedBlockedRegions.Count > 0
            || diff.AddedRiskLabels.Count > 0
            || diff.RemovedRiskLabels.Count > 0
            || diff.PublishabilityChanged
            || diff.ManualReviewChanged
            || diff.PublicVisibilityChanged;

    private static bool IsHighRiskReplayChange(ModerationReplayPreviewItemResponse item)
        => item.PublicVisibilityChanged
            || item.PublishabilityChanged
            || item.AddedBlockedRegions.Contains(RegionCodes.MainlandChina, StringComparer.Ordinal)
            || item.RemovedBlockedRegions.Contains(RegionCodes.MainlandChina, StringComparer.Ordinal)
            || item.AddedRiskLabels.Concat(item.RemovedRiskLabels).Any(static label =>
                label.Contains("political", StringComparison.OrdinalIgnoreCase)
                || label.Contains("porn", StringComparison.OrdinalIgnoreCase)
                || label.Contains("national_security", StringComparison.OrdinalIgnoreCase)
                || label.Contains("public_order", StringComparison.OrdinalIgnoreCase));

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

    private static long ResolveRequiredAdminPrincipalId(HttpContext context)
        => context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ? adminPrincipalId : 0;

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(
        HttpContext context,
        IAdminPrincipalService adminPrincipals,
        IAedsEncoder aeds)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
            string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return AedsJsonResults.Unauthorized(aeds);
        }

        string adminSessionId = context.User.GetAdminSessionId()!;
        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(context))
        {
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default403Forbidden, "ORIGIN_NOT_ALLOWED");
        }

        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                adminPrincipalId,
                adminSessionId,
                AdminSensitiveAction,
                proofToken,
                context.RequestAborted))
        {
            return AedsJsonResults.PreconditionRequired(aeds, "MFA_PROOF_REQUIRED");
        }

        return null;
    }

    private static string HashAuditTargetId(string kind, string value)
    {
        string normalized = $"{kind}:{value.Trim()}";
        string hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
        return $"{kind}:sha256:{hash}";
    }

    private static bool IsValidModerationStatus(CommentModerationStatus status)
        => status is CommentModerationStatus.Pending
            or CommentModerationStatus.Approved
            or CommentModerationStatus.Rejected
            or CommentModerationStatus.Hidden;

    private sealed record TaxonomyNameRow
    {
        public int Id
        {
            get; init;
        }
        public string? Name
        {
            get; init;
        }
    }

    private sealed record TaxonomyCountRow
    {
        public int Id
        {
            get; init;
        }
        public int Count
        {
            get; init;
        }
    }

    private sealed record TaxonomyStatusCountRow
    {
        public int Id
        {
            get; init;
        }
        public ArticleStatus Status
        {
            get; init;
        }
        public int Count
        {
            get; init;
        }
    }

    private sealed record ModerationReplaySourceRow
    {
        public long CommentId
        {
            get; init;
        }
        public int ArticleId
        {
            get; init;
        }
        public int? UserId
        {
            get; init;
        }
        public string Content { get; init; } = string.Empty;
        public string SubmitRegion { get; init; } = RegionCodes.Unknown;
        public double SubmitRegionConfidence
        {
            get; init;
        }
        public string RegionProvider { get; init; } = "unknown";
        public string? SubmitIpHash
        {
            get; init;
        }
        public string PolicyVersion { get; init; } = string.Empty;
        public bool CanPublish
        {
            get; init;
        }
        public bool RequiresManualReview
        {
            get; init;
        }
        public bool HideUntilReviewed
        {
            get; init;
        }
        public string BlockedRegions { get; init; } = string.Empty;
        public string RiskLabels { get; init; } = string.Empty;
        public string? DecisionReason
        {
            get; init;
        }
        public string? RuleHitsJson
        {
            get; init;
        }
        public DateTime CreatedAtUtc
        {
            get; init;
        }
        public DateTime UpdatedAtUtc
        {
            get; init;
        }
    }

    private sealed record ModerationModelErrorRow
    {
        public string? ErrorCode
        {
            get; init;
        }
        public DateTime CreatedAtUtc
        {
            get; init;
        }
    }
}
