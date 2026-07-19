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
    private static void MapAuthoringOperationsRoutes(IEndpointRouteBuilder group)
    {
        group.MapGet("/content/export", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringContentExport service,
            IAdminPrincipalService adminPrincipals,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/articles/{articleId:int}/export", async (
            int articleId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAuthoringContentExport service,
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
                ? AedsJsonResults.NotFound(aeds, "article_not_found")
                : Ok(context, aeds, exported);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/articles/import", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAuthoringContentImport service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ContentImportRequest>(
                context,
                aeds,
                "content_import_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ContentImportRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/audit", async (
            HttpContext context,
            IAedsEncoder aeds,
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
            string? cursor,
            string? piiMode,
            string? purpose,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            IAdminPrincipalService adminPrincipals,
            CancellationToken cancellationToken) =>
        {
            if (string.Equals(NormalizePiiMode(piiMode), "investigation", StringComparison.Ordinal))
            {
                if (!AuditInvestigationAccessPolicy.IsValidPurpose(purpose))
                {
                    return AedsJsonResults.BadRequest(aeds, "AUDIT_INVESTIGATION_PURPOSE_REQUIRED");
                }
                IResult? stepUpFailure = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
                if (stepUpFailure is not null)
                {
                    return stepUpFailure;
                }
            }
            AuditDisclosureMode disclosureMode = ResolveAuditDisclosureMode(context, piiMode);
            AuditLogQueryRequest query = BuildAuditLogQuery(page, pageSize, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc, cursor);
            AuditLogListResponse response = await auditQuery.ListAsync(query, cancellationToken, disclosureMode);
            await RecordAuditQueryAsync(auditEvents, new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查询审计日志列表",
                TargetType: "audit_log",
                Context: BuildAuditQueryContext(query, disclosureMode, piiMode, context, purpose)), disclosureMode, cancellationToken);
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.AuditRead)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/summary", async (
            HttpContext context,
            IAedsEncoder aeds,
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
            AuditLogQueryRequest query = BuildAuditLogQuery(1, 1, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc, null);
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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.AuditRead)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}", async (
            long id,
            HttpContext context,
            IAedsEncoder aeds,
            string? piiMode,
            string? purpose,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            IAdminPrincipalService adminPrincipals,
            CancellationToken cancellationToken) =>
        {
            if (string.Equals(NormalizePiiMode(piiMode), "investigation", StringComparison.Ordinal))
            {
                if (!AuditInvestigationAccessPolicy.IsValidPurpose(purpose))
                {
                    return AedsJsonResults.BadRequest(aeds, "AUDIT_INVESTIGATION_PURPOSE_REQUIRED");
                }
                IResult? stepUpFailure = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
                if (stepUpFailure is not null)
                {
                    return stepUpFailure;
                }
            }
            AuditDisclosureMode disclosureMode = ResolveAuditDisclosureMode(context, piiMode);
            AuditLogDetailResponse? response = await auditQuery.GetAsync(id, cancellationToken, disclosureMode);
            await RecordAuditQueryAsync(auditEvents, new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                response is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                response is null ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员查看审计日志详情",
                TargetType: "audit_log",
                TargetId: id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: BuildAuditDisclosureContext(disclosureMode, piiMode, context, purpose)), disclosureMode, cancellationToken);
            return response is null
                ? AedsJsonResults.NotFound(aeds, "audit_log_not_found")
                : Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.AuditRead)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}/verify", async (
            long id,
            HttpContext context,
            IAedsEncoder aeds,
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
                ? AedsJsonResults.NotFound(aeds, "audit_log_not_found")
                : Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.AuditRead)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/health", async (
            HttpContext context,
            IAedsEncoder aeds,
            [Microsoft.AspNetCore.Mvc.FromServices] IAdminOperationsHealthReader healthReader,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            OpsHealthResponse response = await healthReader.GetAsync(cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.ops.health_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看生产运维健康面板",
                TargetType: "ops_health"), cancellationToken);
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.AuditRead)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/backup", (
            HttpContext context,
            IAedsEncoder aeds,
            [Microsoft.AspNetCore.Mvc.FromServices] IAdminBackupStatusReader backupStatusReader) =>
            Ok(context, aeds, backupStatusReader.GetStatus()))
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/dangerous-operations/policy", (
            HttpContext context,
            IAedsEncoder aeds,
            [Microsoft.AspNetCore.Mvc.FromServices] IAdminDangerousOperationPolicyReader policyReader) =>
            Ok(context, aeds, policyReader.Get()))
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/cache/diagnostics", async (
            HttpContext context,
            IAedsEncoder aeds,
            int? articleId,
            [Microsoft.AspNetCore.Mvc.FromServices] IAdminCacheDiagnosticsReader diagnosticsReader,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            CacheDiagnosticsResponse response = await diagnosticsReader.GetAsync(articleId, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.cache.diagnostics_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看缓存/AOT/search/sitemap 诊断",
                TargetType: "cache_diagnostics",
                TargetId: articleId?.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/cache/actions", async (
            HttpContext context,
            IAedsEncoder aeds,
            [Microsoft.AspNetCore.Mvc.FromServices] IAdminArtifactOperations operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AdminCacheActionRequest>(
                context,
                aeds,
                "admin_cache_action_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AdminCacheActionRequest request = parsed.Value!;
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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity", async (
            HttpContext context,
            IAedsEncoder aeds,
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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity/fix-preview", async (
            HttpContext context,
            IAedsEncoder aeds,
            AdminOperationsService operations,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await operations.PreviewIntegrityFixAsync(cancellationToken)))
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/integrity/fix", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<IntegrityFixRequest>(
                context,
                aeds,
                "integrity_fix_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            IntegrityFixRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/ai-assist", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringAiAssist service,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AiAssistRequest>(
                context,
                aeds,
                "ai_assist_request_invalid",
                cancellationToken);
            return parsed.IsSuccess
                ? Ok(context, aeds, service.GenerateAiAssist(context.GetUserId(), parsed.Value!))
                : parsed.ToErrorResult(aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }
}
