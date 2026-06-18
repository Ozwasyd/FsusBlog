using System.Globalization;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SecurityEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapSecurityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(BinaryBridgeInternalRequest.SecurityPrefix)
            .WithTags("Security")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .AddEndpointFilter<BinaryBridgeInternalOnlyFilter>();

        group.MapGet("/overview", (
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Results.Ok(JsonApiResponse<SecurityOverviewResponse>.Ok(
                policy.BuildSecurityOverview(detector.GetRangeStatus(), crawlerSync.GetStatus())));
        });

        group.MapGet("/anti-crawler/overview", (
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Results.Ok(JsonApiResponse<AntiCrawlerOverviewResponse>.Ok(
                policy.BuildAntiCrawlerOverview(detector.GetRangeStatus(), crawlerSync.GetStatus())));
        });

        group.MapGet("/anti-crawler/options", (IAntiCrawlerPolicyProvider policy) =>
            Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(policy.Current)));

        group.MapPut("/anti-crawler/options", async (
            AntiCrawlerOptionsUpdateRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerPolicySnapshot snapshot = policy.UpdateAntiCrawlerOptions(request, ResolveActor(context));
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.options_updated",
                "管理员更新反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/anti-crawler/options/rollback", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerPolicySnapshot snapshot = policy.RollbackAntiCrawlerOptions(ResolveActor(context));
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.options_rolled_back",
                "管理员回滚反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                "rollback",
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/crawler-ranges/status", (ICrawlerRangeSyncService crawlerSync) =>
            Results.Ok(JsonApiResponse<CrawlerRangesAdminStatus>.Ok(crawlerSync.GetStatus())));

        group.MapPost("/anti-crawler/crawler-ranges/sync", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ICrawlerRangeSyncService crawlerSync,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CrawlerRangeSyncResponse response = await crawlerSync.SynchronizeOnceAsync(cancellationToken);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.crawler_ranges_synced",
                "管理员手动同步搜索引擎 CIDR",
                "crawler_ranges",
                response.Status.Source,
                response.Outcome,
                response,
                cancellationToken);
            return Results.Ok(JsonApiResponse<CrawlerRangeSyncResponse>.Ok(response));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/anti-crawler/risk-events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/risk/events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/risk/snapshots", (int? limit, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<SecurityRiskSnapshotResponse>>.Ok(policy.ListRiskSnapshots(limit ?? 100))));

        group.MapPost("/risk/{dimension}/reset", async (
            string dimension,
            SecurityRiskResetRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityRiskScoreReader riskScoreReader,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            if (!string.Equals(dimension, "ip", StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrWhiteSpace(request.Subject))
            {
                return Results.BadRequest(JsonApiResponse<SecurityRiskResetResponse>.Fail("risk_dimension_invalid"));
            }

            string subject = request.Subject.Trim();
            await riskScoreReader.ResetRiskAsync(new SecurityRiskSubject(subject), cancellationToken);
            var response = new SecurityRiskResetResponse(subject, true, DateTimeOffset.UtcNow);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.risk.reset",
                "管理员重置安全风险分",
                $"security_risk:{dimension}",
                subject,
                request.Reason,
                response,
                cancellationToken);
            return Results.Ok(JsonApiResponse<SecurityRiskResetResponse>.Ok(response));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/rules", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRuleResponse>>.Ok(policy.ListRules())));

        group.MapPost("/anti-crawler/rules", async (
            AntiCrawlerRuleRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse rule = policy.AddRule(request, ResolveActor(context));
            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_created", "管理员新增反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerRuleResponse>.Ok(rule));
        }).RequireRateLimiting("fixed_ip");

        group.MapPut("/anti-crawler/rules/{id}", async (
            string id,
            AntiCrawlerRuleRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse? rule = policy.UpdateRule(id, request, ResolveActor(context));
            if (rule is null)
            {
                return Results.NotFound(JsonApiResponse<AntiCrawlerRuleResponse>.Fail("anti_crawler_rule_not_found"));
            }

            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_updated", "管理员更新反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerRuleResponse>.Ok(rule));
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete("/anti-crawler/rules/{id}", async (
            string id,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteRule(id);
            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_deleted", "管理员删除反爬虫规则", "anti_crawler_rule", id, deleted ? "deleted" : "not_found", new { deleted }, cancellationToken);
            return deleted
                ? Results.Ok(JsonApiResponse<object>.Ok(new { deleted }))
                : Results.NotFound(JsonApiResponse<object>.Fail("anti_crawler_rule_not_found"));
        }).RequireRateLimiting("fixed_ip");

        MapListEndpoints(group, "allowlist", "allow");
        MapListEndpoints(group, "blocklist", "block");

        group.MapPost("/anti-crawler/simulate", (
            AntiCrawlerSimulationRequest request,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<AntiCrawlerSimulationResult>.Ok(policy.Simulate(request)));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/overview", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<PowOverviewResponse>.Ok(policy.BuildPowOverview())));

        group.MapGet("/pow/options", (IPowPolicyProvider policy) =>
            Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(policy.CurrentPow)));

        group.MapPut("/pow/options", async (
            PowOptionsUpdateRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            PowPolicySnapshot snapshot = policy.UpdatePowOptions(request, ResolveActor(context));
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.pow.options_updated",
                "管理员更新 PoW 运行策略",
                "pow_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/pow/options/rollback", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            PowPolicySnapshot snapshot = policy.RollbackPowOptions(ResolveActor(context));
            await RecordSecurityAuditAsync(auditEvents, "admin.security.pow.options_rolled_back", "管理员回滚 PoW 运行策略", "pow_options", snapshot.SnapshotId, "rollback", snapshot, cancellationToken);
            return Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/events", (int? limit, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(SecurityRiskSources.Pow, null, limit ?? 100))));

        group.MapPost("/pow/simulate", (AntiCrawlerSimulationRequest request, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<AntiCrawlerSimulationResult>.Ok(policy.Simulate(request))))
            .RequireRateLimiting("fixed_ip");

        return app;
    }

    private static void MapListEndpoints(RouteGroupBuilder group, string routeName, string listType)
    {
        group.MapGet($"/anti-crawler/{routeName}", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerListEntryResponse>>.Ok(policy.ListEntries(listType))));

        group.MapPost($"/anti-crawler/{routeName}", async (
            AntiCrawlerListEntryRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerListEntryResponse entry = policy.AddEntry(listType, request, ResolveActor(context));
            await RecordSecurityAuditAsync(auditEvents, $"admin.security.anti_crawler.{listType}list_created", $"管理员新增反爬虫{listType}list", $"anti_crawler_{listType}list", entry.Id, request.Reason, entry, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerListEntryResponse>.Ok(entry));
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete($"/anti-crawler/{routeName}/{{id}}", async (
            string id,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteEntry(listType, id);
            await RecordSecurityAuditAsync(auditEvents, $"admin.security.anti_crawler.{listType}list_deleted", $"管理员删除反爬虫{listType}list", $"anti_crawler_{listType}list", id, deleted ? "deleted" : "not_found", new { deleted }, cancellationToken);
            return deleted
                ? Results.Ok(JsonApiResponse<object>.Ok(new { deleted }))
                : Results.NotFound(JsonApiResponse<object>.Fail("anti_crawler_list_entry_not_found"));
        }).RequireRateLimiting("fixed_ip");
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(HttpContext context, IAdminPrincipalService adminPrincipals)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
            string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return Results.Unauthorized();
        }

        string adminSessionId = context.User.GetAdminSessionId()!;
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
            return Results.Json(JsonApiResponse<object>.Fail("MFA_PROOF_REQUIRED"), statusCode: StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

    private static Task RecordSecurityAuditAsync(
        IAuditEventService auditEvents,
        string action,
        string eventInfo,
        string targetType,
        string targetId,
        string? reasonCode,
        object payload,
        CancellationToken cancellationToken)
        => auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Warning,
            eventInfo,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: reasonCode,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["payload"] = payload
            }), cancellationToken);

    private static string ResolveActor(HttpContext context)
        => context.GetUserId().ToString(CultureInfo.InvariantCulture);
}
